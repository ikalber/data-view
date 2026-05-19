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
} from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

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

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const write = (s: string) => controller.enqueue(encoder.encode(s));
        try {
          // Header block.
          write(
            `-- Data View dump\n-- driver: ${conn.driver}\n-- generated: ${new Date().toISOString()}\n-- connection: ${conn.name}\n\n`,
          );

          // Resolve schema list.
          let targetSchemas = opts.schemas;
          if (!targetSchemas || targetSchemas.length === 0) {
            const all = await adapter.listSchemas(conn);
            targetSchemas = all.filter((s) => !s.isSystem).map((s) => s.name);
          }

          const batchSize = Math.max(1, Math.min(opts.batchSize ?? 100, 1000));

          for (const schema of targetSchemas) {
            const relations = await adapter.listRelations(conn, schema);
            const tables = relations.filter((r: RelationInfo) => r.kind === "table");
            if (tables.length === 0) continue;
            write(`-- ────────────────────────────────────────────────\n`);
            write(`-- Schema: ${schema} (${tables.length} tablas)\n`);
            write(`-- ────────────────────────────────────────────────\n\n`);

            for (const table of tables) {
              const details = await adapter.describeTable(
                conn,
                table.schema,
                table.name,
              );
              const cols: ColumnInfo[] = details.columns;
              const qCols: QueryResultColumn[] = cols.map((c) => ({
                name: c.name,
                dataType: c.dataType,
              }));

              write(`\n-- Table: ${quoteIdent(conn.driver, table.schema)}.${quoteIdent(conn.driver, table.name)}\n`);

              if (opts.includeSchema) {
                if (opts.dropIfExists) {
                  write(
                    `DROP TABLE IF EXISTS ${quoteIdent(conn.driver, table.schema)}.${quoteIdent(
                      conn.driver,
                      table.name,
                    )};\n`,
                  );
                }
                const ddl = adapter.generateCreateTableSql(
                  conn,
                  table.schema,
                  table.name,
                  cols,
                );
                write(ddl + "\n\n");
              }

              if (opts.includeData) {
                const tableRef = `${quoteIdent(conn.driver, table.schema)}.${quoteIdent(
                  conn.driver,
                  table.name,
                )}`;
                const colList = qCols
                  .map((c) => quoteIdent(conn.driver, c.name))
                  .join(", ");
                let pendingBatch: string[] = [];
                const flush = () => {
                  if (pendingBatch.length === 0) return;
                  write(
                    `INSERT INTO ${tableRef} (${colList}) VALUES\n  ${pendingBatch.join(
                      ",\n  ",
                    )};\n`,
                  );
                  pendingBatch = [];
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
                    pendingBatch.push(`(${vals.join(", ")})`);
                    if (pendingBatch.length >= batchSize) flush();
                  }
                }
                flush();
                write("\n");
              }
            }
          }

          write(`\n-- End of dump\n`);
          controller.close();
        } catch (e) {
          try {
            write(
              `\n-- DUMP FAILED: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          } catch {}
          controller.error(e);
        }
      },
    });

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
