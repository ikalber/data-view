import { NextResponse } from "next/server";
import type { PageOptions } from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      schema: string;
      name: string;
      options?: PageOptions;
    };
    if (!body.schema || !body.name) {
      return NextResponse.json({ error: "schema y name son requeridos" }, { status: 400 });
    }
    const conn = getConnectionWithSecret(userId, id);
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const result = await getAdapter(conn.driver).fetchTableData(
      conn,
      body.schema,
      body.name,
      body.options,
    );
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
