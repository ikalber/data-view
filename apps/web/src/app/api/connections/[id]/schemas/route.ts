import { NextResponse } from "next/server";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const schemas = await getAdapter(conn.driver).listSchemas(conn);
    return NextResponse.json(schemas);
  } catch (e) {
    return fail(e);
  }
}
