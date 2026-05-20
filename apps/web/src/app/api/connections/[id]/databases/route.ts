import { NextResponse } from "next/server";
import type { CreateSchemaOptions } from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as Partial<CreateSchemaOptions>;
    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name es requerido" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await getAdapter(conn.driver).createSchema(conn, body as CreateSchemaOptions);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
