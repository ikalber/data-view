import { describe, expect, it } from "vitest";
import type { TabGroup, WorkspaceTab } from "./workspace-tab";
import {
  assignTabToGroup,
  closeTabs,
  expandGroupOf,
  focusAfterCollapse,
  isSqlTabDirty,
  MAX_PERSISTED_SQL_CHARS,
  moveTab,
  normalizeGroupOrder,
  persistableTabs,
  pruneGroups,
  restoreWorkspace,
  sanitizeFiles,
  sanitizeTabs,
  ungroupTab,
} from "./workspace-state";

function table(id: string, groupId: string | null = null): WorkspaceTab {
  return { id, kind: "table", schema: "public", name: id, groupId };
}

const ids = (tabs: WorkspaceTab[]) => tabs.map((t) => t.id);
const groupsOf = (tabs: WorkspaceTab[]) => tabs.map((t) => t.groupId ?? null);

let counter = 0;
const makeId = () => `new${++counter}`;

describe("sanitizeTabs", () => {
  it("returns [] for non-array / corrupt values", () => {
    expect(sanitizeTabs(null)).toEqual([]);
    expect(sanitizeTabs({})).toEqual([]);
    expect(sanitizeTabs("tabs")).toEqual([]);
  });

  it("drops unknown kinds, malformed tabs and duplicate ids/identities", () => {
    const out = sanitizeTabs([
      { id: "a", kind: "table", schema: "public", name: "users" },
      { id: "a", kind: "history" }, // duplicate id
      { id: "b", kind: "query" }, // kind from an old version
      { id: "c", kind: "table", schema: "public" }, // missing name
      { kind: "history" }, // missing id
      null,
      { id: "d", kind: "table", schema: "public", name: "users" }, // same identity as "a"
      { id: "e", kind: "history" },
    ]);
    expect(ids(out)).toEqual(["a", "e"]);
  });

  it("fills defaults for sql tabs and keeps a single preview", () => {
    const out = sanitizeTabs([
      { id: "s", kind: "sql", sql: 42 },
      { id: "p1", kind: "history", isPreview: true },
      { id: "p2", kind: "connection-overview", isPreview: true },
    ]);
    expect(out[0]).toMatchObject({
      kind: "sql",
      title: "Sin título",
      sql: "",
      fileId: null,
      database: null,
    });
    expect(out.filter((t) => t.isPreview).map((t) => t.id)).toEqual(["p1"]);
  });
});

describe("sanitizeFiles", () => {
  it("keeps only well-formed files", () => {
    const out = sanitizeFiles([
      { id: "f1", name: "a", sql: "select 1", updatedAt: "2024-01-01" },
      { id: "f2", name: "b" }, // no sql
      { id: "f1", name: "dup", sql: "" },
      { id: "f3", name: "c", sql: "" }, // no updatedAt → epoch
    ]);
    expect(out.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(out[1]!.updatedAt).toBe(new Date(0).toISOString());
    expect(sanitizeFiles("garbage")).toEqual([]);
  });
});

describe("isSqlTabDirty", () => {
  const files = [{ id: "f", name: "f", sql: "select 1", updatedAt: "" }];
  it("handles unsaved, saved, modified and orphan tabs", () => {
    const base = { kind: "sql" as const, title: "t", database: null };
    expect(isSqlTabDirty({ ...base, id: "1", sql: "", fileId: null }, files)).toBe(false);
    expect(isSqlTabDirty({ ...base, id: "2", sql: "x", fileId: null }, files)).toBe(true);
    expect(isSqlTabDirty({ ...base, id: "3", sql: "select 1", fileId: "f" }, files)).toBe(false);
    expect(isSqlTabDirty({ ...base, id: "4", sql: "select 2", fileId: "f" }, files)).toBe(true);
    expect(isSqlTabDirty({ ...base, id: "5", sql: "select 1", fileId: "gone" }, files)).toBe(true);
    expect(isSqlTabDirty(table("t"), files)).toBe(false);
  });
});

describe("persistableTabs", () => {
  const sqlTab = (id: string, sql: string): WorkspaceTab => ({
    id,
    kind: "sql",
    title: id,
    sql,
    fileId: null,
    database: null,
  });

  it("returns the same array when nothing is too big", () => {
    const tabs = [table("a"), sqlTab("s", "x".repeat(MAX_PERSISTED_SQL_CHARS))];
    expect(persistableTabs(tabs)).toBe(tabs);
  });

  it("leaves out only the SQL tabs over the limit", () => {
    const tabs = [
      table("a"),
      sqlTab("big", "x".repeat(MAX_PERSISTED_SQL_CHARS + 1)),
      sqlTab("small", "select 1"),
    ];
    expect(ids(persistableTabs(tabs))).toEqual(["a", "small"]);
  });
});

describe("closeTabs", () => {
  const tabs = [table("a"), table("b"), table("c"), table("d")];

  it("activates the left neighbour when closing the active tab", () => {
    const res = closeTabs({ tabs, activeTabId: "c" }, ["c"], [], makeId);
    expect(ids(res.tabs)).toEqual(["a", "b", "d"]);
    expect(res.activeTabId).toBe("b");
  });

  it("activates the right neighbour when closing the first tab", () => {
    const res = closeTabs({ tabs, activeTabId: "a" }, ["a"], [], makeId);
    expect(res.activeTabId).toBe("b");
  });

  it("keeps the active tab when closing another one", () => {
    const res = closeTabs({ tabs, activeTabId: "a" }, ["c"], [], makeId);
    expect(res.activeTabId).toBe("a");
  });

  it("skips tabs hidden inside a collapsed group", () => {
    const grouped = [table("a"), table("b", "g"), table("c", "g"), table("d")];
    const groups: TabGroup[] = [{ id: "g", name: "G", collapsed: true }];
    const res = closeTabs({ tabs: grouped, activeTabId: "d" }, ["d"], groups, makeId);
    expect(res.activeTabId).toBe("a");
  });

  it("falls back to a hidden tab when nothing visible remains", () => {
    const grouped = [table("b", "g"), table("d")];
    const groups: TabGroup[] = [{ id: "g", name: "G", collapsed: true }];
    const res = closeTabs({ tabs: grouped, activeTabId: "d" }, ["d"], groups, makeId);
    expect(res.activeTabId).toBe("b");
  });

  it("closes several tabs at once (e.g. a dropped schema)", () => {
    const res = closeTabs({ tabs, activeTabId: "b" }, ["b", "c"], [], makeId);
    expect(ids(res.tabs)).toEqual(["a", "d"]);
    expect(res.activeTabId).toBe("a");
  });

  it("replaces an emptied workspace with an overview tab", () => {
    const res = closeTabs({ tabs: [table("a")], activeTabId: "a" }, ["a"], [], makeId);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0]!.kind).toBe("connection-overview");
    expect(res.activeTabId).toBe(res.tabs[0]!.id);
  });

  it("is a no-op for unknown ids", () => {
    const state = { tabs, activeTabId: "a" };
    expect(closeTabs(state, ["zzz"], [], makeId)).toBe(state);
  });
});

describe("focusAfterCollapse", () => {
  const tabs = [table("a"), table("b", "g"), table("c", "g"), table("d", "h")];
  it("moves focus out of the collapsing group, skipping other collapsed groups", () => {
    const groups: TabGroup[] = [
      { id: "g", name: "G", collapsed: false },
      { id: "h", name: "H", collapsed: true },
    ];
    expect(focusAfterCollapse(tabs, groups, "c", "g")).toBe("a");
  });
  it("returns null when the active tab isn't in that group", () => {
    expect(focusAfterCollapse(tabs, [], "a", "g")).toBeNull();
  });
});

describe("group membership", () => {
  it("ungroupTab moves the tab after the rest of its group", () => {
    const tabs = [table("a"), table("b", "g"), table("c", "g"), table("d", "g"), table("e")];
    const out = ungroupTab(tabs, "c");
    expect(ids(out)).toEqual(["a", "b", "d", "c", "e"]);
    expect(groupsOf(out)).toEqual([null, "g", "g", null, null]);
    expect(normalizeGroupOrder(out)).toBe(out);
  });

  it("ungroupTab keeps a lone member in place", () => {
    const tabs = [table("a"), table("b", "g"), table("c")];
    expect(ids(ungroupTab(tabs, "b"))).toEqual(["a", "b", "c"]);
  });

  it("assignTabToGroup appends after the group's last member and pins", () => {
    const tabs = [
      table("a", "g"),
      table("b"),
      table("c", "g"),
      { ...table("d"), isPreview: true },
    ];
    // (input deliberately non-contiguous: the tab still lands after the last member)
    const out = assignTabToGroup(tabs, "d", "g");
    expect(ids(out)).toEqual(["a", "b", "c", "d"]);
    expect(out[3]).toMatchObject({ groupId: "g", isPreview: false });
  });

  it("assignTabToGroup out of the middle of another group keeps both contiguous", () => {
    const tabs = [table("a", "h"), table("b", "h"), table("c", "h"), table("x")];
    // New (still empty) group: the tab leaves "h" and stays right after it.
    const out = assignTabToGroup(tabs, "b", "n");
    expect(ids(out)).toEqual(["a", "c", "b", "x"]);
    expect(groupsOf(out)).toEqual(["h", "h", "n", null]);
    expect(normalizeGroupOrder(out)).toBe(out);
  });

  it("normalizeGroupOrder makes split groups contiguous", () => {
    const tabs = [table("a", "g"), table("b"), table("c", "g")];
    expect(ids(normalizeGroupOrder(tabs))).toEqual(["a", "c", "b"]);
  });

  it("pruneGroups drops empty groups and keeps identity otherwise", () => {
    const groups: TabGroup[] = [
      { id: "g", name: "G", collapsed: false },
      { id: "empty", name: "E", collapsed: false },
    ];
    const tabs = [table("a", "g")];
    expect(pruneGroups(groups, tabs).map((g) => g.id)).toEqual(["g"]);
    const kept = [groups[0]!];
    expect(pruneGroups(kept, tabs)).toBe(kept);
  });

  it("expandGroupOf only touches the active tab's collapsed group", () => {
    const groups: TabGroup[] = [{ id: "g", name: "G", collapsed: true }];
    const tabs = [table("a", "g"), table("b")];
    expect(expandGroupOf(groups, tabs, "a")[0]!.collapsed).toBe(false);
    expect(expandGroupOf(groups, tabs, "b")).toBe(groups);
  });
});

describe("moveTab", () => {
  const tabs = [table("a"), table("b"), table("c", "g"), table("d", "g"), table("e")];

  it("moves before/after the target", () => {
    expect(ids(moveTab(tabs, "a", "b", "after"))).toEqual(["b", "a", "c", "d", "e"]);
    expect(ids(moveTab(tabs, "e", "a", "before"))).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("joins the target's group and pins the tab", () => {
    const withPreview = tabs.map((t) => (t.id === "a" ? { ...t, isPreview: true } : t));
    const out = moveTab(withPreview, "a", "d", "after");
    expect(ids(out)).toEqual(["b", "c", "d", "a", "e"]);
    expect(out[3]).toMatchObject({ groupId: "g", isPreview: false });
    expect(normalizeGroupOrder(out)).toBe(out);
  });

  it("leaves the group when dropped on an ungrouped tab", () => {
    const out = moveTab(tabs, "c", "e", "after");
    expect(ids(out)).toEqual(["a", "b", "d", "e", "c"]);
    expect(out[4]!.groupId).toBeNull();
  });

  it("ignores self-drops and unknown ids", () => {
    expect(moveTab(tabs, "a", "a", "before")).toBe(tabs);
    expect(moveTab(tabs, "zzz", "a", "before")).toBe(tabs);
  });
});

describe("restoreWorkspace", () => {
  it("falls back to an overview tab on corrupt storage", () => {
    const ws = restoreWorkspace(
      { tabs: { not: "an array" }, activeTabId: 5, groups: "x", files: null },
      makeId,
    );
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0]!.kind).toBe("connection-overview");
    expect(ws.activeTabId).toBe(ws.tabs[0]!.id);
    expect(ws.groups).toEqual([]);
    expect(ws.files).toEqual([]);
  });

  it("repairs dangling references and restores the active tab", () => {
    const ws = restoreWorkspace(
      {
        tabs: [
          { id: "a", kind: "table", schema: "s", name: "t", groupId: "g" },
          { id: "b", kind: "history", groupId: "missing" },
          { id: "c", kind: "sql", title: "q", sql: "select 1", fileId: "gone", database: null },
          { id: "d", kind: "sql", title: "f", sql: "select 2", fileId: "f1", database: "s" },
          { id: "e", kind: "connection-overview", groupId: "g" },
        ],
        activeTabId: "e",
        groups: [
          { id: "g", name: "G", collapsed: true },
          { id: "orphan", name: "O", collapsed: false },
        ],
        files: [{ id: "f1", name: "f", sql: "select 2", updatedAt: "2024-01-01" }],
      },
      makeId,
    );
    // group "g" made contiguous; "b" lost its unknown group
    expect(ids(ws.tabs)).toEqual(["a", "e", "b", "c", "d"]);
    expect(ws.tabs.find((t) => t.id === "b")!.groupId).toBeNull();
    // orphan group pruned; active tab's group expanded
    expect(ws.groups).toEqual([{ id: "g", name: "G", collapsed: false }]);
    // sql tab pointing at a deleted file becomes unsaved
    expect(ws.tabs.find((t) => t.id === "c")).toMatchObject({ fileId: null });
    expect(ws.tabs.find((t) => t.id === "d")).toMatchObject({ fileId: "f1" });
    expect(ws.activeTabId).toBe("e");
  });

  it("picks the first tab when the stored active id is stale", () => {
    const ws = restoreWorkspace(
      { tabs: [{ id: "a", kind: "history" }], activeTabId: "zzz", groups: [], files: [] },
      makeId,
    );
    expect(ws.activeTabId).toBe("a");
  });
});
