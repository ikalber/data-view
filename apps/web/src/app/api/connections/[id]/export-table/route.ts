import type {
  ExportTableOptions,
  FormatRowsOptions,
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
import type { DriverAdapter, ResolvedConnection } from "@/server/db/types";
import { primedTextStream } from "@/server/stream";

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
    const formatOpts: FormatRowsOptions = {
      format,
      driver: conn.driver,
      schema: body.schema,
      table: body.name,
      includeHeader: body.options.includeHeader !== false,
      batchSize: body.options.batchSize,
    };

    // Throws here (→ JSON error) if the first batch can't be fetched.
    const stream = await primedTextStream(
      exportChunks(adapter, conn, body, formatOpts),
    );

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

async function* exportChunks(
  adapter: DriverAdapter,
  conn: ResolvedConnection,
  body: Body,
  formatOpts: FormatRowsOptions,
): AsyncGenerator<string, void, undefined> {
  let columns: QueryResultColumn[] | null = null;
  let wroteRows = false;
  for await (const batch of adapter.iterateTable(conn, {
    schema: body.schema,
    name: body.name,
    where: body.options.where,
    batchSize: 1000,
  })) {
    if (!columns) {
      columns = batch.columns;
      yield formatBatchPrelude(columns, formatOpts);
    }
    if (batch.rows.length === 0) continue;
    // Driver batches are 1000 rows; for SQL, `batchSize` is the number of
    // rows per INSERT statement (default 100, same as desktop).
    const step =
      formatOpts.format === "sql"
        ? Math.max(1, Math.min(formatOpts.batchSize ?? 100, 1000))
        : batch.rows.length;
    for (let i = 0; i < batch.rows.length; i += step) {
      if (wroteRows) yield formatBatchSeparator(formatOpts);
      yield formatBatchBody(batch.rows.slice(i, i + step), columns, formatOpts);
      wroteRows = true;
    }
  }
  if (!columns) {
    // The driver yielded nothing at all — still emit a valid (empty) file.
    yield formatBatchPrelude([], formatOpts);
  }
  // The trailing newline only makes sense after at least one row.
  if (wroteRows || formatOpts.format === "json") {
    yield formatBatchPostlude(formatOpts);
  }
}
