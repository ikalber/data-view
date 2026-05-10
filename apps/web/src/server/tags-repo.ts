import { randomUUID } from "node:crypto";
import type { Tag, TagColor, TagInput } from "@data-view/core";
import { getDb } from "./storage";

interface TagRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  kind: string;
  created_at: string;
}

function rowToPublic(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: (row.color as TagColor) ?? "neutral",
    kind: row.kind === "system" ? "system" : "user",
    createdAt: row.created_at,
  };
}

const SEED_TAGS: { name: string; color: TagColor }[] = [
  { name: "Test", color: "info" },
  { name: "Producción", color: "danger" },
];

/**
 * Seed system tags ("Test", "Producción") for a user the first time we touch
 * their tag list. Idempotent: if any system tag already exists we skip.
 */
export function ensureSeedTags(userId: string): void {
  const db = getDb();
  const existing = db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM tags WHERE user_id = ? AND kind = 'system'",
    )
    .get(userId);
  if (existing && existing.count > 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO tags (id, user_id, name, color, kind, created_at)
     VALUES (?, ?, ?, ?, 'system', ?)`,
  );
  for (const seed of SEED_TAGS) {
    stmt.run(randomUUID(), userId, seed.name, seed.color, now);
  }
}

export function listTags(userId: string): Tag[] {
  ensureSeedTags(userId);
  const rows = getDb()
    .prepare<[string], TagRow>(
      `SELECT * FROM tags WHERE user_id = ?
       ORDER BY (kind = 'system') DESC, name COLLATE NOCASE`,
    )
    .all(userId);
  return rows.map(rowToPublic);
}

export function saveTag(userId: string, input: TagInput): Tag {
  const db = getDb();
  const name = input.name.trim();
  if (!name) throw new Error("El nombre de la etiqueta es obligatorio");
  const color = (input.color ?? "neutral") as TagColor;

  if (input.id) {
    const res = db
      .prepare("UPDATE tags SET name = ?, color = ? WHERE id = ? AND user_id = ?")
      .run(name, color, input.id, userId);
    if (res.changes === 0) throw new Error("Tag not found");
    const updated = db
      .prepare<[string, string], TagRow>(
        "SELECT * FROM tags WHERE id = ? AND user_id = ?",
      )
      .get(input.id, userId);
    if (!updated) throw new Error("Tag not found");
    return rowToPublic(updated);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO tags (id, user_id, name, color, kind, created_at)
     VALUES (?, ?, ?, ?, 'user', ?)`,
  ).run(id, userId, name, color, new Date().toISOString());

  const fresh = db
    .prepare<[string, string], TagRow>(
      "SELECT * FROM tags WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  if (!fresh) throw new Error("Failed to load saved tag");
  return rowToPublic(fresh);
}

export function deleteTag(userId: string, id: string): void {
  const db = getDb();
  const tag = db
    .prepare<[string, string], TagRow>(
      "SELECT * FROM tags WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  if (!tag) return;
  if (tag.kind === "system") {
    throw new Error("No se pueden borrar las etiquetas del sistema");
  }
  db.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").run(id, userId);
}
