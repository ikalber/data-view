"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ConnectionConfig,
  Folder,
  SchemaInfo,
  Tag,
} from "@data-view/core";
import type { TabGroup } from "./workspace-tab";
import { useTransport } from "../transport-context";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionOverviewPane } from "./ConnectionOverviewPane";
import { HistoryPane } from "./HistoryPane";
import { ManageConnectionsModal } from "./ManageConnectionsModal";
import { OverviewPane } from "./OverviewPane";
import { QueryEditor, type SavedFile } from "./QueryEditor";
import { SchemaDiagramPane } from "./SchemaDiagramPane";
import { Sidebar } from "./Sidebar";
import { TablePane } from "./TablePane";
import { Topbar } from "./Topbar";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import {
  tabIdentityKey,
  type WorkspaceTab,
} from "./workspace-tab";

interface Props {
  /** Right-side slot in the topbar (user menu, sign-out link, etc). */
  userArea?: ReactNode;
}

const TABS_KEY = (id: string) => `dbview.workspaceTabs.${id}`;
const ACTIVE_KEY = (id: string) => `dbview.workspaceActiveTab.${id}`;
const FILES_KEY = (id: string) => `dbview.sqlFiles.${id}`;
const GROUPS_KEY = (id: string) => `dbview.tabGroups.${id}`;

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

function untitledSqlName(tabs: WorkspaceTab[]): string {
  const taken = new Set(
    tabs.filter((t) => t.kind === "sql").map((t) => (t as { title: string }).title),
  );
  let n = 1;
  while (taken.has(`Sin título ${n}`)) n++;
  return `Sin título ${n}`;
}

export function AppShell({ userArea }: Props) {
  const transport = useTransport();
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(
    null,
  );
  // Workspace tabs (per-connection).
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [files, setFiles] = useState<SavedFile[]>([]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  // Connection id whose tabs/files have been hydrated. Persist effects gate on
  // this so a stale render right after a connection switch doesn't clobber the
  // new connection's storage.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [activeSchema, setActiveSchema] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, fs, ts] = await Promise.all([
        transport.listConnections(),
        transport.listFolders(),
        transport.listTags(),
      ]);
      setConnections(list);
      setFolders(fs);
      setTags(ts);
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

  // Hydrate tabs/files/groups when the active connection changes.
  useEffect(() => {
    if (!activeId) {
      setTabs([]);
      setActiveTabId(null);
      setFiles([]);
      setGroups([]);
      setSchemas([]);
      setHydratedFor(null);
      setActiveSchema(null);
      return;
    }
    const loadedTabs = readJSON<WorkspaceTab[]>(TABS_KEY(activeId), []);
    const loadedActive = readJSON<string | null>(ACTIVE_KEY(activeId), null);
    const loadedFiles = readJSON<SavedFile[]>(FILES_KEY(activeId), []);
    const loadedGroups = readJSON<TabGroup[]>(GROUPS_KEY(activeId), []);
    if (loadedTabs.length === 0) {
      const t: WorkspaceTab = { id: uid(), kind: "connection-overview" };
      setTabs([t]);
      setActiveTabId(t.id);
    } else {
      setTabs(loadedTabs);
      setActiveTabId(
        loadedActive && loadedTabs.some((t) => t.id === loadedActive)
          ? loadedActive
          : loadedTabs[0]!.id,
      );
    }
    setFiles(loadedFiles);
    setGroups(loadedGroups);
    setSchemas([]);
    setActiveSchema(null);
    setHydratedFor(activeId);
  }, [activeId]);

  // Persist after hydration.
  useEffect(() => {
    if (!activeId || hydratedFor !== activeId) return;
    writeJSON(TABS_KEY(activeId), tabs);
  }, [hydratedFor, activeId, tabs]);
  useEffect(() => {
    if (!activeId || hydratedFor !== activeId || activeTabId == null) return;
    writeJSON(ACTIVE_KEY(activeId), activeTabId);
  }, [hydratedFor, activeId, activeTabId]);
  useEffect(() => {
    if (!activeId || hydratedFor !== activeId) return;
    writeJSON(FILES_KEY(activeId), files);
  }, [hydratedFor, activeId, files]);
  useEffect(() => {
    if (!activeId || hydratedFor !== activeId) return;
    writeJSON(GROUPS_KEY(activeId), groups);
  }, [hydratedFor, activeId, groups]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  // Keep activeSchema in sync with whatever the active tab is targeting, so
  // the sidebar's table list follows the user's focus.
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.kind === "database-overview") {
      setActiveSchema(activeTab.schema);
    } else if (activeTab.kind === "table") {
      setActiveSchema(activeTab.schema);
    } else if (activeTab.kind === "schema" && activeTab.schema) {
      setActiveSchema(activeTab.schema);
    }
  }, [activeTab]);

  // When schemas finish loading, pick a sensible default. This only seeds the
  // sidebar — it doesn't open a tab.
  const handleSchemasLoaded = useCallback(
    (loaded: SchemaInfo[]) => {
      setSchemas(loaded);
      setActiveSchema((current) => {
        if (current && loaded.some((s) => s.name === current)) return current;
        const userSchemas = loaded.filter((s) => !s.isSystem);
        const preferred = active?.database
          ? userSchemas.find((s) => s.name === active.database)
          : null;
        if (preferred) return preferred.name;
        return userSchemas[0]?.name ?? null;
      });
    },
    [active?.database],
  );

  /** Open a tab, focusing the existing one when its identity matches. */
  const openTab = useCallback(
    (tab: DistributiveOmit<WorkspaceTab, "id">) => {
      const newTab = { ...tab, id: uid() } as WorkspaceTab;
      const key = tabIdentityKey(newTab);
      setTabs((prev) => {
        // SQL tabs always create a fresh entry.
        if (newTab.kind !== "sql") {
          const existing = prev.find((t) => tabIdentityKey(t) === key);
          if (existing) {
            setActiveTabId(existing.id);
            return prev;
          }
        }
        setActiveTabId(newTab.id);
        return [...prev, newTab];
      });
    },
    [],
  );

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) return prev;
        const target = prev[idx]!;
        if (target.kind === "sql") {
          const linkedFile = target.fileId
            ? files.find((f) => f.id === target.fileId)
            : null;
          const dirty = target.fileId == null
            ? target.sql.length > 0
            : !linkedFile || linkedFile.sql !== target.sql;
          if (dirty) {
            const ok = window.confirm(
              `Tenés cambios sin guardar en "${target.title}". ¿Cerrar igual?`,
            );
            if (!ok) return prev;
          }
        }
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const t: WorkspaceTab = { id: uid(), kind: "connection-overview" };
          setActiveTabId(t.id);
          return [t];
        }
        if (id === activeTabId) {
          const fallback = next[Math.max(0, idx - 1)] ?? next[0];
          if (fallback) setActiveTabId(fallback.id);
        }
        // Drop a group that no longer has any tab.
        if (target.groupId) {
          const stillUsed = next.some((t) => t.groupId === target.groupId);
          if (!stillUsed) {
            setGroups((gs) => gs.filter((g) => g.id !== target.groupId));
          }
        }
        return next;
      });
    },
    [activeTabId, files],
  );

  // ── Tab groups ─────────────────────────────────────────────────────────────

  /** Move tabs with `tabIds` to live contiguously, in their existing relative
   * order, immediately after the tab at `anchorIdx` (or at the start if -1). */
  function reorderContiguous(
    list: WorkspaceTab[],
    tabIds: Set<string>,
    anchorIdx: number,
  ): WorkspaceTab[] {
    const moving = list.filter((t) => tabIds.has(t.id));
    const remaining = list.filter((t) => !tabIds.has(t.id));
    const insertAt = Math.min(remaining.length, anchorIdx + 1);
    return [
      ...remaining.slice(0, insertAt),
      ...moving,
      ...remaining.slice(insertAt),
    ];
  }

  const addTabToGroup = useCallback(
    (tabId: string, groupId: string) => {
      setTabs((prev) => {
        const updated = prev.map((t) =>
          t.id === tabId ? { ...t, groupId } : t,
        );
        // Place this tab adjacent to its group's other members.
        const groupTabIds = new Set(
          updated.filter((t) => t.groupId === groupId).map((t) => t.id),
        );
        const firstGroupIdx = updated.findIndex(
          (t) => t.groupId === groupId && t.id !== tabId,
        );
        if (firstGroupIdx < 0) return updated;
        const lastGroupIdx = updated
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.groupId === groupId && t.id !== tabId)
          .reduce((acc, x) => Math.max(acc, x.i), -1);
        return reorderContiguous(updated, groupTabIds, lastGroupIdx);
      });
    },
    [],
  );

  const createGroupFromTab = useCallback((tabId: string, name: string) => {
    const id = uid();
    setGroups((gs) => [...gs, { id, name, collapsed: false }]);
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, groupId: id } : t)));
  }, []);

  const removeTabFromGroup = useCallback((tabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target?.groupId) return prev;
      const oldGroupId = target.groupId;
      const updated = prev.map((t) =>
        t.id === tabId ? { ...t, groupId: null } : t,
      );
      const stillUsed = updated.some((t) => t.groupId === oldGroupId);
      if (!stillUsed) {
        setGroups((gs) => gs.filter((g) => g.id !== oldGroupId));
      }
      return updated;
    });
  }, []);

  const renameGroup = useCallback((groupId: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, name } : g)));
  }, []);

  const toggleGroupCollapsed = useCallback(
    (groupId: string) => {
      setGroups((gs) =>
        gs.map((g) =>
          g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
        ),
      );
      // If we're collapsing the group containing the active tab, jump focus to
      // the nearest visible tab so the user doesn't end up looking at an
      // invisible pane.
      setTabs((prev) => {
        const next = prev;
        const willCollapse =
          groups.find((g) => g.id === groupId)?.collapsed === false;
        if (!willCollapse) return next;
        const active = next.find((t) => t.id === activeTabId);
        if (!active || active.groupId !== groupId) return next;
        const fallback = next.find(
          (t) => t.id !== active.id && t.groupId !== groupId,
        );
        if (fallback) setActiveTabId(fallback.id);
        return next;
      });
    },
    [groups, activeTabId],
  );

  const dissolveGroup = useCallback((groupId: string) => {
    setGroups((gs) => gs.filter((g) => g.id !== groupId));
    setTabs((prev) =>
      prev.map((t) => (t.groupId === groupId ? { ...t, groupId: null } : t)),
    );
  }, []);

  const closeGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      const groupTabs = tabs.filter((t) => t.groupId === groupId);
      if (groupTabs.length === 0) return;
      const ok = window.confirm(
        `¿Cerrar ${groupTabs.length} pestaña${
          groupTabs.length === 1 ? "" : "s"
        } del grupo "${group?.name ?? ""}"?`,
      );
      if (!ok) return;
      setTabs((prev) => {
        let next = prev.filter((t) => !groupTabs.some((g) => g.id === t.id));
        if (next.length === 0) {
          const t: WorkspaceTab = { id: uid(), kind: "connection-overview" };
          setActiveTabId(t.id);
          next = [t];
        } else if (groupTabs.some((g) => g.id === activeTabId)) {
          const fallback = next.find((t) => t.groupId !== groupId) ?? next[0];
          if (fallback) setActiveTabId(fallback.id);
        }
        return next;
      });
      setGroups((gs) => gs.filter((g) => g.id !== groupId));
    },
    [groups, tabs, activeTabId],
  );

  const openSql = useCallback(
    (seed?: string, opts?: { database?: string | null }) => {
      setTabs((prev) => {
        const t: WorkspaceTab = {
          id: uid(),
          kind: "sql",
          title: untitledSqlName(prev),
          sql: seed ?? "",
          fileId: null,
          database:
            opts?.database !== undefined ? opts.database : activeSchema,
        };
        setActiveTabId(t.id);
        return [...prev, t];
      });
    },
    [activeSchema],
  );

  const openTable = useCallback(
    (schema: string, name: string) => {
      openTab({ kind: "table", schema, name });
      setActiveSchema(schema);
    },
    [openTab],
  );

  const openDatabase = useCallback(
    (schema: string) => {
      openTab({ kind: "database-overview", schema });
      setActiveSchema(schema);
    },
    [openTab],
  );

  const openConnectionOverview = useCallback(() => {
    openTab({ kind: "connection-overview" });
  }, [openTab]);

  const openSchemaDiagram = useCallback(() => {
    openTab({ kind: "schema", schema: activeSchema });
  }, [openTab, activeSchema]);

  const openHistory = useCallback(() => {
    openTab({ kind: "history" });
  }, [openTab]);

  const updateTabSql = useCallback((id: string, sql: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.kind === "sql" ? { ...t, sql } : t)),
    );
  }, []);

  const updateTabDatabase = useCallback(
    (id: string, database: string | null) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id && t.kind === "sql" ? { ...t, database } : t,
        ),
      );
    },
    [],
  );

  const saveSqlTab = useCallback(
    (info: {
      tabId: string;
      title: string;
      sql: string;
      fileId: string | null;
    }) => {
      const { tabId, title, sql, fileId } = info;
      if (fileId == null) {
        const def = title.startsWith("Sin título") ? "" : title;
        const name = window.prompt("Nombre del archivo:", def);
        if (!name || !name.trim()) return null;
        const trimmed = name.trim();
        const id = uid();
        const file: SavedFile = {
          id,
          name: trimmed,
          sql,
          updatedAt: new Date().toISOString(),
        };
        setFiles((prev) => [file, ...prev]);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId && t.kind === "sql"
              ? { ...t, fileId: id, title: trimmed }
              : t,
          ),
        );
        return { fileId: id, title: trimmed };
      }
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, sql, updatedAt: new Date().toISOString() }
            : f,
        ),
      );
      return { fileId, title };
    },
    [],
  );

  const openSqlFile = useCallback(
    (file: SavedFile) => {
      setTabs((prev) => {
        const existing = prev.find(
          (t) => t.kind === "sql" && t.fileId === file.id,
        );
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        const t: WorkspaceTab = {
          id: uid(),
          kind: "sql",
          title: file.name,
          sql: file.sql,
          fileId: file.id,
          database: activeSchema,
        };
        setActiveTabId(t.id);
        return [...prev, t];
      });
    },
    [activeSchema],
  );

  const deleteSqlFile = useCallback((file: SavedFile) => {
    const ok = window.confirm(`¿Borrar "${file.name}"?`);
    if (!ok) return;
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "sql" && t.fileId === file.id ? { ...t, fileId: null } : t,
      ),
    );
  }, []);

  function selectConnection(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    // hydration effect will reset tabs / activeSchema
  }

  function changeSchema(schema: string) {
    setActiveSchema(schema);
  }

  // Dirty set for tab-bar dots — only SQL tabs can be dirty.
  const dirtyTabIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== "sql") continue;
      if (t.fileId == null) {
        if (t.sql.length > 0) set.add(t.id);
      } else {
        const f = files.find((x) => x.id === t.fileId);
        if (!f || f.sql !== t.sql) set.add(t.id);
      }
    }
    return set;
  }, [tabs, files]);

  function renderTab(tab: WorkspaceTab) {
    if (!active) return null;
    switch (tab.kind) {
      case "connection-overview":
        return (
          <ConnectionOverviewPane
            connection={active}
            onSelectDatabase={openDatabase}
          />
        );
      case "database-overview":
        return (
          <OverviewPane
            connection={active}
            activeSchema={tab.schema}
            onOpenSqlEditor={() => openSql(`-- ${tab.schema}\n`)}
            onOpenTable={openTable}
          />
        );
      case "table":
        return (
          <TablePane
            connectionId={active.id}
            driver={active.driver}
            schema={tab.schema}
            name={tab.name}
            onOpenInSqlEditor={(sql) => openSql(sql)}
          />
        );
      case "schema":
        return (
          <SchemaDiagramPane
            connection={active}
            activeSchema={tab.schema}
            onOpenTable={openTable}
          />
        );
      case "history":
        return (
          <HistoryPane
            connection={active}
            connections={connections}
            onOpenInSqlEditor={(sql) => openSql(sql)}
          />
        );
      case "sql":
        return (
          <QueryEditor
            connectionId={active.id}
            tabId={tab.id}
            sql={tab.sql}
            onChangeSql={(s) => updateTabSql(tab.id, s)}
            title={tab.title}
            fileId={tab.fileId}
            files={files}
            onSave={saveSqlTab}
            onOpenFile={openSqlFile}
            onDeleteFile={deleteSqlFile}
            isActive={tab.id === activeTabId}
            database={tab.database ?? null}
            onChangeDatabase={(d) => updateTabDatabase(tab.id, d)}
            schemas={schemas}
            driver={active.driver}
          />
        );
    }
  }

  return (
    <div className="dv-app">
      <Topbar
        connections={connections}
        folders={folders}
        tags={tags}
        activeId={activeId}
        onSelectConnection={selectConnection}
        onAddConnection={() => {
          setEditingConnectionId(null);
          setShowForm(true);
        }}
        onManageConnections={() => setShowManage(true)}
        rightSlot={userArea}
      />
      <div className="dv-app-body">
        <Sidebar
          connectionId={activeId}
          driver={active?.driver ?? null}
          activeTab={activeTab}
          activeSchema={activeSchema}
          onChangeSchema={changeSchema}
          onSchemasLoaded={handleSchemasLoaded}
          onOpenTable={openTable}
          onOpenDatabase={openDatabase}
          onOpenConnectionOverview={openConnectionOverview}
          onOpenSql={() => openSql()}
          onOpenSchema={openSchemaDiagram}
          onOpenHistory={openHistory}
        />
        <main className="dv-main">
          {!active && (
            <div className="dv-empty">
              Creá una conexión para empezar.
              <div style={{ marginTop: 16 }}>
                <button
                  className="dv-button is-primary"
                  onClick={() => setShowForm(true)}
                >
                  Nueva conexión
                </button>
              </div>
            </div>
          )}
          {active && (
            <>
              <WorkspaceTabBar
                tabs={tabs}
                groups={groups}
                activeTabId={activeTabId}
                dirtyTabIds={dirtyTabIds}
                onActivate={setActiveTabId}
                onClose={closeTab}
                onNewSql={() => openSql()}
                onCreateGroupFromTab={createGroupFromTab}
                onAddTabToGroup={addTabToGroup}
                onRemoveTabFromGroup={removeTabFromGroup}
                onRenameGroup={renameGroup}
                onToggleGroupCollapsed={toggleGroupCollapsed}
                onDissolveGroup={dissolveGroup}
                onCloseGroup={closeGroup}
              />
              {error && <div className="dv-error">{error}</div>}
              <div className="dv-workspace">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className="dv-workspace-pane"
                    hidden={tab.id !== activeTabId}
                  >
                    {renderTab(tab)}
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
      {showForm && (
        <ConnectionForm
          folders={folders}
          tags={tags}
          initial={
            editingConnectionId
              ? connections.find((c) => c.id === editingConnectionId) ??
                undefined
              : undefined
          }
          onCancel={() => {
            setShowForm(false);
            setEditingConnectionId(null);
          }}
          onSaved={async (id) => {
            setShowForm(false);
            setEditingConnectionId(null);
            await refresh();
            setActiveId(id);
          }}
        />
      )}
      {showManage && (
        <ManageConnectionsModal
          onClose={() => setShowManage(false)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
