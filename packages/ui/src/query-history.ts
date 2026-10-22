"use client";

import { useCallback, useEffect, useState } from "react";

export const HISTORY_STORAGE_KEY = "dbview.queryHistory.v1";
export const MAX_HISTORY_ENTRIES = 200;

export type HistoryStatus = "ok" | "error";

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  ranAt: string;
  durationMs?: number;
  rowCount?: number;
  affectedRows?: number | null;
  truncated?: boolean;
  status: HistoryStatus;
  error?: string;
}

export interface RecordEntryInput {
  connectionId: string;
  sql: string;
  durationMs?: number;
  rowCount?: number;
  affectedRows?: number | null;
  truncated?: boolean;
  status: HistoryStatus;
  error?: string;
}

/** Parse the stored JSON, dropping anything malformed. Never throws. */
export function parseHistory(raw: string | null): QueryHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is QueryHistoryEntry =>
        !!e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.connectionId === "string" &&
        typeof e.sql === "string" &&
        typeof e.ranAt === "string" &&
        (e.status === "ok" || e.status === "error"),
    );
  } catch {
    return [];
  }
}

function readAll(): QueryHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return parseHistory(window.localStorage.getItem(HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeAll(entries: QueryHistoryEntry[]) {
  if (typeof window === "undefined") return;
  // When storage is full (big scripts, saved SQL files…) drop the oldest half
  // and retry instead of silently never recording history again.
  let list = entries;
  for (;;) {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
      break;
    } catch {
      if (list.length <= 1) return;
      list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
  try {
    // Notify listeners in the same tab — `storage` only fires cross-tab.
    window.dispatchEvent(new CustomEvent("dbview:history-changed"));
  } catch {
    /* ignore */
  }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function recordHistoryEntry(input: RecordEntryInput): QueryHistoryEntry {
  const entry: QueryHistoryEntry = {
    id: makeId(),
    connectionId: input.connectionId,
    sql: input.sql,
    ranAt: new Date().toISOString(),
    durationMs: input.durationMs,
    rowCount: input.rowCount,
    affectedRows: input.affectedRows ?? null,
    truncated: input.truncated,
    status: input.status,
    error: input.error,
  };
  const next = [entry, ...readAll()].slice(0, MAX_HISTORY_ENTRIES);
  writeAll(next);
  return entry;
}

export function useQueryHistory() {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>(() => readAll());

  useEffect(() => {
    const sync = () => setEntries(readAll());
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_STORAGE_KEY) sync();
    };
    window.addEventListener("dbview:history-changed", sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("dbview:history-changed", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const remove = useCallback((id: string) => {
    writeAll(readAll().filter((e) => e.id !== id));
  }, []);

  const clear = useCallback((connectionId?: string) => {
    if (!connectionId) {
      writeAll([]);
      return;
    }
    writeAll(readAll().filter((e) => e.connectionId !== connectionId));
  }, []);

  return { entries, remove, clear };
}
