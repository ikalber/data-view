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
    const schema = url.searchParams.get("schema");
    const name = url.searchParams.get("name");
    if (!schema || !name) {
      return NextResponse.json({ error: "schema y name son requeridos" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const details = await getAdapter(conn.driver).describeTable(conn, schema, name);
    return NextResponse.json(details);
  } catch (e) {
    return fail(e);
  }
}
