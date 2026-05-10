import { NextResponse } from "next/server";
import { z } from "zod";
import { createUser } from "@/server/users-repo";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "La contraseña tiene que tener al menos 8 caracteres"),
});

export async function POST(req: Request) {
  if (process.env.ALLOW_SIGNUP === "false") {
    return NextResponse.json({ error: "Registro deshabilitado" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  try {
    const user = await createUser(parsed.data.email, parsed.data.password);
    return NextResponse.json({ id: user.id, email: user.email });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error" },
      { status: 400 },
    );
  }
}
