/**
 * Pure helpers for the per-connection workspace (tabs, tab groups, saved SQL
 * files). AppShell owns the React state; everything here is side-effect free
 * so it can be unit-tested without a DOM.
 *
 * Invariants the tab bar relies on (and these helpers preserve):
 *  - tab ids are unique, and non-SQL tabs are unique per identity key;
 *  - at most one tab is a preview;
 *  - the members of a group sit next to each other (one header per group);
 *  - every group has at least one member.
 */
import type { SavedFile } from "./QueryEditor";
import { tabIdentityKey, type TabGroup, type WorkspaceTab } from "./workspace-tab";

export type DropPlace = "before" | "after";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Rebuild one persisted tab, dropping anything that doesn't match the
 * current shape (older versions, hand-edited storage). Null = unusable. */
export function sanitizeTab(raw: unknown): WorkspaceTab | null {
  if (!isRecord(raw) || !nonEmptyString(raw.id)) return null;
  const base = {
    id: raw.id,
    groupId: nonEmptyString(raw.groupId) ? raw.groupId : null,
    isPreview: raw.isPreview === true,
  };
  switch (raw.kind) {
    case "connection-overview":
      return { ...base, kind: "connection-overview" };
    case "history":
      return { ...base, kind: "history" };
    case "database-overview":
      return typeof raw.schema === "string"
        ? { ...base, kind: "database-overview", schema: raw.schema }
        : null;
    case "table":
      return typeof raw.schema === "string" && typeof raw.name === "string"
        ? { ...base, kind: "table", schema: raw.schema, name: raw.name }
        : null;
    case "schema":
      return {
        ...base,
        kind: "schema",
        schema: typeof raw.schema === "string" ? raw.schema : null,
      };
    case "sql":
      return {
        ...base,
        kind: "sql",
        title:
          typeof raw.title === "string" && raw.title.trim()
            ? raw.title
            : "Sin título",
        sql: typeof raw.sql === "string" ? raw.sql : "",
        fileId: nonEmptyString(raw.fileId) ? raw.fileId : null,
        database: typeof raw.database === "string" ? raw.database : null,
      };
    default:
      return null;
  }
}

export function sanitizeTabs(raw: unknown): WorkspaceTab[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const identities = new Set<string>();
  let hasPreview = false;
  const out: WorkspaceTab[] = [];
  for (const item of raw) {
    const tab = sanitizeTab(item);
    if (!tab || ids.has(tab.id)) continue;
    // openTab focuses "the" tab for an identity, so duplicates would be
    // unreachable zombies.
    const key = tabIdentityKey(tab);
    if (identities.has(key)) continue;
    ids.add(tab.id);
    identities.add(key);
    if (tab.isPreview) {
      if (hasPreview) tab.isPreview = false;
      else hasPreview = true;
    }
    out.push(tab);
  }
  return out;
}

export function sanitizeGroups(raw: unknown): TabGroup[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TabGroup[] = [];
  for (const g of raw) {
    if (!isRecord(g) || !nonEmptyString(g.id) || seen.has(g.id)) continue;
    seen.add(g.id);
    const group: TabGroup = {
      id: g.id,
      name: typeof g.name === "string" && g.name.trim() ? g.name : "Grupo",
      collapsed: g.collapsed === true,
    };
    if (typeof g.color === "string") group.color = g.color;
    out.push(group);
  }
  return out;
}

export function sanitizeFiles(raw: unknown): SavedFile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedFile[] = [];
  for (const f of raw) {
    if (
      !isRecord(f) ||
      !nonEmptyString(f.id) ||
      seen.has(f.id) ||
      typeof f.name !== "string" ||
      typeof f.sql !== "string"
    ) {
      continue;
    }
    seen.add(f.id);
    out.push({
      id: f.id,
      name: f.name,
      sql: f.sql,
      updatedAt:
        typeof f.updatedAt === "string"
          ? f.updatedAt
          : new Date(0).toISOString(),
    });
  }
  return out;
}

/** True when a SQL tab has content that isn't persisted in a saved file. */
export function isSqlTabDirty(tab: WorkspaceTab, files: SavedFile[]): boolean {
  if (tab.kind !== "sql") return false;
  if (tab.fileId == null) return tab.sql.length > 0;
  const linked = files.find((f) => f.id === tab.fileId);
  return !linked || linked.sql !== tab.sql;
}

/** Pull every group's members up to where the group first appears, keeping
 * relative order. Returns the same array when already contiguous. */
export function normalizeGroupOrder(tabs: WorkspaceTab[]): WorkspaceTab[] {
  const out: WorkspaceTab[] = [];
  const placed = new Set<string>();
  for (const t of tabs) {
    if (!t.groupId) {
      out.push(t);
      continue;
    }
    if (placed.has(t.groupId)) continue;
    placed.add(t.groupId);
    for (const m of tabs) if (m.groupId === t.groupId) out.push(m);
  }
  return out.every((t, i) => t === tabs[i]) ? tabs : out;
}

/** Drop groups without members. Returns the same array when nothing changes. */
export function pruneGroups(groups: TabGroup[], tabs: WorkspaceTab[]): TabGroup[] {
  const used = new Set(tabs.map((t) => t.groupId).filter(Boolean));
  const next = groups.filter((g) => used.has(g.id));
  return next.length === groups.length ? groups : next;
}

/** Expand the group holding `tabId` if it's collapsed, so the active tab is
 * never hidden in the tab bar. Same array when nothing changes. */
export function expandGroupOf(
  groups: TabGroup[],
  tabs: WorkspaceTab[],
  tabId: string | null,
): TabGroup[] {
  const gid = tabs.find((t) => t.id === tabId)?.groupId;
  if (!gid) return groups;
  if (!groups.some((g) => g.id === gid && g.collapsed)) return groups;
  return groups.map((g) => (g.id === gid ? { ...g, collapsed: false } : g));
}

function isHiddenIn(groups: TabGroup[]) {
  const collapsed = new Set(groups.filter((g) => g.collapsed).map((g) => g.id));
  return (t: WorkspaceTab) => !!t.groupId && collapsed.has(t.groupId);
}

/** Closest tab to `fromIdx` (left neighbour first at each distance) that
 * passes `accept`. `fromIdx` may be -1, which scans from the start. */
export function nearestTab(
  tabs: WorkspaceTab[],
  fromIdx: number,
  accept: (t: WorkspaceTab) => boolean,
): string | null {
  for (let d = 1; d <= tabs.length + 1; d++) {
    const left = tabs[fromIdx - d];
    if (left && accept(left)) return left.id;
    const right = tabs[fromIdx + d];
    if (right && accept(right)) return right.id;
  }
  return null;
}

export interface TabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

/** Remove `ids`. When the active tab goes away, focus the nearest remaining
 * tab, preferring ones that are visible (not inside a collapsed group). An
 * emptied workspace falls back to a fresh connection-overview tab. Group
 * cleanup is left to `pruneGroups`. */
export function closeTabs(
  state: TabsState,
  ids: Iterable<string>,
  groups: TabGroup[],
  makeId: () => string,
): TabsState {
  const removed = new Set(ids);
  const next = state.tabs.filter((t) => !removed.has(t.id));
  if (next.length === state.tabs.length) return state;
  if (next.length === 0) {
    const fallback: WorkspaceTab = { id: makeId(), kind: "connection-overview" };
    return { tabs: [fallback], activeTabId: fallback.id };
  }
  if (state.activeTabId && !removed.has(state.activeTabId)) {
    return { tabs: next, activeTabId: state.activeTabId };
  }
  const hidden = isHiddenIn(groups);
  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const activeTabId =
    nearestTab(state.tabs, idx, (t) => !removed.has(t.id) && !hidden(t)) ??
    nearestTab(state.tabs, idx, (t) => !removed.has(t.id)) ??
    next[0]!.id;
  return { tabs: next, activeTabId };
}

/** Tab to focus when collapsing `groupId` hides the active tab, or null when
 * there's nothing visible to move to. */
export function focusAfterCollapse(
  tabs: WorkspaceTab[],
  groups: TabGroup[],
  activeTabId: string | null,
  groupId: string,
): string | null {
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx < 0 || tabs[idx]!.groupId !== groupId) return null;
  const hidden = isHiddenIn(groups);
  return nearestTab(tabs, idx, (t) => t.groupId !== groupId && !hidden(t));
}

/** Take a tab out of its group, placing it right after the group's remaining
 * members so the group stays contiguous. */
export function ungroupTab(tabs: WorkspaceTab[], tabId: string): WorkspaceTab[] {
  const idx = tabs.findIndex((t) => t.id === tabId);
  const tab = tabs[idx];
  if (!tab?.groupId) return tabs;
  const gid = tab.groupId;
  const rest = tabs.filter((t) => t.id !== tabId);
  let lastMember = -1;
  rest.forEach((t, i) => {
    if (t.groupId === gid) lastMember = i;
  });
  const insertAt = lastMember >= 0 ? lastMember + 1 : idx;
  return [
    ...rest.slice(0, insertAt),
    { ...tab, groupId: null },
    ...rest.slice(insertAt),
  ];
}

/** Put a tab into `groupId` (pinning it — grouping is a "keep this" gesture).
 * It leaves its previous group cleanly and lands after the target group's
 * last member; for a group with no members yet it stays where it is. */
export function assignTabToGroup(
  tabs: WorkspaceTab[],
  tabId: string,
  groupId: string,
): WorkspaceTab[] {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.groupId === groupId) return tabs;
  const list = tab.groupId ? ungroupTab(tabs, tabId) : tabs;
  const updated: WorkspaceTab = { ...tab, groupId, isPreview: false };
  const rest = list.filter((t) => t.id !== tabId);
  let lastMember = -1;
  rest.forEach((t, i) => {
    if (t.groupId === groupId) lastMember = i;
  });
  if (lastMember < 0) return list.map((t) => (t.id === tabId ? updated : t));
  return [
    ...rest.slice(0, lastMember + 1),
    updated,
    ...rest.slice(lastMember + 1),
  ];
}

/** Drag & drop reorder: move `dragId` next to `targetId`. The moved tab joins
 * the target's group (so groups stay contiguous) and gets pinned. */
export function moveTab(
  tabs: WorkspaceTab[],
  dragId: string,
  targetId: string,
  place: DropPlace,
): WorkspaceTab[] {
  if (dragId === targetId) return tabs;
  const dragged = tabs.find((t) => t.id === dragId);
  const target = tabs.find((t) => t.id === targetId);
  if (!dragged || !target) return tabs;
  const rest = tabs.filter((t) => t.id !== dragId);
  const targetIdx = rest.findIndex((t) => t.id === targetId);
  const insertAt = place === "before" ? targetIdx : targetIdx + 1;
  const moved: WorkspaceTab = {
    ...dragged,
    groupId: target.groupId ?? null,
    isPreview: false,
  };
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

export interface WorkspaceSnapshot {
  tabs: WorkspaceTab[];
  activeTabId: string;
  groups: TabGroup[];
  files: SavedFile[];
}

/** Build a consistent workspace out of whatever was in localStorage. Bad or
 * outdated data degrades to an Overview tab instead of crashing the shell. */
export function restoreWorkspace(
  raw: { tabs: unknown; activeTabId: unknown; groups: unknown; files: unknown },
  makeId: () => string,
): WorkspaceSnapshot {
  const files = sanitizeFiles(raw.files);
  const fileIds = new Set(files.map((f) => f.id));
  const allGroups = sanitizeGroups(raw.groups);
  const groupIds = new Set(allGroups.map((g) => g.id));
  let tabs = sanitizeTabs(raw.tabs).map((t) => {
    let next = t;
    if (next.groupId && !groupIds.has(next.groupId)) {
      next = { ...next, groupId: null };
    }
    // A tab linked to a file that no longer exists would silently fail to
    // save; unlink it so it shows as unsaved and Ctrl+S asks for a name.
    if (next.kind === "sql" && next.fileId && !fileIds.has(next.fileId)) {
      next = { ...next, fileId: null };
    }
    return next;
  });
  tabs = normalizeGroupOrder(tabs);
  if (tabs.length === 0) tabs = [{ id: makeId(), kind: "connection-overview" }];
  const activeTabId =
    typeof raw.activeTabId === "string" &&
    tabs.some((t) => t.id === raw.activeTabId)
      ? raw.activeTabId
      : tabs[0]!.id;
  const groups = expandGroupOf(pruneGroups(allGroups, tabs), tabs, activeTabId);
  return { tabs, activeTabId, groups, files };
}
