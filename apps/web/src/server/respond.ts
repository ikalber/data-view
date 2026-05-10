import { NextResponse } from "next/server";
import { UnauthorizedError } from "./session";

export function fail(e: unknown, fallbackStatus = 500): NextResponse {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : String(e) },
    { status: fallbackStatus },
  );
}
