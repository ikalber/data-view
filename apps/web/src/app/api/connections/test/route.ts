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
    const driver = input?.driver as DatabaseDriver;
    if (!["postgres", "mysql", "mssql"].includes(driver)) {
      return NextResponse.json({ error: `Driver no soportado: ${driver}` }, { status: 400 });
    }

    // Editing a saved connection: the form never carries the stored password,
    // so reuse it when left blank — but test the form's host/port/db/user/ssl,
    // not the saved ones, so "Probar" reflects what the user is about to save.
    let storedPassword = "";
    if (input.id) {
      const saved = getConnectionWithSecret(userId, input.id);
      if (!saved) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      storedPassword = saved.password;
    }
    const resolved = {
      ...input,
      id: input.id ?? "draft",
      ssl: !!input.ssl,
      options: input.options ?? {},
      password: input.password ? input.password : storedPassword,
      folderId: input.folderId ?? null,
      tagIds: input.tagIds ?? [],
      createdAt: "",
      updatedAt: "",
    };

    const result = await getAdapter(driver).testConnection(resolved);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
