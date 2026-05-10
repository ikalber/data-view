import { NextResponse } from "next/server";
import { deleteConnection, getConnection } from "@/server/connections-repo";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const conn = getConnection(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(conn);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    deleteConnection(userId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
