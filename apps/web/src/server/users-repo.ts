import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./storage";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export function findUserByEmail(email: string): UserRow | null {
  return (
    getDb()
      .prepare<[string], UserRow>("SELECT * FROM users WHERE email = ?")
      .get(email.toLowerCase()) ?? null
  );
}

export function findUserById(id: string): AuthUser | null {
  const row =
    getDb().prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?").get(id) ?? null;
  return row ? { id: row.id, email: row.email } : null;
}

export async function createUser(email: string, password: string): Promise<AuthUser> {
  const normalized = email.toLowerCase().trim();
  if (findUserByEmail(normalized)) {
    throw new Error("Ese email ya está registrado");
  }
  const id = randomUUID();
  const hash = await bcrypt.hash(password, 10);
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
    .run(id, normalized, hash);
  return { id, email: normalized };
}

export async function verifyUser(email: string, password: string): Promise<AuthUser | null> {
  const row = findUserByEmail(email);
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  return ok ? { id: row.id, email: row.email } : null;
}
