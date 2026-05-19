import mysql from "mysql2/promise";
import type { ColumnInfo, QueryResult, QueryResultColumn } from "@data-view/core";
import { quoteIdent as qiCore } from "@data-view/core";
import type {
  DriverAdapter,
  IterateTableOptions,
  ResolvedConnection,
  TableBatch,
} from "./types";

const QUERY_LIMIT = 5000;

async function withConn<T>(c: ResolvedConnection, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database,
    ssl: c.ssl ? {} : undefined,
    connectTimeout: 10_000,
    rowsAsArray: true,
    dateStrings: true,
    multipleStatements: false,
  });
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
                NOW() AS server_time,
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
      const [rows] = (await conn.query(
        `SELECT column_name, column_type, is_nullable, column_key, column_default
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
        const [indexName, nonUnique, columnName] = r as [string, number | string, string, number];
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
        entry.columns.push(columnName);
      }
      return {
        schema,
        name,
        kind: "table" as const,
        columns: rows.map((r) => {
          const [colName, colType, nullable, key, def] = r as [string, string, string, string, string | null];
          return {
            name: colName,
            dataType: colType,
            nullable: nullable === "YES",
            isPrimaryKey: key === "PRI",
            isUnique: key === "UNI",
            default: def,
          };
        }),
        indexes: Array.from(indexMap.values()).sort((a, b) => {
          if (a.primary !== b.primary) return a.primary ? -1 : 1;
          if (a.unique !== b.unique) return a.unique ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
        foreignKeys: [],
      };
    });
  },

  async runQuery(c, sql, options) {
    const start = Date.now();
    return withConn(c, async (conn) => {
      if (options?.schema) {
        await conn.query(`USE ${"`" + options.schema.replace(/`/g, "``") + "`"}`);
      }
      const [rows, fields] = (await conn.query({
        sql,
        values: options?.params,
      })) as [unknown, mysql.FieldPacket[] | undefined];

      // For SELECT-style queries `rows` is an array of arrays (rowsAsArray=true).
      // For DML it's an OkPacket-like object.
      if (Array.isArray(rows) && fields) {
        const columns: QueryResultColumn[] = fields.map((f) => ({
          name: f.name,
          dataType: typeName(f.type ?? -1),
        }));
        const cleaned = (rows as Array<unknown[]>).map((row) => row.map(normalizeCell));
        return {
          columns,
          rows: cleaned as QueryResult["rows"],
          rowCount: cleaned.length,
          affectedRows: null,
          durationMs: Date.now() - start,
          truncated: cleaned.length === QUERY_LIMIT,
        };
      }
      const okPacket = rows as { affectedRows?: number };
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: okPacket.affectedRows ?? 0,
        durationMs: Date.now() - start,
        truncated: false,
      };
    });
  },

  async fetchTableData(c, schema, name, options) {
    const limit = Math.min(options?.limit ?? 100, QUERY_LIMIT);
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy?.length
      ? `ORDER BY ${options.orderBy
          .map((o) => `${ident(o.column)} ${o.direction.toUpperCase()}`)
          .join(", ")}`
      : "";
    const where = options?.where?.trim() ? `WHERE ${options.where.trim()}` : "";
    const sql = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ${orderBy} LIMIT ? OFFSET ?`;
    return this.runQuery(c, sql, { params: [limit, offset] });
  },

  async *iterateTable(c, opts) {
    // mysql2 supports server-side streaming via .stream(), which holds the
    // connection open and emits a row event per record. We collect into
    // fixed-size batches before yielding to keep downstream JSON encoding
    // efficient.
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const where = opts.where?.trim() ? `WHERE ${opts.where.trim()}` : "";
    const sql = `SELECT * FROM ${ident(opts.schema)}.${ident(opts.name)} ${where}`;
    const conn = await mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: c.database,
      ssl: c.ssl ? {} : undefined,
      connectTimeout: 10_000,
      rowsAsArray: true,
      dateStrings: true,
      multipleStatements: false,
    });
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
      let fields: mysql.FieldPacket[] | null = null;
      // Capture column metadata via the 'fields' event.
      (stream as NodeJS.EventEmitter).on("fields", (f: mysql.FieldPacket[]) => {
        fields = f;
        columns = f.map((field) => ({
          name: field.name,
          dataType: typeName(field.type ?? -1),
        }));
      });
      for await (const row of stream as AsyncIterable<unknown>) {
        if (columns.length === 0 && fields) {
          columns = (fields as mysql.FieldPacket[]).map((field) => ({
            name: field.name,
            dataType: typeName(field.type ?? -1),
          }));
        }
        batchRows.push((row as unknown[]).map(normalizeCell));
        if (batchRows.length >= batchSize) {
          yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
          batchRows = [];
        }
      }
      if (batchRows.length > 0) {
        yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
      }
    } finally {
      await conn.end().catch(() => undefined);
    }
  },

  generateCreateTableSql(_c, schema, name, columns) {
    return buildMysqlCreateTable(schema, name, columns);
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
function typeName(code: number) {
  return TYPES[code] ?? `type:${code}`;
}
