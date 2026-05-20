import { NextResponse } from "next/server";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

/**
 * Multiplexed DDL endpoint. The action field selects the operation so we
 * don't have to scatter a /drop-table, /drop-schema, /truncate route each.
 *
 * Body shape:
 *   { action: "drop-table",     schema: string, name: string, cascade?: boolean }
 *   { action: "drop-schema",    name: string, cascade?: boolean }
 *   { action: "truncate-table", schema: string, name: string, cascade?: boolean }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      action?: string;
      schema?: string;
      name?: string;
      cascade?: boolean;
    };
    const action = body.action;
    if (!action) {
      return NextResponse.json({ error: "action es requerido" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const adapter = getAdapter(conn.driver);

    if (action === "drop-table") {
      if (!body.schema || !body.name) {
        return NextResponse.json(
          { error: "schema y name son requeridos" },
          { status: 400 },
        );
      }
      await adapter.dropTable(conn, body.schema, body.name, {
        cascade: body.cascade,
      });
    } else if (action === "drop-schema") {
      if (!body.name) {
        return NextResponse.json({ error: "name es requerido" }, { status: 400 });
      }
      await adapter.dropSchema(conn, body.name, { cascade: body.cascade });
    } else if (action === "truncate-table") {
      if (!body.schema || !body.name) {
        return NextResponse.json(
          { error: "schema y name son requeridos" },
          { status: 400 },
        );
      }
      await adapter.truncateTable(conn, body.schema, body.name, {
        cascade: body.cascade,
      });
    } else {
      return NextResponse.json(
        { error: `action desconocida: ${action}` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
