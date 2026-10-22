import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_STORAGE_KEY,
  MAX_HISTORY_ENTRIES,
  parseHistory,
  recordHistoryEntry,
} from "./query-history";

/** Minimal localStorage stand-in; `quota` caps the stored JSON length. */
function fakeStorage(quota = Infinity) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > quota) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
}

function stubWindow(storage: ReturnType<typeof fakeStorage>) {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent });
  return dispatchEvent;
}

const stored = (storage: ReturnType<typeof fakeStorage>) =>
  parseHistory(storage.getItem(HISTORY_STORAGE_KEY));

describe("parseHistory", () => {
  it("returns [] for empty, corrupt or non-array JSON", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("")).toEqual([]);
    expect(parseHistory("{not json")).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
  });

  it("drops malformed entries and keeps valid ones", () => {
    const ok = {
      id: "1",
      connectionId: "c",
      sql: "select 1",
      ranAt: "2024-01-01T00:00:00Z",
      status: "ok",
    };
    const raw = JSON.stringify([
      ok,
      null,
      42,
      { ...ok, id: 2 },
      { ...ok, id: "3", status: "weird" },
      { ...ok, id: "4", status: "error", error: "boom" },
    ]);
    expect(parseHistory(raw).map((e) => e.id)).toEqual(["1", "4"]);
  });
});

describe("recordHistoryEntry", () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepends entries and notifies same-tab listeners", () => {
    const dispatch = stubWindow(storage);
    recordHistoryEntry({ connectionId: "c", sql: "select 1", status: "ok" });
    recordHistoryEntry({ connectionId: "c", sql: "select 2", status: "error", error: "x" });
    expect(stored(storage).map((e) => e.sql)).toEqual(["select 2", "select 1"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("recovers from corrupt stored JSON", () => {
    stubWindow(storage);
    storage.setItem(HISTORY_STORAGE_KEY, "]]garbage");
    recordHistoryEntry({ connectionId: "c", sql: "select 1", status: "ok" });
    expect(stored(storage)).toHaveLength(1);
  });

  it(`caps the history at ${MAX_HISTORY_ENTRIES} entries`, () => {
    stubWindow(storage);
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
      recordHistoryEntry({ connectionId: "c", sql: `select ${i}`, status: "ok" });
    }
    const entries = stored(storage);
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(entries[0]!.sql).toBe(`select ${MAX_HISTORY_ENTRIES + 4}`);
  });

  it("drops the oldest entries instead of failing when storage is full", () => {
    // Room for roughly 10 entries.
    const one = JSON.stringify([
      {
        id: "00000000-0000-0000-0000-000000000000",
        connectionId: "c",
        sql: "select 00",
        ranAt: new Date().toISOString(),
        affectedRows: null,
        status: "ok",
      },
    ]).length;
    storage = fakeStorage(one * 10);
    stubWindow(storage);
    for (let i = 0; i < 30; i++) {
      recordHistoryEntry({
        connectionId: "c",
        sql: `select ${String(i).padStart(2, "0")}`,
        status: "ok",
      });
    }
    const entries = stored(storage);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(10);
    // The newest entry always makes it in.
    expect(entries[0]!.sql).toBe("select 29");
  });
});
