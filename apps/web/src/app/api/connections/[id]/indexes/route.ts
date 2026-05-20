import { NextResponse } from "next/server";
import type {
  CreateIndexOptions,
  DropIndexOptions,
} from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

/**
 * Index management endpoint, multiplexed by `action`:
 *   { action: "create", schema, table, name?, columns: string[], unique?: boolean }
 *   { action: "drop",   schema, table?, name }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as { action?: string } & Record<string, unknown>;
    if (!body.action) {
      return NextResponse.json({ error: "action es requerido" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const adapter = getAdapter(conn.driver);
    if (body.action === "create") {
      await adapter.createIndex(conn, body as unknown as CreateIndexOptions);
    } else if (body.action === "drop") {
      await adapter.dropIndex(conn, body as unknown as DropIndexOptions);
    } else {
      return NextResponse.json(
        { error: `action desconocida: ${body.action}` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
