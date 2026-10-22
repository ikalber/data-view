import { Client, types as pgTypes, type ClientConfig, type CustomTypesConfig } from "pg";
import type {
  ColumnInfo,
  CreateIndexOptions,
  CreateSchemaOptions,
  CreateTableColumn,
  CreateTableForeignKey,
  CreateTableOptions,
  DropIndexOptions,
  QueryResult,
  QueryResultColumn,
  TableDetails,
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

// Date/time types are kept as the server's text. pg's default parsers turn
// `date` / `timestamp` (no tz) into JS Dates in the *Node process* timezone,
// which shifted values (e.g. DATE '2024-01-15' → "2024-01-15T03:00:00Z" on a
// UTC-3 host) and dropped microseconds; intervals came back as objects.
const RAW_TEXT_OIDS = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
]);
const RAW_TEXT_ARRAY_OIDS = new Set([1182, 1183, 1115, 1185, 1187, 1270]);
const TEXT_ARRAY_OID = 1009;

// pg-types' TypeId enum doesn't list every OID; plain numbers work at runtime.
const defaultTypeParser = pgTypes.getTypeParser as (oid: number, format?: "text" | "binary") => unknown;

const pgTypeOverrides: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format !== "binary") {
      if (RAW_TEXT_OIDS.has(oid)) return (v: string) => v;
      if (RAW_TEXT_ARRAY_OIDS.has(oid)) return defaultTypeParser(TEXT_ARRAY_OID, "text");
    }
    return defaultTypeParser(oid, format);
  }) as CustomTypesConfig["getTypeParser"],
};

function clientConfig(c: ResolvedConnection): ClientConfig {
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.username,
    password: c.password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 60_000,
    application_name: "data-view",
    types: pgTypeOverrides,
  };
}

/** Append the DETAIL / HINT / LINE info pg attaches to errors — the bare
 * message ("duplicate key value violates unique constraint …") loses which
 * key collided or where a syntax error is. Mutates and returns the error so
 * `code` & co. survive. */
function enrichPgError(e: unknown, sqlText?: string): unknown {
  if (!(e instanceof Error)) return e;
  const pe = e as Error & { detail?: string; hint?: string; position?: string };
  const extra: string[] = [];
  if (pe.detail) extra.push(`DETAIL: ${pe.detail}`);
  if (pe.hint) extra.push(`HINT: ${pe.hint}`);
  const pos = pe.position ? Number(pe.position) : NaN;
  if (sqlText && Number.isFinite(pos) && pos > 0 && sqlText.includes("\n")) {
    const before = sqlText.slice(0, pos - 1);
    const line = before.split("\n").length;
    extra.push(`LINE ${line}: ${sqlText.split("\n")[line - 1]?.trim() ?? ""}`);
  }
  if (extra.length > 0) pe.message = `${pe.message}\n${extra.join("\n")}`;
  return pe;
}

async function withClient<T>(c: ResolvedConnection, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(clientConfig(c));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

type PgArrayResult = import("pg").QueryArrayResult;

const DML_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"]);

function shapeResult(
  raw: PgArrayResult | PgArrayResult[],
  durationMs: number,
  maxRows = QUERY_LIMIT,
): QueryResult {
  // A multi-statement script (simple protocol) yields one result per
  // statement. Show the last row-returning one, like most SQL clients, and
  // add up the rows touched by the DML statements.
  const all = Array.isArray(raw) ? raw : [raw];
  const withRows = all.filter((r) => (r.fields ?? []).length > 0);
  const res = withRows[withRows.length - 1] ?? all[all.length - 1];
  const columns: QueryResultColumn[] = (res?.fields ?? []).map((f) => ({
    name: f.name,
    dataType: pgOidToName(f.dataTypeID),
  }));
  const allRows = (res?.rows ?? []) as unknown[][];
  const truncated = allRows.length > maxRows;
  const rows = (truncated ? allRows.slice(0, maxRows) : allRows).map((row) =>
    row.map((cell) => normalizeCell(cell)),
  );
  // pg's rowCount is also the row count of a SELECT; only DML counts as
  // "affected", and only when the shown result isn't a row set.
  let affectedRows: number | null = null;
  if (columns.length === 0) {
    for (const r of all) {
      if (DML_COMMANDS.has(r.command) && typeof r.rowCount === "number") {
        affectedRows = (affectedRows ?? 0) + r.rowCount;
      }
    }
  }
  return {
    columns,
    rows: rows as QueryResult["rows"],
    rowCount: rows.length,
    affectedRows,
    durationMs,
    truncated,
  };
}

function normalizeCell(v: unknown) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return { __binary: true as const, bytes: v.length };
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

// Minimal OID -> name map; pg returns numeric OIDs and we render the friendly name.
const PG_OID_NAMES: Record<number, string> = {
  16: "bool",
  17: "bytea",
  18: "char",
  19: "name",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  700: "float4",
  701: "float8",
  790: "money",
  1000: "_bool",
  1005: "_int2",
  1007: "_int4",
  1009: "_text",
  1016: "_int8",
  1042: "bpchar",
  1043: "varchar",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1186: "interval",
  1266: "timetz",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
};
function pgOidToName(oid: number) {
  return PG_OID_NAMES[oid] ?? `oid:${oid}`;
}

function ident(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

export const postgresDriver: DriverAdapter = {
  async testConnection(c) {
    const start = Date.now();
    try {
      await withClient(c, async (client) => client.query("SELECT 1"));
      return { ok: true, message: "Conexión exitosa", latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async listSchemas(c) {
    return withClient(c, async (client) => {
      const r = await client.query<{ name: string }>(
        `SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name`,
      );
      const SYS = new Set(["information_schema", "pg_catalog", "pg_toast"]);
      return r.rows.map((row) => ({
        name: row.name,
        isSystem: SYS.has(row.name) || row.name.startsWith("pg_"),
      }));
    });
  },

  async listRelations(c, schema) {
    return withClient(c, async (client) => {
      // pg_total_relation_size includes indexes + toast; pg_relation_size is
      // heap-only. Views/matviews report 0 / NULL where the function doesn't
      // apply, which is fine — UI treats missing sizes as "—".
      const r = await client.query<{
        schema: string;
        name: string;
        kind: string;
        approx_rows: string | null;
        total_bytes: string | null;
        data_bytes: string | null;
        index_bytes: string | null;
      }>(
        `SELECT n.nspname AS schema,
                c.relname AS name,
                CASE c.relkind WHEN 'r' THEN 'table'
                               WHEN 'v' THEN 'view'
                               WHEN 'm' THEN 'materialized_view'
                               WHEN 'p' THEN 'table' END AS kind,
                CASE WHEN c.relkind IN ('r','m','p') AND c.reltuples >= 0
                     THEN c.reltuples::bigint END AS approx_rows,
                CASE WHEN c.relkind IN ('r','m','p')
                     THEN pg_total_relation_size(c.oid) END AS total_bytes,
                CASE WHEN c.relkind IN ('r','m','p')
                     THEN pg_relation_size(c.oid) END AS data_bytes,
                CASE WHEN c.relkind IN ('r','m','p')
                     THEN pg_indexes_size(c.oid) END AS index_bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p')
           AND ($1::text IS NULL OR n.nspname = $1)
         ORDER BY n.nspname, c.relname`,
        [schema ?? null],
      );
      return r.rows.map((row) => ({
        schema: row.schema,
        name: row.name,
        kind: row.kind as "table" | "view" | "materialized_view",
        approxRowCount: row.approx_rows != null ? Number(row.approx_rows) : undefined,
        totalBytes: row.total_bytes != null ? Number(row.total_bytes) : undefined,
        dataBytes: row.data_bytes != null ? Number(row.data_bytes) : undefined,
        indexBytes: row.index_bytes != null ? Number(row.index_bytes) : undefined,
      }));
    });
  },

  async getConnectionOverview(c) {
    return withClient(c, async (client) => {
      // Fan out the cheap server-level queries in parallel — each is a single
      // round-trip on the same connection. pg lets you queue queries without
      // pipelining giving up much, and the wall-clock dominates.
      const [meta, dbs, activity, settings] = await Promise.all([
        client.query<{
          version: string;
          current_database: string;
          current_user: string;
          server_time: string;
          uptime_seconds: string;
        }>(
          `SELECT version() AS version,
                  current_database() AS current_database,
                  current_user AS current_user,
                  -- ISO-8601 UTC: now()::text ("… 03:11:43.12+00") is
                  -- "Invalid Date" for Safari's Date parser.
                  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_time,
                  EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_seconds`,
        ),
        client.query<{
          name: string;
          size_bytes: string | null;
          is_template: boolean;
        }>(
          `SELECT d.datname AS name,
                  CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                       THEN pg_database_size(d.datname) END AS size_bytes,
                  d.datistemplate AS is_template
           FROM pg_database d
           WHERE NOT d.datistemplate OR d.datname IN ('template0', 'template1')
           ORDER BY d.datname`,
        ),
        client.query<{ active: string }>(
          `SELECT count(*)::bigint AS active FROM pg_stat_activity WHERE state IS NOT NULL`,
        ),
        client.query<{ setting: string }>(
          `SELECT setting FROM pg_settings WHERE name = 'max_connections'`,
        ),
      ]);

      const databases = dbs.rows.map((row) => ({
        name: row.name,
        isSystem: row.is_template || row.name === "postgres",
        sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : undefined,
      }));
      const totalSizeBytes = databases.reduce(
        (sum, d) => sum + (d.sizeBytes ?? 0),
        0,
      );
      const m = meta.rows[0];
      return {
        driver: "postgres" as const,
        serverVersion: m?.version,
        currentDatabase: m?.current_database,
        currentUser: m?.current_user,
        serverTime: m?.server_time,
        uptimeSeconds: m?.uptime_seconds != null ? Number(m.uptime_seconds) : undefined,
        activeConnections: activity.rows[0]?.active != null ? Number(activity.rows[0].active) : undefined,
        maxConnections: settings.rows[0]?.setting ? Number(settings.rows[0].setting) : undefined,
        totalSizeBytes: totalSizeBytes > 0 ? totalSizeBytes : undefined,
        databases,
      };
    });
  },

  async describeTable(c, schema, name) {
    return withClient(c, async (client) => {
      const rel = await client.query<{ relkind: string }>(
        `SELECT c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, name],
      );
      const relkind = rel.rows[0]?.relkind;
      const kind: TableDetails["kind"] =
        relkind === "v" ? "view" : relkind === "m" ? "materialized_view" : "table";
      // is_unique: the column alone is covered by a full (non-partial),
      // non-primary unique index — same meaning as MySQL's `UNI` key.
      const cols = await client.query<{
        name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_pk: boolean;
        is_unique: boolean;
        comment: string | null;
      }>(
        `SELECT a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                pg_get_expr(d.adbin, d.adrelid) AS column_default,
                COALESCE(p.is_pk, false) AS is_pk,
                EXISTS (
                  SELECT 1 FROM pg_index ui
                  WHERE ui.indrelid = a.attrelid AND ui.indisunique
                    AND NOT ui.indisprimary AND ui.indnatts = 1
                    AND ui.indkey[0] = a.attnum AND ui.indpred IS NULL
                ) AS is_unique,
                col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN (
           SELECT a.attname, true AS is_pk
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           JOIN pg_class c2 ON c2.oid = i.indrelid
           JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
           WHERE i.indisprimary AND n2.nspname = $1 AND c2.relname = $2
         ) p ON p.attname = a.attname
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, name],
      );
      const idx = await client.query<{
        name: string;
        is_unique: boolean;
        is_primary: boolean;
        columns: string[];
      }>(
        `SELECT ic.relname AS name,
                i.indisunique AS is_unique,
                i.indisprimary AS is_primary,
                -- Plain columns by attname (pg_get_indexdef would return them
                -- SQL-quoted, e.g. "select"); expressions via pg_get_indexdef.
                ARRAY(
                  SELECT CASE WHEN i.indkey[k] = 0
                              THEN pg_get_indexdef(i.indexrelid, k + 1, true)
                              ELSE (SELECT ka.attname::text FROM pg_attribute ka
                                    WHERE ka.attrelid = i.indrelid AND ka.attnum = i.indkey[k])
                         END
                  FROM generate_subscripts(i.indkey, 1) AS k
                  ORDER BY k
                ) AS columns
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class tc ON tc.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = tc.relnamespace
         WHERE n.nspname = $1 AND tc.relname = $2
         ORDER BY i.indisprimary DESC, i.indisunique DESC, ic.relname`,
        [schema, name],
      );
      // Single round-trip for FKs: unnest conkey/confkey with ordinality and
      // resolve back to attribute names so the columns line up positionally.
      const fks = await client.query<{
        name: string;
        local_cols: string[];
        ref_schema: string;
        ref_table: string;
        ref_cols: string[];
        on_update: string | null;
        on_delete: string | null;
      }>(
        `SELECT
           c.conname AS name,
           ARRAY(
             SELECT a.attname::text
             FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ORDER BY k.ord
           ) AS local_cols,
           n2.nspname AS ref_schema,
           c2.relname AS ref_table,
           ARRAY(
             SELECT a.attname::text
             FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
             ORDER BY k.ord
           ) AS ref_cols,
           CASE c.confupdtype
             WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
             WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
             WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
           CASE c.confdeltype
             WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
             WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
             WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
         FROM pg_constraint c
         JOIN pg_class cls ON cls.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cls.relnamespace
         JOIN pg_class c2 ON c2.oid = c.confrelid
         JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         WHERE c.contype = 'f' AND n.nspname = $1 AND cls.relname = $2
         ORDER BY c.conname`,
        [schema, name],
      );
      return {
        schema,
        name,
        kind,
        columns: cols.rows.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: row.is_nullable === "YES",
          isPrimaryKey: row.is_pk,
          isUnique: row.is_unique,
          default: row.column_default,
          comment: row.comment,
        })),
        indexes: idx.rows.map((row) => ({
          name: row.name,
          columns: row.columns,
          unique: row.is_unique,
          primary: row.is_primary,
        })),
        foreignKeys: fks.rows.map((row) => ({
          name: row.name,
          columns: row.local_cols,
          referencedSchema: row.ref_schema,
          referencedTable: row.ref_table,
          referencedColumns: row.ref_cols,
          onUpdate: row.on_update ?? undefined,
          onDelete: row.on_delete ?? undefined,
        })),
      };
    });
  },

  async runQuery(c, sql, options) {
    return runPg(c, sql, options?.schema, options?.params, QUERY_LIMIT);
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
    // Ask for one extra row so `truncated` can tell whether more rows exist.
    const sql = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ${orderBy} LIMIT $1 OFFSET $2`;
    return runPg(c, sql, undefined, [limit + 1, offset], limit);
  },

  async *iterateTable(c, opts) {
    // Server-side cursor — keeps memory bounded for huge tables without
    // emitting a giant ORDER BY (Postgres preserves cursor order from the
    // underlying scan, which is stable within a transaction).
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const where = opts.where?.trim() ? `WHERE ${opts.where.trim()}` : "";
    const cursorName = `dv_export_${Date.now().toString(36)}`;
    const client = new Client(clientConfig(c));
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        `DECLARE ${ident(cursorName)} NO SCROLL CURSOR FOR SELECT * FROM ${ident(
          opts.schema,
        )}.${ident(opts.name)} ${where}`,
      );
      let first = true;
      while (true) {
        const r = await client.query({
          text: `FETCH FORWARD ${batchSize} FROM ${ident(cursorName)}`,
          rowMode: "array",
        });
        const columns: QueryResultColumn[] = (r.fields ?? []).map((f) => ({
          name: f.name,
          dataType: pgOidToName(f.dataTypeID),
        }));
        const rows = (r.rows as unknown[][]).map((row) =>
          row.map((cell) => normalizeCell(cell)),
        );
        // An empty table still yields one (empty) batch so exporters get the
        // column list for headers.
        if (rows.length === 0 && !first) break;
        first = false;
        yield { columns, rows } as TableBatch;
        if (rows.length < batchSize) break;
      }
      await client.query(`CLOSE ${ident(cursorName)}`);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw enrichPgError(e);
    } finally {
      await client.end().catch(() => undefined);
    }
  },

  generateCreateTableSql(_c, schema, name, columns) {
    return buildPostgresCreateTable(schema, name, columns);
  },

  async createSchema(c, options) {
    const name = options.name.trim();
    if (!name) throw new Error("El nombre no puede estar vacío");
    const parts = [`CREATE SCHEMA ${ident(name)}`];
    if (options.owner) parts.push(`AUTHORIZATION ${ident(options.owner)}`);
    await this.runQuery(c, parts.join(" "));
  },

  async createTable(c, options) {
    const statements = [
      buildPostgresCreateTableFromDraft(
        options.schema,
        options.name,
        options.columns,
        options.foreignKeys,
      ),
      ...(options.indexes ?? []).map((idx) =>
        buildPostgresCreateIndexSql({ schema: options.schema, table: options.name, ...idx }),
      ),
    ];
    // DDL is transactional in Postgres: run table + indexes atomically so a
    // bad index doesn't leave a half-created table behind.
    await withClient(c, async (client) => {
      await client.query("BEGIN");
      try {
        for (const s of statements) {
          await client.query(s).catch((e) => {
            throw enrichPgError(e, s);
          });
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  },

  async createIndex(c, options) {
    await this.runQuery(c, buildPostgresCreateIndexSql(options));
  },

  async dropIndex(c, options) {
    // Postgres indexes live in the same namespace as tables — schema-qualified.
    const fqn = options.schema
      ? `${ident(options.schema)}.${ident(options.name)}`
      : ident(options.name);
    await this.runQuery(c, `DROP INDEX IF EXISTS ${fqn}`);
  },

  async dropTable(c, schema, name, options) {
    const tail = options?.cascade ? " CASCADE" : "";
    await this.runQuery(
      c,
      `DROP TABLE IF EXISTS ${ident(schema)}.${ident(name)}${tail}`,
    );
  },

  async dropSchema(c, name, options) {
    const tail = options?.cascade ? " CASCADE" : "";
    await this.runQuery(c, `DROP SCHEMA IF EXISTS ${ident(name)}${tail}`);
  },

  async truncateTable(c, schema, name, options) {
    const tail = options?.cascade ? " CASCADE" : "";
    await this.runQuery(
      c,
      `TRUNCATE TABLE ${ident(schema)}.${ident(name)}${tail}`,
    );
  },
};

async function runPg(
  c: ResolvedConnection,
  sql: string,
  schema: string | undefined,
  params: unknown[] | undefined,
  maxRows: number,
): Promise<QueryResult> {
  return withClient(c, async (client) => {
    if (schema) {
      // search_path is per-session — safe to set on this short-lived client.
      await client.query(`SET search_path TO ${ident(schema)}, public`);
    }
    const start = Date.now();
    let r: PgArrayResult | PgArrayResult[];
    try {
      r = await client.query({ text: sql, values: params, rowMode: "array" });
    } catch (e) {
      throw enrichPgError(e, sql);
    }
    return shapeResult(r, Date.now() - start, maxRows);
  });
}

// Integer columns fed by a sequence (`nextval('…'::regclass)`) are emitted as
// serial types: the referenced sequence is owned by the source table, so it
// doesn't exist in a fresh database nor after `DROP TABLE` (export with
// "DROP IF EXISTS"), which made the generated DDL fail.
const SERIAL_FOR_TYPE: Record<string, string> = {
  smallint: "smallserial",
  integer: "serial",
  bigint: "bigserial",
};
const NEXTVAL_DEFAULT = /^nextval\('(?:[^']|'')*'::regclass\)$/;

function buildPostgresCreateTable(
  schema: string,
  name: string,
  columns: ColumnInfo[],
): string {
  const colLines = columns.map((c) => {
    const serial =
      c.default != null && NEXTVAL_DEFAULT.test(c.default.trim())
        ? SERIAL_FOR_TYPE[c.dataType]
        : undefined;
    const parts = [qiCore("postgres", c.name), serial ?? c.dataType];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default != null && !serial) parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => qiCore("postgres", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  return `CREATE TABLE ${qiCore("postgres", schema)}.${qiCore(
    "postgres",
    name,
  )} (\n${colLines.join(",\n")}\n);`;
}

function buildPostgresCreateTableFromDraft(
  schema: string,
  name: string,
  columns: CreateTableColumn[],
  foreignKeys: CreateTableForeignKey[] | undefined,
): string {
  if (!schema.trim()) throw new Error("Schema requerido");
  if (!name.trim()) throw new Error("Nombre de tabla requerido");
  if (columns.length === 0) throw new Error("Agregá al menos una columna");
  const colLines = columns.map((c) => {
    if (!c.name.trim()) throw new Error("Hay una columna sin nombre");
    if (!c.dataType.trim()) throw new Error(`Falta el tipo de "${c.name}"`);
    const parts = [qiCore("postgres", c.name), c.dataType];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns
    .filter((c) => c.primaryKey)
    .map((c) => qiCore("postgres", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  for (const fk of foreignKeys ?? []) {
    colLines.push("  " + renderForeignKeyClause("postgres", fk));
  }
  return `CREATE TABLE ${qiCore("postgres", schema)}.${qiCore(
    "postgres",
    name,
  )} (\n${colLines.join(",\n")}\n);`;
}

function buildPostgresCreateIndexSql(options: CreateIndexOptions): string {
  if (!options.table.trim()) throw new Error("table requerido");
  if (options.columns.length === 0)
    throw new Error("Agregá al menos una columna al índice");
  const unique = options.unique ? "UNIQUE " : "";
  const idxName = (options.name ?? autoIndexName(options.table, options.columns)).trim();
  const fqTable = `${qiCore("postgres", options.schema)}.${qiCore(
    "postgres",
    options.table,
  )}`;
  const cols = options.columns.map((c) => qiCore("postgres", c)).join(", ");
  return `CREATE ${unique}INDEX IF NOT EXISTS ${qiCore(
    "postgres",
    idxName,
  )} ON ${fqTable} (${cols});`;
}

// Suppress unused-import warning when no helpers reference TableBatch directly.
export type { IterateTableOptions };
