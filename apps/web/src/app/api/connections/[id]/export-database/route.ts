import type {
  ColumnInfo,
  ExportDatabaseOptions,
  QueryResultColumn,
  RelationInfo,
} from "@data-view/core";
import {
  cellAsSqlLiteral,
  defaultExportFileName,
  exportMimeType,
  quoteIdent,
  quoteString,
} from "@data-view/core";
import type { DatabaseDriver } from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";
import type { DriverAdapter, ResolvedConnection } from "@/server/db/types";
import { primedTextStream } from "@/server/stream";

interface Body {
  options: ExportDatabaseOptions;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as Body;

    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return Response.json({ error: "Not found" }, { status: 404 });

    const adapter = getAdapter(conn.driver);
    const opts = body?.options ?? {};
    const filename = defaultExportFileName(
      conn.database || conn.name,
      "sql",
      conn.driver,
    );

    // The first chunk is produced after resolving every schema's table list,
    // so connection/permission errors come back as a JSON error.
    const stream = await primedTextStream(dumpChunks(adapter, conn, opts));

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": exportMimeType("sql"),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Filename": filename,
      },
    });
  } catch (e) {
    return fail(e);
  }
}

async function* dumpChunks(
  adapter: DriverAdapter,
  conn: ResolvedConnection,
  opts: ExportDatabaseOptions,
): AsyncGenerator<string, void, undefined> {
  // Resolve schema list.
  let targetSchemas = opts.schemas;
  if (!targetSchemas || targetSchemas.length === 0) {
    const all = await adapter.listSchemas(conn);
    targetSchemas = all.filter((s) => !s.isSystem).map((s) => s.name);
  }
  const plan: { schema: string; tables: RelationInfo[] }[] = [];
  for (const schema of targetSchemas) {
    const relations = await adapter.listRelations(conn, schema);
    plan.push({ schema, tables: relations.filter((r) => r.kind === "table") });
  }

  yield `-- Data View dump\n-- driver: ${conn.driver}\n-- generated: ${new Date().toISOString()}\n-- connection: ${conn.name}\n\n`;

  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 100, 1000));
  const q = (s: string) => quoteIdent(conn.driver, s);

  for (const { schema, tables } of plan) {
    if (tables.length === 0) continue;
    yield `-- ────────────────────────────────────────────────\n`;
    yield `-- Schema: ${schema} (${tables.length} tablas)\n`;
    yield `-- ────────────────────────────────────────────────\n\n`;
    // So the dump also restores into an empty server/database.
    if (opts.includeSchema) yield createSchemaIfMissing(conn.driver, schema) + "\n";

    for (const table of tables) {
      const details = await adapter.describeTable(conn, table.schema, table.name);
      const cols: ColumnInfo[] = details.columns;
      const qCols: QueryResultColumn[] = cols.map((c) => ({
        name: c.name,
        dataType: c.dataType,
      }));
      const tableRef = `${q(table.schema)}.${q(table.name)}`;

      yield `\n-- Table: ${tableRef}\n`;

      if (opts.includeSchema) {
        if (opts.dropIfExists) yield `DROP TABLE IF EXISTS ${tableRef};\n`;
        yield adapter.generateCreateTableSql(conn, table.schema, table.name, cols) + "\n\n";
      }

      if (opts.includeData) {
        const colList = qCols.map((c) => q(c.name)).join(", ");
        let pending: string[] = [];
        const flush = (): string => {
          const out = `INSERT INTO ${tableRef} (${colList}) VALUES\n  ${pending.join(",\n  ")};\n`;
          pending = [];
          return out;
        };
        for await (const batch of adapter.iterateTable(conn, {
          schema: table.schema,
          name: table.name,
          batchSize: 1000,
        })) {
          for (const row of batch.rows) {
            const vals = qCols.map((col, j) =>
              cellAsSqlLiteral(row[j] ?? null, col, conn.driver),
            );
            pending.push(`(${vals.join(", ")})`);
            if (pending.length >= batchSize) yield flush();
          }
        }
        if (pending.length > 0) yield flush();
        yield "\n";
      }
    }
  }

  yield `\n-- End of dump\n`;
}

function createSchemaIfMissing(driver: DatabaseDriver, schema: string): string {
  const id = quoteIdent(driver, schema);
  switch (driver) {
    case "postgres":
      return `CREATE SCHEMA IF NOT EXISTS ${id};`;
    case "mysql":
      return `CREATE DATABASE IF NOT EXISTS ${id};`;
    case "mssql":
      // CREATE SCHEMA must be alone in its batch, hence EXEC.
      return `IF SCHEMA_ID(${quoteString(schema, driver)}) IS NULL EXEC(${quoteString(
        `CREATE SCHEMA ${id}`,
        driver,
      )});`;
  }
}
