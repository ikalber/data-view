import mysql from "mysql2/promise";
import type {
  ColumnInfo,
  CreateIndexOptions,
  CreateSchemaOptions,
  CreateTableColumn,
  CreateTableForeignKey,
  CreateTableIndex,
  CreateTableOptions,
  DropIndexOptions,
  QueryResult,
  QueryResultColumn,
} from "@data-view/core";
import {
  autoIndexName,
  quoteIdent as qiCore,
  renderForeignKeyClause,
} from "@data-view/core";
import type {
  DriverAdapter,
  IterateTableOptions,
  ResolvedConnection,
  TableBatch,
} from "./types";

const QUERY_LIMIT = 5000;

/** BIT(n) columns arrive as Buffers (rendered as "<binary>" and exported as
 * NULL). Decode them to their integer value instead. */
const castBit: mysql.TypeCast = (field, next) => {
  if (field.type === "BIT") {
    const buf = field.buffer();
    if (buf == null) return null;
    let n = 0n;
    for (const byte of buf) n = (n << 8n) | BigInt(byte);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
  }
  return next();
};

function connectionOptions(
  c: ResolvedConnection,
  multipleStatements = false,
): mysql.ConnectionOptions {
  return {
    host: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database || undefined,
    // Same trust model as the Postgres adapter (rejectUnauthorized: false):
    // the UI only has an SSL on/off switch, and with mysql2's default
    // verification any self-signed server (the MySQL default) failed.
    ssl: c.ssl
      ? { rejectUnauthorized: c.options?.rejectUnauthorized === "true" }
      : undefined,
    connectTimeout: 10_000,
    rowsAsArray: true,
    dateStrings: true,
    // BIGINT values beyond 2^53 come back as strings instead of being
    // silently rounded (9223372036854775807 → 9223372036854776000).
    supportBigNumbers: true,
    typeCast: castBit,
    multipleStatements,
  };
}

async function withConn<T>(
  c: ResolvedConnection,
  fn: (conn: mysql.Connection) => Promise<T>,
  multipleStatements = false,
): Promise<T> {
  const conn = await mysql.createConnection(connectionOptions(c, multipleStatements));
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

function ident(name: string) {
  return "`" + name.replace(/`/g, "``") + "`";
}

function normalizeCell(v: unknown) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __binary: true as const, bytes: v.length };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

type MysqlStatementResult =
  | { rows: unknown[][]; fields: mysql.FieldPacket[] }
  | { header: { affectedRows?: number } };

/** Split what mysql2 returns into one entry per statement. A single SELECT
 * gives `(rows[], FieldPacket[])`, a single DML a ResultSetHeader, and a
 * multi-statement script / CALL an array mixing both. */
function splitResults(rows: unknown, fields: unknown): MysqlStatementResult[] {
  if (!Array.isArray(rows)) return [{ header: rows as { affectedRows?: number } }];
  const fieldList = Array.isArray(fields) ? (fields as unknown[]) : [];
  const isSingleSelect =
    fieldList.length > 0 && fieldList.every((f) => f != null && !Array.isArray(f));
  if (isSingleSelect) {
    return [{ rows: rows as unknown[][], fields: fields as mysql.FieldPacket[] }];
  }
  return rows.map((r, i) =>
    Array.isArray(r)
      ? { rows: r as unknown[][], fields: (fieldList[i] as mysql.FieldPacket[]) ?? [] }
      : { header: r as { affectedRows?: number } },
  );
}

function shapeMysqlResult(
  rows: unknown,
  fields: unknown,
  durationMs: number,
  maxRows: number,
): QueryResult {
  const results = splitResults(rows, fields);
  // Show the last row set (like most SQL clients); otherwise report the
  // rows touched by all the DML statements.
  const sets = results.filter(
    (r): r is { rows: unknown[][]; fields: mysql.FieldPacket[] } => "rows" in r,
  );
  const last = sets[sets.length - 1];
  if (last) {
    const truncated = last.rows.length > maxRows;
    const cleaned = (truncated ? last.rows.slice(0, maxRows) : last.rows).map((row) =>
      row.map(normalizeCell),
    );
    return {
      columns: last.fields.map((f) => ({ name: f.name, dataType: fieldTypeName(f) })),
      rows: cleaned as QueryResult["rows"],
      rowCount: cleaned.length,
      affectedRows: null,
      durationMs,
      truncated,
    };
  }
  const affected = results.reduce(
    (sum, r) => sum + ("header" in r ? r.header.affectedRows ?? 0 : 0),
    0,
  );
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: affected,
    durationMs,
    truncated: false,
  };
}

async function runMysql(
  c: ResolvedConnection,
  sql: string,
  opts: { schema?: string; params?: unknown[]; maxRows: number; multipleStatements: boolean },
): Promise<QueryResult> {
  return withConn(
    c,
    async (conn) => {
      if (opts.schema) await conn.query(`USE ${ident(opts.schema)}`);
      const start = Date.now();
      const [rows, fields] = (await conn.query({ sql, values: opts.params })) as [
        unknown,
        unknown,
      ];
      return shapeMysqlResult(rows, fields, Date.now() - start, opts.maxRows);
    },
    opts.multipleStatements,
  );
}

export const mysqlDriver: DriverAdapter = {
  async testConnection(c) {
    const start = Date.now();
    try {
      await withConn(c, async (conn) => conn.query("SELECT 1"));
      return { ok: true, message: "Conexión exitosa", latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async listSchemas(c) {
    return withConn(c, async (conn) => {
      const [rows] = (await conn.query("SHOW DATABASES")) as [Array<unknown>, unknown];
      const SYS = new Set(["information_schema", "mysql", "performance_schema", "sys"]);
      return (rows as Array<unknown[]>).map((r) => {
        const name = String(r[0]);
        return { name, isSystem: SYS.has(name) };
      });
    });
  },

  async listRelations(c, schema) {
    return withConn(c, async (conn) => {
      const useSchema = schema ?? c.database;
      // table_rows / data_length / index_length are statistics InnoDB caches
      // and only refreshes after ANALYZE TABLE — close enough for an
      // overview, never authoritative for billing.
      const [rows] = (await conn.query(
        `SELECT table_schema, table_name, table_type,
                table_rows, data_length, index_length
         FROM information_schema.tables
         WHERE table_schema = ?
         ORDER BY table_name`,
        [useSchema],
      )) as [Array<unknown[]>, unknown];
      return rows.map((row) => {
        const [s, n, t, rowsApprox, dataLen, idxLen] = row as [
          string,
          string,
          string,
          number | string | null,
          number | string | null,
          number | string | null,
        ];
        const data = dataLen != null ? Number(dataLen) : undefined;
        const idx = idxLen != null ? Number(idxLen) : undefined;
        const total =
          data != null || idx != null ? (data ?? 0) + (idx ?? 0) : undefined;
        return {
          schema: s,
          name: n,
          kind: t === "VIEW" ? ("view" as const) : ("table" as const),
          approxRowCount: rowsApprox != null ? Number(rowsApprox) : undefined,
          totalBytes: total,
          dataBytes: data,
          indexBytes: idx,
        };
      });
    });
  },

  async getConnectionOverview(c) {
    return withConn(c, async (conn) => {
      const SYS = new Set(["information_schema", "mysql", "performance_schema", "sys"]);
      // CURRENT_USER and UPTIME are reserved/non-existent as system variables in
      // MySQL 8 — alias with backticks and read Uptime from STATUS instead of
      // `@@global.uptime` (which doesn't exist as a system variable).
      const [[meta]] = (await conn.query(
        `SELECT VERSION() AS version,
                DATABASE() AS current_database,
                CURRENT_USER() AS \`current_user\`,
                DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ') AS server_time,
                @@max_connections AS max_connections`,
      )) as [Array<unknown[]>, unknown];
      const [version, currentDb, currentUser, serverTime, maxConn] =
        (meta as unknown[]) ?? [];

      // Uptime lives in SHOW GLOBAL STATUS. Wrap so a privilege error doesn't
      // sink the whole overview.
      let uptime: number | undefined;
      try {
        const [statusRows] = (await conn.query(
          `SHOW GLOBAL STATUS LIKE 'Uptime'`,
        )) as [Array<unknown[]>, unknown];
        const row = statusRows[0] as unknown[] | undefined;
        const v = row?.[1];
        if (v != null) uptime = Number(v);
      } catch {
        /* user lacks PROCESS or similar — fine, leave uptime undefined. */
      }

      // information_schema.schemata gives the list, then aggregate sizes from
      // information_schema.tables in one round-trip.
      const [dbRows] = (await conn.query(
        `SELECT s.schema_name AS name,
                COALESCE(SUM(t.data_length + t.index_length), 0) AS size_bytes,
                COUNT(t.table_name) AS relation_count,
                s.default_character_set_name AS charset
         FROM information_schema.schemata s
         LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
         GROUP BY s.schema_name, s.default_character_set_name
         ORDER BY s.schema_name`,
      )) as [Array<unknown[]>, unknown];

      let active: unknown;
      try {
        const [activeRows] = (await conn.query(
          `SELECT COUNT(*) AS active FROM information_schema.processlist`,
        )) as [Array<unknown[]>, unknown];
        active = (activeRows[0] as unknown[] | undefined)?.[0];
      } catch {
        /* requires PROCESS privilege — leave undefined. */
      }

      const databases = dbRows.map((row) => {
        const [name, sizeBytes, relCount, charset] = row as [
          string,
          number | string | null,
          number | string | null,
          string | null,
        ];
        const size = sizeBytes != null ? Number(sizeBytes) : undefined;
        return {
          name,
          isSystem: SYS.has(name),
          sizeBytes: size && size > 0 ? size : undefined,
          relationCount: relCount != null ? Number(relCount) : undefined,
          details: charset ?? undefined,
        };
      });
      const totalSizeBytes = databases.reduce(
        (sum, d) => sum + (d.sizeBytes ?? 0),
        0,
      );

      return {
        driver: "mysql" as const,
        serverVersion: version != null ? `MySQL ${String(version)}` : undefined,
        currentDatabase: currentDb != null ? String(currentDb) : undefined,
        currentUser: currentUser != null ? String(currentUser) : undefined,
        serverTime:
          serverTime instanceof Date
            ? serverTime.toISOString()
            : serverTime != null
            ? String(serverTime)
            : undefined,
        uptimeSeconds: uptime != null ? Number(uptime) : undefined,
        activeConnections: active != null ? Number(active) : undefined,
        maxConnections: maxConn != null ? Number(maxConn) : undefined,
        totalSizeBytes: totalSizeBytes > 0 ? totalSizeBytes : undefined,
        databases,
      };
    });
  },

  async describeTable(c, schema, name) {
    return withConn(c, async (conn) => {
      const [[meta]] = (await conn.query(
        `SELECT VERSION(),
                (SELECT table_type FROM information_schema.tables
                 WHERE table_schema = ? AND table_name = ?)`,
        [schema, name],
      )) as [Array<unknown[]>, unknown];
      const [version, tableType] = (meta ?? []) as [string | null, string | null];
      const isMariaDb = /mariadb/i.test(String(version ?? ""));
      const [rows] = (await conn.query(
        `SELECT column_name, column_type, is_nullable, column_default, extra, column_comment
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [schema, name],
      )) as [Array<unknown[]>, unknown];
      const [idxRows] = (await conn.query(
        `SELECT index_name, non_unique, column_name, seq_in_index
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [schema, name],
      )) as [Array<unknown[]>, unknown];
      const indexMap = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
      for (const r of idxRows) {
        const [indexName, nonUnique, columnName] = r as [string, number | string, string | null, number];
        const key = indexName;
        let entry = indexMap.get(key);
        if (!entry) {
          entry = {
            name: indexName,
            columns: [],
            unique: Number(nonUnique) === 0,
            primary: indexName === "PRIMARY",
          };
          indexMap.set(key, entry);
        }
        // column_name is NULL for functional key parts (MySQL 8.0.13+).
        entry.columns.push(columnName ?? "(expression)");
      }
      // PK / unique flags come from the real indexes: column_key reports
      // `PRI` for a NOT NULL UNIQUE column when the table has no primary key.
      const pkCols = new Set(indexMap.get("PRIMARY")?.columns ?? []);
      const uniqueCols = new Set(
        Array.from(indexMap.values())
          .filter((i) => i.unique && !i.primary && i.columns.length === 1)
          .map((i) => i.columns[0]!),
      );
      // Foreign keys: aggregate columns per constraint with GROUP_CONCAT and
      // split client-side (unit separator, so names with commas survive).
      // update_rule / delete_rule already come as text.
      const [fkRows] = (await conn.query(
        `SELECT
           rc.constraint_name AS name,
           GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position SEPARATOR '${FK_SEP}') AS local_cols,
           rc.unique_constraint_schema AS ref_schema,
           rc.referenced_table_name AS ref_table,
           GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position SEPARATOR '${FK_SEP}') AS ref_cols,
           rc.update_rule AS on_update,
           rc.delete_rule AS on_delete
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_schema = rc.constraint_schema
          AND kcu.constraint_name = rc.constraint_name
          AND kcu.table_name = rc.table_name
          AND kcu.referenced_table_name IS NOT NULL
         WHERE kcu.table_schema = ? AND kcu.table_name = ?
         GROUP BY rc.constraint_name, rc.unique_constraint_schema,
                  rc.referenced_table_name, rc.update_rule, rc.delete_rule
         ORDER BY rc.constraint_name`,
        [schema, name],
      )) as [Array<unknown[]>, unknown];
      const foreignKeys = fkRows.map((row) => {
        const [fkName, localCols, refSchema, refTable, refCols, onUpdate, onDelete] = row as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        return {
          name: fkName,
          columns: localCols.split(FK_SEP),
          referencedSchema: refSchema,
          referencedTable: refTable,
          referencedColumns: refCols.split(FK_SEP),
          onUpdate: onUpdate || undefined,
          onDelete: onDelete || undefined,
        };
      });
      return {
        schema,
        name,
        kind: tableType === "VIEW" || tableType === "SYSTEM VIEW" ? ("view" as const) : ("table" as const),
        columns: rows.map((r) => {
          const [colName, colType, nullable, def, extra, comment] = r as [
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
          ];
          return {
            name: colName,
            dataType: mysqlColumnType(colType, extra ?? ""),
            nullable: nullable === "YES",
            isPrimaryKey: pkCols.has(colName),
            isUnique: uniqueCols.has(colName),
            default: mysqlDefaultExpr(def, colType, extra ?? "", isMariaDb),
            comment: comment || null,
          };
        }),
        indexes: Array.from(indexMap.values()).sort((a, b) => {
          if (a.primary !== b.primary) return a.primary ? -1 : 1;
          if (a.unique !== b.unique) return a.unique ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
        foreignKeys,
      };
    });
  },

  async runQuery(c, sql, options) {
    // The SQL editor sends whole scripts, so allow several statements here
    // (fetchTableData/iterateTable keep them disabled for the raw WHERE).
    return runMysql(c, sql, {
      schema: options?.schema,
      params: options?.params,
      maxRows: QUERY_LIMIT,
      multipleStatements: true,
    });
  },

  async fetchTableData(c, schema, name, options) {
    const limit = Math.max(0, Math.min(options?.limit ?? 100, QUERY_LIMIT));
    const offset = Math.max(0, options?.offset ?? 0);
    const orderBy = options?.orderBy?.length
      ? `ORDER BY ${options.orderBy
          .map((o) => `${ident(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`)
          .join(", ")}`
      : "";
    const where = options?.where?.trim() ? `WHERE ${options.where.trim()}` : "";
    // One extra row tells `truncated` whether another page exists.
    const sql = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ${orderBy} LIMIT ? OFFSET ?`;
    return runMysql(c, sql, {
      params: [limit + 1, offset],
      maxRows: limit,
      multipleStatements: false,
    });
  },

  async *iterateTable(c, opts) {
    // mysql2 supports server-side streaming via .stream(), which holds the
    // connection open and emits a row event per record. We collect into
    // fixed-size batches before yielding to keep downstream JSON encoding
    // efficient.
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const where = opts.where?.trim() ? `WHERE ${opts.where.trim()}` : "";
    const sql = `SELECT * FROM ${ident(opts.schema)}.${ident(opts.name)} ${where}`;
    const conn = await mysql.createConnection(connectionOptions(c));
    try {
      // The promise wrapper hides the streaming API; reach through to the
      // underlying connection where .query() returns a Query object with
      // .stream().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = (conn as unknown as { connection: unknown }).connection;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream: NodeJS.ReadableStream = raw.query(sql).stream({
        highWaterMark: batchSize,
      });
      let batchRows: unknown[][] = [];
      let columns: QueryResultColumn[] = [];
      let yielded = false;
      // Capture column metadata via the 'fields' event (emitted before rows).
      (stream as NodeJS.EventEmitter).on("fields", (f: mysql.FieldPacket[]) => {
        columns = f.map((field) => ({ name: field.name, dataType: fieldTypeName(field) }));
      });
      for await (const row of stream as AsyncIterable<unknown>) {
        batchRows.push((row as unknown[]).map(normalizeCell));
        if (batchRows.length >= batchSize) {
          yielded = true;
          yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
          batchRows = [];
        }
      }
      // An empty table still yields one (empty) batch so exporters get the
      // column list for headers.
      if (batchRows.length > 0 || !yielded) {
        yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
      }
    } finally {
      await conn.end().catch(() => undefined);
    }
  },

  generateCreateTableSql(_c, schema, name, columns) {
    return buildMysqlCreateTable(schema, name, columns);
  },

  async createSchema(c, options) {
    const name = options.name.trim();
    if (!name) throw new Error("El nombre no puede estar vacío");
    const parts = [`CREATE DATABASE ${ident(name)}`];
    if (options.charset) parts.push(`CHARACTER SET ${quoteStringMysql(options.charset)}`);
    if (options.collation) parts.push(`COLLATE ${quoteStringMysql(options.collation)}`);
    await this.runQuery(c, parts.join(" "));
  },

  async createTable(c, options) {
    // Indexes go inline in the CREATE TABLE: MySQL DDL auto-commits, so a
    // separate failing CREATE INDEX would leave a half-created table behind.
    const sqlText = buildMysqlCreateTableFromDraft(
      options.schema,
      options.name,
      options.columns,
      options.foreignKeys,
      options.indexes,
    );
    await this.runQuery(c, sqlText);
  },

  async createIndex(c, options) {
    await this.runQuery(c, buildMysqlCreateIndexSql(options));
  },

  async dropIndex(c, options) {
    // MySQL indexes are scoped to their table — need ALTER TABLE … DROP INDEX.
    if (!options.table) {
      throw new Error("MySQL: dropIndex requiere `table`");
    }
    await this.runQuery(
      c,
      `ALTER TABLE ${ident(options.schema)}.${ident(
        options.table,
      )} DROP INDEX ${ident(options.name)}`,
    );
  },

  async dropTable(c, schema, name) {
    // MySQL doesn't accept CASCADE on DROP TABLE — the keyword is parsed but
    // has no effect. We omit it to keep the statement portable.
    await this.runQuery(
      c,
      `DROP TABLE IF EXISTS ${ident(schema)}.${ident(name)}`,
    );
  },

  async dropSchema(c, name) {
    await this.runQuery(c, `DROP DATABASE IF EXISTS ${ident(name)}`);
  },

  async truncateTable(c, schema, name) {
    await this.runQuery(
      c,
      `TRUNCATE TABLE ${ident(schema)}.${ident(name)}`,
    );
  },
};

function buildMysqlCreateTable(
  schema: string,
  name: string,
  columns: ColumnInfo[],
): string {
  const colLines = columns.map((c) => {
    const parts = [qiCore("mysql", c.name), c.dataType];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default != null) parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => qiCore("mysql", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  return `CREATE TABLE ${qiCore("mysql", schema)}.${qiCore("mysql", name)} (\n${colLines.join(
    ",\n",
  )}\n);`;
}

function buildMysqlCreateTableFromDraft(
  schema: string,
  name: string,
  columns: CreateTableColumn[],
  foreignKeys: CreateTableForeignKey[] | undefined,
  indexes?: CreateTableIndex[],
): string {
  if (!schema.trim()) throw new Error("Database requerida");
  if (!name.trim()) throw new Error("Nombre de tabla requerido");
  if (columns.length === 0) throw new Error("Agregá al menos una columna");
  const colLines = columns.map((c) => {
    if (!c.name.trim()) throw new Error("Hay una columna sin nombre");
    if (!c.dataType.trim()) throw new Error(`Falta el tipo de "${c.name}"`);
    const parts = [qiCore("mysql", c.name), c.dataType];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns
    .filter((c) => c.primaryKey)
    .map((c) => qiCore("mysql", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  for (const idx of indexes ?? []) {
    if (idx.columns.length === 0) throw new Error("Agregá al menos una columna al índice");
    const idxName = (idx.name ?? autoIndexName(name, idx.columns)).trim();
    const cols = idx.columns.map((col) => qiCore("mysql", col)).join(", ");
    colLines.push(`  ${idx.unique ? "UNIQUE " : ""}INDEX ${qiCore("mysql", idxName)} (${cols})`);
  }
  for (const fk of foreignKeys ?? []) {
    colLines.push("  " + renderForeignKeyClause("mysql", fk));
  }
  return `CREATE TABLE ${qiCore("mysql", schema)}.${qiCore("mysql", name)} (\n${colLines.join(
    ",\n",
  )}\n);`;
}

function buildMysqlCreateIndexSql(options: CreateIndexOptions): string {
  if (!options.table.trim()) throw new Error("table requerido");
  if (options.columns.length === 0)
    throw new Error("Agregá al menos una columna al índice");
  const unique = options.unique ? "UNIQUE " : "";
  const idxName = (options.name ?? autoIndexName(options.table, options.columns)).trim();
  const fqTable = `${qiCore("mysql", options.schema)}.${qiCore(
    "mysql",
    options.table,
  )}`;
  const cols = options.columns.map((c) => qiCore("mysql", c)).join(", ");
  return `CREATE ${unique}INDEX ${qiCore(
    "mysql",
    idxName,
  )} ON ${fqTable} (${cols});`;
}

const FK_SEP = "\u001f";

/** column_type plus the attributes from EXTRA that are part of the column
 * definition (AUTO_INCREMENT, ON UPDATE …). Without them a generated
 * CREATE TABLE — or the structure editor's `CHANGE COLUMN` — silently drops
 * them. */
function mysqlColumnType(columnType: string, extra: string): string {
  const parts = [columnType];
  if (/\bauto_increment\b/i.test(extra)) parts.push("auto_increment");
  const onUpdate = /\bon update (\S+)/i.exec(extra);
  if (onUpdate) parts.push(`on update ${onUpdate[1]}`);
  return parts.join(" ");
}

const NUMERIC_COLUMN = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/i;

/**
 * information_schema.columns.column_default holds the *unquoted* literal on
 * MySQL (`active` for DEFAULT 'active'), which isn't valid SQL to paste after
 * `DEFAULT`. Turn it into an SQL expression, the same shape Postgres / SQL
 * Server report. MariaDB (10.2.7+) already returns expressions.
 */
function mysqlDefaultExpr(
  def: string | null,
  columnType: string,
  extra: string,
  isMariaDb: boolean,
): string | null {
  if (def == null) return null;
  if (isMariaDb) return def === "NULL" ? null : def;
  if (/\bDEFAULT_GENERATED\b/i.test(extra)) {
    // CURRENT_TIMESTAMP[(n)] is allowed bare; other expressions need parens.
    // MySQL escapes quotes inside the stored expression as \'.
    if (/^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i.test(def)) return def;
    return `(${def.replace(/\\'/g, "'")})`;
  }
  if (NUMERIC_COLUMN.test(columnType) && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(def)) return def;
  if (/^bit\b/i.test(columnType) && /^b'[01]*'$/.test(def)) return def;
  return quoteStringMysql(def);
}

function quoteStringMysql(s: string): string {
  // Default sql_mode treats backslash as an escape char inside '…', so it has
  // to be doubled too (before the quotes) or `abc\` breaks the literal.
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

export type { IterateTableOptions };

// MySQL field type codes -> friendly names. See mysql2 Types.
const TYPES: Record<number, string> = {
  1: "tinyint",
  2: "smallint",
  3: "int",
  4: "float",
  5: "double",
  6: "null",
  7: "timestamp",
  8: "bigint",
  9: "mediumint",
  10: "date",
  11: "time",
  12: "datetime",
  13: "year",
  15: "varchar",
  16: "bit",
  245: "json",
  246: "decimal",
  252: "blob",
  253: "varchar",
  254: "char",
};
/** Character set 63 is `binary`: tells BLOB from TEXT and VARBINARY from
 * VARCHAR, which share the same wire type codes. */
const BINARY_CHARSET = 63;

function fieldTypeName(f: mysql.FieldPacket): string {
  const code = f.columnType ?? f.type ?? -1;
  const binary = f.characterSet === BINARY_CHARSET;
  if (code === 252) return binary ? "blob" : "text";
  if (code === 253 || code === 15) return binary ? "varbinary" : "varchar";
  if (code === 254) return binary ? "binary" : "char";
  return TYPES[code] ?? `type:${code}`;
}
