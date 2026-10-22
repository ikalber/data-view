import sql from "mssql";
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

function poolConfig(c: ResolvedConnection, requestTimeout = 60_000): sql.config {
  const trust = c.options?.trustServerCertificate;
  return {
    server: c.host,
    port: c.port,
    user: c.username,
    password: c.password,
    database: c.database,
    options: {
      encrypt: !!c.ssl,
      // Same trust model as the Postgres adapter (rejectUnauthorized: false):
      // the UI only has an SSL switch, and SQL Server ships with a
      // self-signed certificate, so verification made "SSL on" always fail.
      // `options.trustServerCertificate = "false"` opts back into it.
      trustServerCertificate: trust != null ? trust === "true" : true,
      ...(c.options?.instanceName ? { instanceName: c.options.instanceName } : {}),
    },
    // One connection per short-lived pool, so consecutive batches (GO) share
    // the session (temp tables, SET options, USE).
    pool: { min: 0, max: 1 },
    connectionTimeout: 10_000,
    requestTimeout,
  };
}

async function withPool<T>(c: ResolvedConnection, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = await new sql.ConnectionPool(poolConfig(c)).connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

function ident(name: string) {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** SQL Server often reports the real cause in an earlier message and ends
 * with a generic one ("Could not create constraint or index. See previous
 * errors."); mssql only puts the last one in `message`. Fold them together
 * and add the line number for multi-line scripts. */
function enrichMssqlError(e: unknown, sqlText?: string, lineOffset = 0): unknown {
  if (!(e instanceof Error)) return e;
  const me = e as Error & { precedingErrors?: Array<{ message?: string }>; lineNumber?: number };
  const messages = (me.precedingErrors ?? [])
    .map((p) => p.message)
    .filter((m): m is string => !!m && m !== me.message);
  const parts = [...messages, me.message];
  if (sqlText?.includes("\n") && typeof me.lineNumber === "number" && me.lineNumber > 0) {
    parts.push(`Line ${me.lineNumber + lineOffset}`);
  }
  me.message = parts.join("\n");
  return me;
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}

/** tedious hands back every temporal type as a JS Date (UTC-based, since
 * mssql's `useUTC` is on). Render them like the server does instead of a
 * full ISO timestamp — a `time` column showed "1970-01-01T23:59:58.000Z" and
 * a `date` "2024-01-15T00:00:00.000Z". */
function formatTemporal(d: Date, typeName: string): string {
  const ms = d.getUTCMilliseconds();
  const frac = ms ? `.${pad(ms, 3)}` : "";
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
  switch (typeName) {
    case "Date":
      return date;
    case "Time":
      return time;
    case "DateTimeOffset":
      return d.toISOString();
    default:
      return `${date} ${time}`;
  }
}

function normalizeCell(v: unknown, typeName = "") {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __binary: true as const, bytes: v.length };
  if (v instanceof Date) return formatTemporal(v, typeName);
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

interface MssqlColumnMeta {
  name: string;
  type?: { name?: string };
}

function columnsOf(recordset: unknown): MssqlColumnMeta[] {
  const cols = (recordset as { columns?: unknown } | undefined)?.columns;
  if (!cols) return [];
  // arrayRowMode gives an array; object mode a name-keyed map.
  return (Array.isArray(cols) ? cols : Object.values(cols)) as MssqlColumnMeta[];
}

function typeNameOf(col: MssqlColumnMeta) {
  return col.type?.name ?? "unknown";
}

/**
 * Split a script into batches on `GO` lines (an SSMS/sqlcmd convention the
 * server doesn't understand), and run a leading `SET SHOWPLAN_* ON` on its
 * own since T-SQL requires it to be alone in its batch (the editor's EXPLAIN
 * sends `SET SHOWPLAN_ALL ON;\n<query>`). Both run on the same physical
 * connection (pool max 1), which is closed afterwards, so no `… OFF` needed.
 */
function splitBatches(sqlText: string): Array<{ text: string; lineOffset: number }> {
  const out: Array<{ text: string; lineOffset: number }> = [];
  let current: string[] = [];
  let start = 0;
  const lines = sqlText.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*GO\s*;?\s*$/i.test(line)) {
      out.push({ text: current.join("\n"), lineOffset: start });
      current = [];
      start = i + 1;
    } else {
      current.push(line);
    }
  });
  out.push({ text: current.join("\n"), lineOffset: start });
  const batches = out.filter((b) => b.text.trim() !== "");
  const first = batches[0];
  const showplan = first && /^\s*(SET\s+SHOWPLAN_(?:TEXT|ALL|XML)\s+ON)\s*;?/i.exec(first.text);
  if (first && showplan && first.text.slice(showplan[0].length).trim() !== "") {
    const rest = first.text.slice(showplan[0].length);
    batches.splice(0, 1, { text: showplan[1]!, lineOffset: first.lineOffset }, {
      text: rest,
      lineOffset: first.lineOffset + showplan[0].split("\n").length - 1,
    });
  }
  return batches.length > 0 ? batches : [{ text: sqlText, lineOffset: 0 }];
}

async function runMssql(c: ResolvedConnection, sqlText: string, maxRows: number): Promise<QueryResult> {
  const start = Date.now();
  return withPool(c, async (pool) => {
    let lastSet: unknown[][] | undefined;
    let lastCols: MssqlColumnMeta[] = [];
    let affected: number | null = null;
    for (const batch of splitBatches(sqlText)) {
      const req = pool.request();
      req.arrayRowMode = true;
      let r: sql.IResult<unknown>;
      try {
        // batch() sends a plain SQL batch; query() wraps it in sp_executesql,
        // which scopes SET options / #temp tables to that one call, so they
        // wouldn't reach the next GO batch.
        r = await req.batch(batch.text);
      } catch (e) {
        throw enrichMssqlError(e, sqlText, batch.lineOffset);
      }
      const sets = (r.recordsets ?? []) as unknown as unknown[][][];
      if (sets.length > 0) {
        lastSet = sets[sets.length - 1];
        lastCols = columnsOf(lastSet);
      }
      for (const n of r.rowsAffected ?? []) affected = (affected ?? 0) + n;
    }
    if (lastSet) {
      // Show the last row set, like the Postgres/MySQL adapters. SQL Server
      // also counts SELECTed rows in rowsAffected, so that isn't "affected".
      const truncated = lastSet.length > maxRows;
      const types = lastCols.map(typeNameOf);
      const rows = (truncated ? lastSet.slice(0, maxRows) : lastSet).map((row) =>
        row.map((v, i) => normalizeCell(v, types[i])),
      );
      return {
        columns: lastCols.map((col, i) => ({ name: col.name, dataType: types[i]! })),
        rows: rows as QueryResult["rows"],
        rowCount: rows.length,
        affectedRows: null,
        durationMs: Date.now() - start,
        truncated,
      };
    }
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: affected,
      durationMs: Date.now() - start,
      truncated: false,
    };
  });
}

function toInt(v: unknown, fallback: number) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
      // Sizes from sys.partitions + sys.allocation_units (8 KB pages), which
      // only need metadata visibility — sys.dm_db_partition_stats requires
      // VIEW DATABASE STATE. Heap/clustered (index_id 0/1) is data, the rest
      // are secondary indexes. Views report no size; nulls render as "—".
      const r = await req.query<{
        schema: string;
        name: string;
        kind: string;
        approx_rows: number | string | null;
        total_pages: number | string | null;
        data_pages: number | string | null;
        index_pages: number | string | null;
      }>(
        `SELECT s.name AS [schema], o.name AS name,
                CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END AS kind,
                pr.row_count AS approx_rows,
                au.total_pages, au.data_pages, au.index_pages
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         OUTER APPLY (
           SELECT SUM(p.rows) AS row_count
           FROM sys.partitions p
           WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
         ) pr
         OUTER APPLY (
           SELECT SUM(a.total_pages) AS total_pages,
                  SUM(CASE WHEN p.index_id IN (0, 1) THEN a.total_pages ELSE 0 END) AS data_pages,
                  SUM(CASE WHEN p.index_id > 1 THEN a.total_pages ELSE 0 END) AS index_pages
           FROM sys.partitions p
           JOIN sys.allocation_units a ON a.container_id = p.partition_id
           WHERE p.object_id = o.object_id
         ) au
         WHERE o.type IN ('U','V') ${where}
         ORDER BY s.name, o.name`,
      );
      const bytes = (pages: number | string | null) =>
        pages != null ? Number(pages) * 8192 : undefined;
      return r.recordset.map((row) => ({
        schema: row.schema,
        name: row.name,
        kind: row.kind as "table" | "view",
        approxRowCount: row.approx_rows != null ? Number(row.approx_rows) : undefined,
        totalBytes: bytes(row.total_pages),
        dataBytes: bytes(row.data_pages),
        indexBytes: bytes(row.index_pages),
      }));
    });
  },

  async getConnectionOverview(c) {
    return withPool(c, async (pool) => {
      // CURRENT_USER is a keyword, so the alias must be bracketed. Uptime is
      // derived from tempdb's creation (recreated at startup) because
      // sys.dm_os_sys_info needs VIEW SERVER STATE.
      const meta = await pool.request().query<{
        version: string;
        current_database: string;
        current_user: string;
        server_time: Date;
        uptime_seconds: number | null;
        max_connections: number | null;
      }>(
        `SELECT @@VERSION AS version,
                DB_NAME() AS current_database,
                SUSER_SNAME() AS [current_user],
                SYSUTCDATETIME() AS server_time,
                (SELECT DATEDIFF(SECOND, create_date, GETDATE())
                 FROM sys.databases WHERE name = 'tempdb') AS uptime_seconds,
                @@MAX_CONNECTIONS AS max_connections`,
      );

      // Sum sizes per database from sys.master_files (size is in 8 KB pages).
      const dbs = await pool.request().query<{
        name: string;
        size_bytes: number | string | null;
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
        maxConnections: m?.max_connections != null ? Number(m.max_connections) : undefined,
        totalSizeBytes: totalSizeBytes > 0 ? totalSizeBytes : undefined,
        databases,
      };
    });
  },

  async describeTable(c, schema, name) {
    return withPool(c, async (pool) => {
      // sys.columns instead of information_schema: data_type there has no
      // length/precision ("nvarchar", "decimal"), so a generated CREATE TABLE
      // or the structure editor's ALTER COLUMN shrank columns to nvarchar(1)
      // / decimal(18,0).
      const r = await pool
        .request()
        .input("schema", sql.NVarChar, schema)
        .input("name", sql.NVarChar, name)
        .query<{
          name: string;
          type_name: string;
          is_user_defined: boolean;
          max_length: number;
          precision: number;
          scale: number;
          is_nullable: boolean;
          column_default: string | null;
          comment: string | null;
          is_pk: number;
          is_unique: number;
          object_type: string;
        }>(
          `SELECT c.name AS name,
                  t.name AS type_name,
                  t.is_user_defined,
                  c.max_length, c.precision, c.scale,
                  c.is_nullable,
                  dc.definition AS column_default,
                  CAST(ep.value AS nvarchar(4000)) AS comment,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
                  ) THEN 1 ELSE 0 END AS is_pk,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    WHERE i.object_id = c.object_id AND i.is_unique = 1 AND i.is_primary_key = 0
                      AND i.has_filter = 0 AND ic.column_id = c.column_id AND ic.is_included_column = 0
                      AND (SELECT COUNT(*) FROM sys.index_columns k
                           WHERE k.object_id = i.object_id AND k.index_id = i.index_id
                             AND k.is_included_column = 0) = 1
                  ) THEN 1 ELSE 0 END AS is_unique,
                  o.type AS object_type
           FROM sys.columns c
           JOIN sys.objects o ON o.object_id = c.object_id
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           JOIN sys.types t ON t.user_type_id = c.user_type_id
           LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
           LEFT JOIN sys.extended_properties ep
             ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
            AND ep.name = 'MS_Description'
           WHERE s.name = @schema AND o.name = @name AND o.type IN ('U', 'V')
           ORDER BY c.column_id`,
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
      // Foreign keys: one row per column pair, grouped here (no STRING_AGG,
      // so names containing commas survive and SQL Server 2016 works).
      const fks = await pool
        .request()
        .input("schema", sql.NVarChar, schema)
        .input("name", sql.NVarChar, name)
        .query<{
          name: string;
          local_col: string;
          ref_schema: string;
          ref_table: string;
          ref_col: string;
          on_update: string;
          on_delete: string;
        }>(
          `SELECT
             fk.name AS name,
             c.name AS local_col,
             ref_s.name AS ref_schema,
             ref_t.name AS ref_table,
             ref_c.name AS ref_col,
             fk.update_referential_action_desc AS on_update,
             fk.delete_referential_action_desc AS on_delete
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
           JOIN sys.columns c ON c.object_id = fk.parent_object_id AND c.column_id = fkc.parent_column_id
           JOIN sys.columns ref_c ON ref_c.object_id = fk.referenced_object_id AND ref_c.column_id = fkc.referenced_column_id
           JOIN sys.tables ref_t ON ref_t.object_id = fk.referenced_object_id
           JOIN sys.schemas ref_s ON ref_s.schema_id = ref_t.schema_id
           JOIN sys.tables tab ON tab.object_id = fk.parent_object_id
           JOIN sys.schemas sch ON sch.schema_id = tab.schema_id
           WHERE sch.name = @schema AND tab.name = @name
           ORDER BY fk.name, fkc.constraint_column_id`,
        );
      const fkMap = new Map<string, TableFk>();
      for (const row of fks.recordset) {
        let fk = fkMap.get(row.name);
        if (!fk) {
          fk = {
            name: row.name,
            columns: [],
            referencedSchema: row.ref_schema,
            referencedTable: row.ref_table,
            referencedColumns: [],
            // sys.foreign_keys gives names like "NO_ACTION" — convert to the
            // SQL form ("NO ACTION") so the generated DDL is valid as-is.
            onUpdate: row.on_update?.replace("_", " ") || undefined,
            onDelete: row.on_delete?.replace("_", " ") || undefined,
          };
          fkMap.set(row.name, fk);
        }
        fk.columns.push(row.local_col);
        fk.referencedColumns.push(row.ref_col);
      }
      const isView = r.recordset[0]?.object_type?.trim() === "V";
      return {
        schema,
        name,
        kind: isView ? ("view" as const) : ("table" as const),
        columns: r.recordset.map((row) => ({
          name: row.name,
          dataType: mssqlTypeString(row),
          nullable: Boolean(row.is_nullable),
          isPrimaryKey: row.is_pk === 1,
          isUnique: row.is_unique === 1,
          default: row.column_default,
          comment: row.comment,
        })),
        indexes: Array.from(indexMap.values()).sort((a, b) => {
          if (a.primary !== b.primary) return a.primary ? -1 : 1;
          if (a.unique !== b.unique) return a.unique ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
        foreignKeys: Array.from(fkMap.values()),
      };
    });
  },

  async runQuery(c, sqlText) {
    // `options.schema` is intentionally ignored: the app's "schema" is a
    // schema inside the current database (that's what listSchemas returns),
    // and SQL Server has no per-session default schema to switch to. The
    // old `USE [schema]` failed with "Database '…' does not exist".
    return runMssql(c, sqlText, QUERY_LIMIT);
  },

  async fetchTableData(c, schema, name, options) {
    const limit = Math.min(toInt(options?.limit, 100), QUERY_LIMIT);
    const offset = toInt(options?.offset, 0);
    const orderBy = options?.orderBy?.length
      ? options.orderBy
          .map((o) => `${ident(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`)
          .join(", ")
      : "(SELECT NULL)";
    const where = options?.where?.trim() ? `WHERE ${options.where.trim()}` : "";
    // One extra row tells `truncated` whether another page exists.
    const sqlText = `SELECT * FROM ${ident(schema)}.${ident(name)} ${where} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`;
    return runMssql(c, sqlText, limit);
  },

  async *iterateTable(c, opts) {
    // Stream a single SELECT (with back-pressure) instead of OFFSET/FETCH
    // paging: paging ordered by only the first PK column (or the first
    // column for heaps) skipped/duplicated rows whenever that column had
    // ties, e.g. composite primary keys.
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const where = opts.where?.trim() ? `WHERE ${opts.where.trim()}` : "";
    const pool = await new sql.ConnectionPool(poolConfig(c, 600_000)).connect();
    const req = pool.request();
    let finished = false;
    try {
      req.arrayRowMode = true;
      let columns: QueryResultColumn[] = [];
      let types: string[] = [];
      req.on("recordset", (cols: unknown) => {
        const list = (Array.isArray(cols) ? cols : Object.values(cols as object)) as MssqlColumnMeta[];
        types = list.map(typeNameOf);
        columns = list.map((col, i) => ({ name: col.name, dataType: types[i]! }));
      });
      const stream = req.toReadableStream({ highWaterMark: batchSize });
      req
        .query(`SELECT * FROM ${ident(opts.schema)}.${ident(opts.name)} ${where}`)
        .catch(() => undefined); // errors surface through the stream
      let batchRows: unknown[][] = [];
      let yielded = false;
      try {
        for await (const row of stream as AsyncIterable<unknown[]>) {
          batchRows.push(row.map((v, i) => normalizeCell(v, types[i])));
          if (batchRows.length >= batchSize) {
            yielded = true;
            yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
            batchRows = [];
          }
        }
      } catch (e) {
        throw enrichMssqlError(e);
      }
      // An empty table still yields one (empty) batch so exporters get the
      // column list for headers.
      if (batchRows.length > 0 || !yielded) {
        yield { columns, rows: batchRows as QueryResult["rows"] } as TableBatch;
      }
      finished = true;
    } finally {
      if (!finished) req.cancel();
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
    const statements = [
      buildMssqlCreateTableFromDraft(
        options.schema,
        options.name,
        options.columns,
        options.foreignKeys,
      ),
      ...(options.indexes ?? []).map((idx) =>
        buildMssqlCreateIndexSql({ schema: options.schema, table: options.name, ...idx }),
      ),
    ];
    // One transaction (XACT_ABORT rolls back on any error) so a bad index
    // doesn't leave a half-created table behind.
    await this.runQuery(
      c,
      ["SET XACT_ABORT ON;", "BEGIN TRANSACTION;", ...statements, "COMMIT TRANSACTION;"].join("\n"),
    );
  },

  async createIndex(c, options) {
    await this.runQuery(c, buildMssqlCreateIndexSql(options));
  },

  async dropIndex(c, options) {
    // SQL Server indexes are scoped to the table, qualified with the schema.
    if (!options.table) {
      throw new Error("SQL Server: dropIndex requiere `table`");
    }
    await this.runQuery(
      c,
      `DROP INDEX ${ident(options.name)} ON ${ident(options.schema)}.${ident(
        options.table,
      )}`,
    );
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

interface TableFk {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

/** Full T-SQL type from sys.columns / sys.types, e.g. `nvarchar(100)`,
 * `varchar(max)`, `decimal(10,2)`, `datetime2(3)`. */
function mssqlTypeString(col: {
  type_name: string;
  is_user_defined: boolean;
  max_length: number;
  precision: number;
  scale: number;
}): string {
  const t = col.type_name.toLowerCase();
  if (col.is_user_defined) return col.type_name;
  const len = (bytes: number, perChar = 1) => (bytes === -1 ? "max" : String(bytes / perChar));
  switch (t) {
    case "varchar":
    case "char":
    case "varbinary":
    case "binary":
      return `${t}(${len(col.max_length)})`;
    case "nvarchar":
    case "nchar":
      return `${t}(${len(col.max_length, 2)})`;
    case "decimal":
    case "numeric":
      return `${t}(${col.precision},${col.scale})`;
    case "datetime2":
    case "datetimeoffset":
    case "time":
      return `${t}(${col.scale})`;
    default:
      return t;
  }
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
  foreignKeys: CreateTableForeignKey[] | undefined,
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
  for (const fk of foreignKeys ?? []) {
    colLines.push("  " + renderForeignKeyClause("mssql", fk));
  }
  return `CREATE TABLE ${qiCore("mssql", schema)}.${qiCore("mssql", name)} (\n${colLines.join(
    ",\n",
  )}\n);`;
}

function buildMssqlCreateIndexSql(options: CreateIndexOptions): string {
  if (!options.table.trim()) throw new Error("table requerido");
  if (options.columns.length === 0)
    throw new Error("Agregá al menos una columna al índice");
  const unique = options.unique ? "UNIQUE " : "";
  const idxName = (options.name ?? autoIndexName(options.table, options.columns)).trim();
  const fqTable = `${qiCore("mssql", options.schema)}.${qiCore(
    "mssql",
    options.table,
  )}`;
  const cols = options.columns.map((c) => qiCore("mssql", c)).join(", ");
  return `CREATE ${unique}INDEX ${qiCore(
    "mssql",
    idxName,
  )} ON ${fqTable} (${cols});`;
}

export type { IterateTableOptions };
