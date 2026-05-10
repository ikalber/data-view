import { NextResponse } from "next/server";
import { deleteTag } from "@/server/tags-repo";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    deleteTag(userId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
