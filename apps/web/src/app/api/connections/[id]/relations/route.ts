import { NextResponse } from "next/server";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const schema = url.searchParams.get("schema") ?? undefined;
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const rels = await getAdapter(conn.driver).listRelations(conn, schema);
    return NextResponse.json(rels);
  } catch (e) {
    return fail(e);
  }
}
