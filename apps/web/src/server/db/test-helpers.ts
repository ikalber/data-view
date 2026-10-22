// Shared helpers for the driver integration tests (`*.test.ts` next to this
// file). Not imported by production code.
import type { DatabaseDriver } from "@data-view/core";
import type { DriverAdapter, IterateTableOptions, ResolvedConnection, TableBatch } from "./types";

/**
 * Build a `ResolvedConnection` from a URL such as
 * `postgres://user:pass@host:port/db?ssl=true&trustServerCertificate=true`.
 * `ssl` maps to the boolean flag; every other query param lands in `options`.
 */
export function connFromUrl(url: string, driver: DatabaseDriver): ResolvedConnection {
  const u = new URL(url);
  const options: Record<string, string> = {};
  let ssl = false;
  for (const [k, v] of u.searchParams) {
    if (k === "ssl") ssl = v === "true" || v === "1";
    else options[k] = v;
  }
  const now = new Date().toISOString();
  return {
    id: `test-${driver}`,
    name: `test ${driver}`,
    driver,
    host: u.hostname,
    port: Number(u.port),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl,
    options,
    folderId: null,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Drain `iterateTable` into an array of batches. */
export async function collectBatches(
  adapter: DriverAdapter,
  conn: ResolvedConnection,
  opts: IterateTableOptions,
): Promise<TableBatch[]> {
  const out: TableBatch[] = [];
  for await (const b of adapter.iterateTable(conn, opts)) out.push(b);
  return out;
}

/** Placeholder URL so `connFromUrl` doesn't throw while the suite is skipped. */
export const UNUSED_URL = "postgres://unused:unused@127.0.0.1:1/unused";
