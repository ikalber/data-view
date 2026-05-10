import { NextResponse } from "next/server";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as { sql?: string; params?: unknown[] };
    if (!body.sql || typeof body.sql !== "string") {
      return NextResponse.json({ error: "sql es requerido" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const result = await getAdapter(conn.driver).runQuery(conn, body.sql, body.params);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
