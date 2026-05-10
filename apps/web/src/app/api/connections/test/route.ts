import { NextResponse } from "next/server";
import type { ConnectionInput, DatabaseDriver } from "@data-view/core";
import { requireUserId } from "@/server/session";
import { fail } from "@/server/respond";
import { getConnectionWithSecret } from "@/server/connections-repo";
import { getAdapter } from "@/server/db";

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const input = (await req.json()) as ConnectionInput;
    const driver = input.driver as DatabaseDriver;

    let resolved;
    if (input.id && (!input.password || input.password.length === 0)) {
      // Test against the saved record (password lives only on the server).
      resolved = getConnectionWithSecret(userId, input.id);
      if (!resolved) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    } else {
      resolved = {
        ...input,
        id: input.id ?? "draft",
        ssl: !!input.ssl,
        options: input.options ?? {},
        password: input.password ?? "",
        folderId: input.folderId ?? null,
        tagIds: input.tagIds ?? [],
        createdAt: "",
        updatedAt: "",
      };
    }

    const result = await getAdapter(driver).testConnection(resolved);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
