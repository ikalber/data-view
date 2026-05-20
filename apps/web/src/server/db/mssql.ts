import sql from "mssql";
import type {
  ColumnInfo,
  CreateSchemaOptions,
  CreateTableColumn,
  CreateTableOptions,
  QueryResult,
  QueryResultColumn,
} from "@data-view/core";
import { quoteIdent as qiCore } from "@data-view/core";
import type {
  DriverAdapter,
  IterateTableOptions,
  ResolvedConnection,
  TableBatch,
} from "./types";

const QUERY_LIMIT = 5000;

async function withPool<T>(c: ResolvedConnection, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = await new sql.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database,
    options: {
      encrypt: !!c.ssl,
      trustServerCertificate: c.options?.trustServerCertificate === "true",
      ...(c.options?.instanceName ? { instanceName: c.options.instanceName } : {}),
    },
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
  }).connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

function ident(name: string) {
  return `[${name.replace(/]/g, "]]")}]`;
}

function normalizeCell(v: unknown) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __binary: true as const, bytes: v.length };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

export const mssqlDriver: DriverAdapter = {
  async testConnection(c) {
    const start = Date.now();
    try {
      await withPool(c, async (pool) => pool.request().query("SELECT 1"));
      return { ok: true, message: "Conexión exitosa", latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async listSchemas(c) {
    return withPool(c, async (pool) => {
      const r = await pool.request().query<{ name: string }>(
        `SELECT name FROM sys.schemas ORDER BY name`,
      );
      const SYS = new Set([
        "sys",
        "INFORMATION_SCHEMA",
        "guest",
        "db_owner",
        "db_accessadmin",
        "db_securityadmin",
        "db_ddladmin",
        "db_backupoperator",
        "db_datareader",
        "db_datawriter",
        "db_denydatareader",
        "db_denydatawriter",
      ]);
      return r.recordset.map((row) => ({ name: row.name, isSystem: SYS.has(row.name) }));
    });
  },

  async listRelations(c, schema) {
    return withPool(c, async (pool) => {
      const req = pool.request();
      const where = schema ? "AND s.name = @schema" : "";
      if (schema) req.input("schema", sql.NVarChar, schema);
      // Sizes from dm_db_partition_stats (8 KB pages) — only meaningful for
      // user tables. Views report no size; left-join nulls render as "—".
      const r = await req.query<{
        schema: string;
        name: string;
        kind: string;
        approx_rows: number | null;
        total_pages: number | null;
        used_pages: number | null;
      }>(
        `SELECT s.name AS [schema], o.name AS name,
                CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' END AS kind,
                ps.row_count AS approx_rows,
                ps.total_pages AS total_pages,
                ps.used_pages AS used_pages
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         OUTER APPLY (
           SELECT SUM(p.rows) AS row_count,
                  SUM(p.reserved_page_count) AS total_pages,
                  SUM(p.used_page_count) AS used_pages
           FROM sys.dm_db_partition_stats p
           WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
         ) ps
         WHERE o.type IN ('U','V') ${where}
         ORDER BY s.name, o.name`,
      );
      return r.recordset.map((row) => ({
        schema: row.schema,
        name: row.name,
        kind: (row.kind ?? "table") as "table" | "view",
        approxRowCount: row.approx_rows != null ? Number(row.approx_rows) : undefined,
        totalBytes: row.total_pages != null ? Number(row.total_pages) * 8192 : undefined,
        dataBytes: row.used_pages != null ? Number(row.used_pages) * 8192 : undefined,
      }));
    });
  },

  async getConnectionOverview(c) {
    return withPool(c, async (pool) => {
      const meta = await pool.request().query<{
        version: string;
        current_database: string;
        current_user: string;
        server_time: Date;
        uptime_seconds: number | null;
      }>(
        `SELECT @@VERSION AS version,
                DB_NAME() AS current_database,
                SUSER_SNAME() AS current_user,
                SYSUTCDATETIME() AS server_time,
                DATEDIFF(SECOND, sqlserver_start_time, SYSUTCDATETIME()) AS uptime_seconds
         FROM sys.dm_os_sys_info`,
      );

      // Sum sizes per database from sys.master_files (size is in 8 KB pages).
      const dbs = await pool.request().query<{
        name: string;
        size_bytes: number | null;
        is_system: number;
      }>(
        `SELECT d.name AS name,
                SUM(CAST(f.size AS BIGINT)) * 8192 AS size_bytes,
                CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END AS is_system
         FROM sys.databases d
         LEFT JOIN sys.master_files f ON f.database_id = d.database_id
         GROUP BY d.name, d.database_id
         ORDER BY d.name`,
      );

      const activity = await pool.request().query<{
        active: number;
      }>(
        `SELECT COUNT(*) AS active FROM sys.dm_exec_sessions WHERE is_user_process = 1`,
      );

      const databases = dbs.recordset.map((row) => ({
        name: row.name,
        isSystem: row.is_system === 1,
        sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : undefined,
      }));
      const totalSizeBytes = databases.reduce(
        (sum, d) => sum + (d.sizeBytes ?? 0),
        0,
      );
      const m = meta.recordset[0];
      return {
        driver: "mssql" as const,
        serverVersion: m?.version,
        currentDatabase: m?.current_database,
        currentUser: m?.current_user,
        serverTime: m?.server_time instanceof Date ? m.server_time.toISOString() : undefined,
        uptimeSeconds: m?.uptime_seconds != null ? Number(m.uptime_seconds) : undefined,
        activeConnections:
          activity.recordset[0]?.active != null ? Number(activity.recordset[0].active) : undefined,
        totalSizeBytes: totalSizeBytes > 0 ? totalSizeBytes : undefined,
        databases,
      };
    });
  },

  async describeTable(c, schema, name) {
    return withPool(c, async (pool) => {
      const r = await pool
        .request()
        .input("schema", sql.NVarChar, schema)
        .input("name", sql.NVarChar, name)
        .query<{
          name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          is_pk: number;
        }>(
          `SELECT c.column_name AS name,
                  c.data_type AS data_type,
                  c.is_nullable AS is_nullable,
                  c.column_default AS column_default,
                  CASE WHEN kcu.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_pk
           FROM information_schema.columns c
           LEFT JOIN information_schema.table_constraints tc
             ON tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
           LEFT JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.column_name = c.column_name
           WHERE c.table_schema = @schema AND c.table_name = @name
           ORDER BY c.ordinal_position`,
        );
      const idx = await pool
        .request()
        .input("schema", sql.NVarChar, schema)
        .input("name", sql.NVarChar, name)
        .query<{
          index_name: string;
          is_unique: boolean;
          is_primary: boolean;
          column_name: string;
          key_ordinal: number;
        }>(
          `SELECT i.name AS index_name,
                  i.is_unique,
                  i.is_primary_key AS is_primary,
                  c.name AS column_name,
                  ic.key_ordinal
           FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           JOIN sys.tables t ON t.object_id = i.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           WHERE s.name = @schema AND t.name = @name AND i.name IS NOT NULL AND ic.is_included_column = 0
           ORDER BY i.name, ic.key_ordinal`,
        );
      const indexMap = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean }>();
      for (const row of idx.recordset) {
        let entry = indexMap.get(row.index_name);
        if (!entry) {
          entry = {
            name: row.index_name,
            columns: [],
            unique: Boolean(row.is_unique),
            primary: Boolean(row.is_primary),
          };
          indexMap.set(row.index_name, entry);
        }
        entry.columns.push(row.column_name);
      }
      return {
        schema,
        name,
        kind: "table" as const,
        columns: r.recordset.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: row.is_nullable === "YES",
          isPrimaryKey: row.is_pk === 1,
          isUnique: false,
          default: row.column_default,
        })),
        indexes: Array.from(indexMap.values()).sort((a, b) => {
          if (a.primary !== b.primary) return a.primary ? -1 : 1;
          if (a.unique !== b.unique) return a.unique ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
        foreignKeys: [],
      };
    });
  },

  async runQuery(c, sqlText, options) {
    const prefixed = options?.schema
      ? `USE [${options.schema.replace(/]/g, "]]")}];\n${sqlText}`
      : sqlText;
    const start = Date.now();
    return withPool(c, async (pool) => {
      const req = pool.request();
      req.arrayRowMode = true;
      const r = await req.query(prefixed);
      const cols = (r.recordset?.columns ? Object.values(r.recordset.columns) : []) as Array<{
        name: string;
        type: { name: string };
      }>;
      const rows = ((r.recordset as unknown as Array<unknown[]>) ?? []).map((row) =>
        row.map(normalizeCell),
      );
      return {
        columns: cols.map((c) => ({ name: c.name, dataType: c.type?.name ?? "unknown" })),
        rows: rows as QueryResult["rows"],
        rowCount: rows.length,
        affectedRows: typeof r.rowsAffected?.[0] === "number" ? r.rowsAffected[0] : null,
        durationMs: Date.now() - start,
        truncated: rows.length === QUERY_LIMIT,
      };
    });
  },

  async fetchTableData(c, schema, name, options) {
    const limit = Math.min(options?.limit ?? 100, QUERY_LIMIT);
    const offset = options?.offset ?? 0;
    const orderBy = options?.orderBy?.length
      ? options.orderBy.map((o) => `${ident(o.column)} ${o.direction.toUpperCase()}`).join(", ")
      : "(SELECT NULL)";
    const where = options?.where?.trim() ? `WHERE ${options.where.trim()}` : "";
    const sqlText = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    return this.runQuery(c, sqlText);
  },

  async *iterateTable(c, opts) {
    // tiberius/mssql doesn't have a clean cursor API, so we OFFSET/FETCH-page
    // through the table. We need a stable ORDER BY — fall back to ordering by
    // the first column if no primary key is available.
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const where = opts.where?.trim() ? `WHERE ${opts.where.trim()}` : "";
    const pool = await new sql.ConnectionPool({
      server: c.host,
      port: c.port,
      user: c.username,
      password: c.password,
      database: c.database,
      options: {
        encrypt: !!c.ssl,
        trustServerCertificate: c.options?.trustServerCertificate === "true",
        ...(c.options?.instanceName ? { instanceName: c.options.instanceName } : {}),
      },
      connectionTimeout: 10_000,
      requestTimeout: 600_000,
    }).connect();
    try {
      // Discover an ORDER BY column — PK preferred, else first column. SQL
      // Server requires this for OFFSET/FETCH.
      const orderCol = await firstOrderingColumn(pool, opts.schema, opts.name);
      const orderBy = orderCol ? ident(orderCol) : "(SELECT NULL)";
      let offset = 0;
      let columns: QueryResultColumn[] = [];
      while (true) {
        const req = pool.request();
        req.arrayRowMode = true;
        const r = await req.query(
          `SELECT * FROM ${ident(opts.schema)}.${ident(opts.name)} ${where} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`,
        );
        const cols = (r.recordset?.columns
          ? Object.values(r.recordset.columns)
          : []) as Array<{ name: string; type: { name: string } }>;
        if (columns.length === 0) {
          columns = cols.map((col) => ({
            name: col.name,
            dataType: col.type?.name ?? "unknown",
          }));
        }
        const rows = ((r.recordset as unknown as Array<unknown[]>) ?? []).map((row) =>
          row.map(normalizeCell),
        );
        if (rows.length === 0) break;
        yield { columns, rows: rows as QueryResult["rows"] } as TableBatch;
        if (rows.length < batchSize) break;
        offset += rows.length;
      }
    } finally {
      await pool.close().catch(() => undefined);
    }
  },

  generateCreateTableSql(_c, schema, name, columns) {
    return buildMssqlCreateTable(schema, name, columns);
  },

  async createSchema(c, options) {
    const name = options.name.trim();
    if (!name) throw new Error("El nombre no puede estar vacío");
    // CREATE SCHEMA must be the only statement in its batch — runQuery sends a
    // single batch, so this is fine.
    await this.runQuery(c, `CREATE SCHEMA ${ident(name)}`);
  },

  async createTable(c, options) {
    const sqlText = buildMssqlCreateTableFromDraft(
      options.schema,
      options.name,
      options.columns,
    );
    await this.runQuery(c, sqlText);
  },

  async dropTable(c, schema, name) {
    // SQL Server doesn't take CASCADE on DROP TABLE; the user has to drop
    // FKs/views first or pass cascade=false (default).
    await this.runQuery(
      c,
      `DROP TABLE IF EXISTS ${ident(schema)}.${ident(name)}`,
    );
  },

  async dropSchema(c, name) {
    // `DROP SCHEMA … IF EXISTS` is supported in SQL Server 2016+; fall back
    // gracefully on the error otherwise — the user can retry via the SQL
    // editor.
    await this.runQuery(c, `DROP SCHEMA IF EXISTS ${ident(name)}`);
  },

  async truncateTable(c, schema, name) {
    await this.runQuery(
      c,
      `TRUNCATE TABLE ${ident(schema)}.${ident(name)}`,
    );
  },
};

async function firstOrderingColumn(
  pool: sql.ConnectionPool,
  schema: string,
  name: string,
): Promise<string | null> {
  const r = await pool
    .request()
    .input("schema", sql.NVarChar, schema)
    .input("name", sql.NVarChar, name)
    .query<{ column_name: string }>(
      `SELECT TOP 1 kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = @schema AND tc.table_name = @name
       ORDER BY kcu.ordinal_position`,
    );
  if (r.recordset[0]?.column_name) return r.recordset[0].column_name;
  const r2 = await pool
    .request()
    .input("schema", sql.NVarChar, schema)
    .input("name", sql.NVarChar, name)
    .query<{ column_name: string }>(
      `SELECT TOP 1 column_name FROM information_schema.columns
       WHERE table_schema = @schema AND table_name = @name
       ORDER BY ordinal_position`,
    );
  return r2.recordset[0]?.column_name ?? null;
}

function buildMssqlCreateTable(
  schema: string,
  name: string,
  columns: ColumnInfo[],
): string {
  const colLines = columns.map((c) => {
    const parts = [qiCore("mssql", c.name), c.dataType];
    parts.push(c.nullable ? "NULL" : "NOT NULL");
    if (c.default != null) parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => qiCore("mssql", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  return `CREATE TABLE ${qiCore("mssql", schema)}.${qiCore("mssql", name)} (\n${colLines.join(
    ",\n",
  )}\n);`;
}

function buildMssqlCreateTableFromDraft(
  schema: string,
  name: string,
  columns: CreateTableColumn[],
): string {
  if (!schema.trim()) throw new Error("Schema requerido");
  if (!name.trim()) throw new Error("Nombre de tabla requerido");
  if (columns.length === 0) throw new Error("Agregá al menos una columna");
  const colLines = columns.map((c) => {
    if (!c.name.trim()) throw new Error("Hay una columna sin nombre");
    if (!c.dataType.trim()) throw new Error(`Falta el tipo de "${c.name}"`);
    const parts = [qiCore("mssql", c.name), c.dataType];
    parts.push(c.nullable ? "NULL" : "NOT NULL");
    if (c.default != null && c.default !== "") parts.push(`DEFAULT ${c.default}`);
    return "  " + parts.join(" ");
  });
  const pk = columns
    .filter((c) => c.primaryKey)
    .map((c) => qiCore("mssql", c.name));
  if (pk.length > 0) {
    colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  }
  return `CREATE TABLE ${qiCore("mssql", schema)}.${qiCore("mssql", name)} (\n${colLines.join(
    ",\n",
  )}\n);`;
}

export type { IterateTableOptions };
