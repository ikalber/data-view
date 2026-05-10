import { NextResponse } from "next/server";
import { listConnections, saveConnection } from "@/server/connections-repo";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";

export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json(listConnections(userId));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = await req.json();
    const saved = saveConnection(userId, body);
    return NextResponse.json(saved);
  } catch (e) {
    return fail(e);
  }
}
