import { randomUUID } from "node:crypto";
import type { Folder, FolderInput, TagColor } from "@data-view/core";
import { getDb } from "./storage";
import { unparentConnections } from "./connections-repo";

interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

function rowToPublic(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name,
    color: (row.color as TagColor) ?? "neutral",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listFolders(userId: string): Folder[] {
  const rows = getDb()
    .prepare<[string], FolderRow>(
      "SELECT * FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE",
    )
    .all(userId);
  return rows.map(rowToPublic);
}

export function saveFolder(userId: string, input: FolderInput): Folder {
  const db = getDb();
  const now = new Date().toISOString();
  const name = input.name.trim();
  if (!name) throw new Error("El nombre de la carpeta es obligatorio");
  const color = (input.color ?? "neutral") as TagColor;

  if (input.id) {
    const res = db
      .prepare(
        "UPDATE folders SET name = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .run(name, color, now, input.id, userId);
    if (res.changes === 0) throw new Error("Folder not found");
    const updated = db
      .prepare<[string, string], FolderRow>(
        "SELECT * FROM folders WHERE id = ? AND user_id = ?",
      )
      .get(input.id, userId);
    if (!updated) throw new Error("Folder not found");
    return rowToPublic(updated);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO folders (id, user_id, name, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, color, now, now);

  const fresh = db
    .prepare<[string, string], FolderRow>(
      "SELECT * FROM folders WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  if (!fresh) throw new Error("Failed to load saved folder");
  return rowToPublic(fresh);
}

export function deleteFolder(userId: string, id: string): void {
  const db = getDb();
  const txn = db.transaction(() => {
    unparentConnections(userId, id);
    db.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId);
  });
  txn();
}
