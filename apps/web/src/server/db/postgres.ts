import { Client, type ClientConfig } from "pg";
import type { QueryResult, QueryResultColumn } from "@data-view/core";
import type { DriverAdapter, ResolvedConnection } from "./types";

const QUERY_LIMIT = 5000;

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
  };
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

function shapeResult(res: import("pg").QueryArrayResult, durationMs: number): QueryResult {
  const columns: QueryResultColumn[] = (res.fields ?? []).map((f) => ({
    name: f.name,
    dataType: pgOidToName(f.dataTypeID),
  }));
  const rows = (res.rows as unknown[][]).map((row) =>
    row.map((cell) => normalizeCell(cell)),
  );
  const truncated = rows.length === QUERY_LIMIT;
  return {
    columns,
    rows: rows as QueryResult["rows"],
    rowCount: rows.length,
    affectedRows: typeof res.rowCount === "number" ? res.rowCount : null,
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
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  700: "float4",
  701: "float8",
  1043: "varchar",
  1082: "date",
  1114: "timestamp",
  1184: "timestamptz",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
  114: "json",
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
                  now()::text AS server_time,
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
      const cols = await client.query<{
        name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_pk: boolean;
      }>(
        `SELECT a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                pg_get_expr(d.adbin, d.adrelid) AS column_default,
                COALESCE(p.is_pk, false) AS is_pk
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
                ARRAY(
                  SELECT pg_get_indexdef(i.indexrelid, k + 1, true)
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
      return {
        schema,
        name,
        kind: "table",
        columns: cols.rows.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: row.is_nullable === "YES",
          isPrimaryKey: row.is_pk,
          isUnique: false,
          default: row.column_default,
        })),
        indexes: idx.rows.map((row) => ({
          name: row.name,
          columns: row.columns,
          unique: row.is_unique,
          primary: row.is_primary,
        })),
        foreignKeys: [],
      };
    });
  },

  async runQuery(c, sql, options) {
    return withClient(c, async (client) => {
      if (options?.schema) {
        // search_path is per-session — safe to set on this short-lived client.
        await client.query(`SET search_path TO ${ident(options.schema)}, public`);
      }
      const start = Date.now();
      const r = await client.query({
        text: sql,
        values: options?.params,
        rowMode: "array",
      });
      return shapeResult(r, Date.now() - start);
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
    const sql = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ${orderBy} LIMIT $1 OFFSET $2`;
    return this.runQuery(c, sql, { params: [limit, offset] });
  },
};
