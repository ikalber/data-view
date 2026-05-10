import { NextResponse } from "next/server";
import { listTags, saveTag } from "@/server/tags-repo";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";

export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json(listTags(userId));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = await req.json();
    const saved = saveTag(userId, body);
    return NextResponse.json(saved);
  } catch (e) {
    return fail(e);
  }
}
