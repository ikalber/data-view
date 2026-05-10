import { randomUUID } from "node:crypto";
import type {
  ConnectionConfig,
  ConnectionInput,
  TagColor,
} from "@data-view/core";
import { getDb } from "./storage";
import { decryptSecret, encryptSecret } from "./crypto";
import { ensureSeedTags } from "./tags-repo";

interface ConnectionRow {
  id: string;
  user_id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password_cipher: string | null;
  ssl: number;
  options_json: string;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPublic(row: ConnectionRow, tagIds: string[]): ConnectionConfig {
  return {
    id: row.id,
    name: row.name,
    driver: row.driver as ConnectionConfig["driver"],
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    ssl: !!row.ssl,
    options: row.options_json ? JSON.parse(row.options_json) : {},
    folderId: row.folder_id,
    tagIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadTagIds(connectionIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (connectionIds.length === 0) return map;
  const placeholders = connectionIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare<string[], { connection_id: string; tag_id: string }>(
      `SELECT connection_id, tag_id FROM connection_tags WHERE connection_id IN (${placeholders})`,
    )
    .all(...connectionIds);
  for (const r of rows) {
    const list = map.get(r.connection_id) ?? [];
    list.push(r.tag_id);
    map.set(r.connection_id, list);
  }
  return map;
}

function replaceTags(connectionId: string, tagIds: string[]) {
  const db = getDb();
  db.prepare("DELETE FROM connection_tags WHERE connection_id = ?").run(
    connectionId,
  );
  if (tagIds.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)",
  );
  for (const tagId of tagIds) stmt.run(connectionId, tagId);
}

export function listConnections(userId: string): ConnectionConfig[] {
  ensureSeedTags(userId);
  const rows = getDb()
    .prepare<[string], ConnectionRow>(
      "SELECT * FROM connections WHERE user_id = ? ORDER BY name",
    )
    .all(userId);
  const tagMap = loadTagIds(rows.map((r) => r.id));
  return rows.map((r) => rowToPublic(r, tagMap.get(r.id) ?? []));
}

export function getConnection(userId: string, id: string): ConnectionConfig | null {
  const row = getDb()
    .prepare<[string, string], ConnectionRow>(
      "SELECT * FROM connections WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  if (!row) return null;
  const tagIds = loadTagIds([row.id]).get(row.id) ?? [];
  return rowToPublic(row, tagIds);
}

/** Server-side variant that includes the decrypted password (never sent to UI). */
export function getConnectionWithSecret(
  userId: string,
  id: string,
): (ConnectionConfig & { password: string }) | null {
  const row = getDb()
    .prepare<[string, string], ConnectionRow>(
      "SELECT * FROM connections WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  if (!row) return null;
  const tagIds = loadTagIds([row.id]).get(row.id) ?? [];
  return {
    ...rowToPublic(row, tagIds),
    password: row.password_cipher ? decryptSecret(row.password_cipher) : "",
  };
}

export function saveConnection(userId: string, input: ConnectionInput): ConnectionConfig {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const passwordCipher =
    input.password && input.password.length > 0 ? encryptSecret(input.password) : null;
  const folderId = normalizeFolderId(userId, input.folderId ?? null);
  const tagIds = normalizeTagIds(userId, input.tagIds ?? []);

  const txn = db.transaction(() => {
    if (input.id) {
      // If password is empty on update, keep the existing one.
      const stmt = passwordCipher
        ? db.prepare(
            `UPDATE connections SET name=?, driver=?, host=?, port=?, database=?, username=?, password_cipher=?, ssl=?, options_json=?, folder_id=?, updated_at=?
             WHERE id=? AND user_id=?`,
          )
        : db.prepare(
            `UPDATE connections SET name=?, driver=?, host=?, port=?, database=?, username=?, ssl=?, options_json=?, folder_id=?, updated_at=?
             WHERE id=? AND user_id=?`,
          );

      if (passwordCipher) {
        stmt.run(
          input.name,
          input.driver,
          input.host,
          input.port,
          input.database,
          input.username,
          passwordCipher,
          input.ssl ? 1 : 0,
          JSON.stringify(input.options ?? {}),
          folderId,
          now,
          id,
          userId,
        );
      } else {
        stmt.run(
          input.name,
          input.driver,
          input.host,
          input.port,
          input.database,
          input.username,
          input.ssl ? 1 : 0,
          JSON.stringify(input.options ?? {}),
          folderId,
          now,
          id,
          userId,
        );
      }
    } else {
      db.prepare(
        `INSERT INTO connections
         (id, user_id, name, driver, host, port, database, username, password_cipher, ssl, options_json, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        input.name,
        input.driver,
        input.host,
        input.port,
        input.database,
        input.username,
        passwordCipher,
        input.ssl ? 1 : 0,
        JSON.stringify(input.options ?? {}),
        folderId,
        now,
        now,
      );
    }
    replaceTags(id, tagIds);
  });
  txn();

  const fresh = getConnection(userId, id);
  if (!fresh) throw new Error("Failed to load saved connection");
  return fresh;
}

export function deleteConnection(userId: string, id: string): void {
  getDb().prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").run(id, userId);
}

/**
 * Reassign every connection in a folder back to "no folder" — used by the
 * folder repo before deleting a folder so we don't leave dangling FKs.
 */
export function unparentConnections(userId: string, folderId: string): void {
  getDb()
    .prepare(
      "UPDATE connections SET folder_id = NULL, updated_at = ? WHERE folder_id = ? AND user_id = ?",
    )
    .run(new Date().toISOString(), folderId, userId);
}

function normalizeFolderId(userId: string, folderId: string | null): string | null {
  if (!folderId) return null;
  const exists = getDb()
    .prepare<[string, string], { id: string }>(
      "SELECT id FROM folders WHERE id = ? AND user_id = ?",
    )
    .get(folderId, userId);
  return exists ? folderId : null;
}

function normalizeTagIds(userId: string, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare<string[], { id: string }>(
      `SELECT id FROM tags WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...ids);
  const valid = new Set(rows.map((r) => r.id));
  // Keep order from input, drop unknowns, dedupe.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (valid.has(id) && !seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  return result;
}

// Re-export the color type so callers don't need a deeper import.
export type { TagColor };
