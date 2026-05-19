import type {
  ExportTableOptions,
  QueryResultColumn,
} from "@data-view/core";
import {
  defaultExportFileName,
  exportMimeType,
  formatBatchBody,
  formatBatchPostlude,
  formatBatchPrelude,
  formatBatchSeparator,
} from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

interface Body {
  schema: string;
  name: string;
  options: ExportTableOptions;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as Body;
    if (!body?.schema || !body?.name || !body?.options?.format) {
      return Response.json(
        { error: "schema, name y options.format son requeridos" },
        { status: 400 },
      );
    }

    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return Response.json({ error: "Not found" }, { status: 404 });

    const adapter = getAdapter(conn.driver);
    const format = body.options.format;
    const filename = defaultExportFileName(body.name, format, conn.driver);
    const formatOpts = {
      format,
      driver: conn.driver,
      schema: body.schema,
      table: body.name,
      includeHeader: body.options.includeHeader !== false,
      batchSize: body.options.batchSize,
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let columns: QueryResultColumn[] | null = null;
        let firstBatch = true;
        try {
          for await (const batch of adapter.iterateTable(conn, {
            schema: body.schema,
            name: body.name,
            where: body.options.where,
            batchSize: 1000,
          })) {
            if (!columns) {
              columns = batch.columns;
              const prelude = formatBatchPrelude(columns, formatOpts);
              if (prelude) controller.enqueue(encoder.encode(prelude));
            }
            if (batch.rows.length === 0) continue;
            const chunk = formatBatchBody(batch.rows, columns, formatOpts);
            if (!firstBatch) {
              controller.enqueue(encoder.encode(formatBatchSeparator(formatOpts)));
            }
            controller.enqueue(encoder.encode(chunk));
            firstBatch = false;
          }
          if (!columns) {
            // Empty table — still emit a valid empty file.
            const pre = formatBatchPrelude([], formatOpts);
            if (pre) controller.enqueue(encoder.encode(pre));
          }
          const post = formatBatchPostlude(formatOpts);
          if (post) controller.enqueue(encoder.encode(post));
          controller.close();
        } catch (e) {
          // Once headers are sent we can't change status — append a comment
          // so the partial file is at least self-describing.
          try {
            controller.enqueue(
              encoder.encode(
                `\n-- export failed: ${e instanceof Error ? e.message : String(e)}\n`,
              ),
            );
          } catch {}
          controller.error(e);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": exportMimeType(format),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Filename": filename,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
