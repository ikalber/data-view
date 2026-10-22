"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ConnectionConfig,
  Folder,
  SchemaInfo,
  Tag,
} from "@data-view/core";
import {
  generateDeleteSql,
  generateFullTableDDL,
  generateInsertSql,
  generateSelectSql,
  generateUpdateSql,
} from "@data-view/core";
import type { TabGroup } from "./workspace-tab";
import { useTransport } from "../transport-context";
import { useIsomorphicLayoutEffect } from "../use-isomorphic-layout-effect";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionOverviewPane } from "./ConnectionOverviewPane";
import { CreateDatabaseModal } from "./CreateDatabaseModal";
import { CreateTableModal } from "./CreateTableModal";
import { HistoryPane } from "./HistoryPane";
import { ManageConnectionsModal } from "./ManageConnectionsModal";
import { OverviewPane } from "./OverviewPane";
import { QueryEditor, type SavedFile } from "./QueryEditor";
import { SchemaDiagramPane } from "./SchemaDiagramPane";
import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { TablePane } from "./TablePane";
import { Topbar } from "./Topbar";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import {
  tabIdentityKey,
  type WorkspaceTab,
} from "./workspace-tab";
import {
  assignTabToGroup,
  closeTabs,
  expandGroupOf,
  focusAfterCollapse,
  isSqlTabDirty,
  moveTab,
  pruneGroups,
  restoreWorkspace,
  ungroupTab,
  type DropPlace,
} from "./workspace-state";

interface Props {
  /** Right-side slot in the topbar (user menu, sign-out link, etc). */
  userArea?: ReactNode;
  /**
   * Si está activo, Ctrl/Cmd+W cierra la pestaña activa.
   * Solo tiene sentido en desktop: en el navegador, ese atajo cierra la
   * pestaña del browser y no puede interceptarse de forma confiable.
   */
  enableCloseTabShortcut?: boolean;
  /**
   * When provided, the "Abrir .sql" action calls this picker — the desktop
   * wires it to the Tauri file dialog + a Rust read_text_file command. When
   * omitted (web), AppShell falls back to a hidden `<input type="file">` and
   * reads the file via FileReader.
   */
  onPickSqlFile?: () => Promise<{ name: string; sql: string } | null>;
  /** App version shown in the sidebar footer (e.g. "1.1.1"). Hidden when
   * omitted. */
  appVersion?: string;
}

const TABS_KEY = (id: string) => `dbview.workspaceTabs.${id}`;
const ACTIVE_KEY = (id: string) => `dbview.workspaceActiveTab.${id}`;
const FILES_KEY = (id: string) => `dbview.sqlFiles.${id}`;
const GROUPS_KEY = (id: string) => `dbview.tabGroups.${id}`;
// Last active connection, so a reload reopens the workspace the user was on.
const ACTIVE_CONNECTION_KEY = "dbview.activeConnection";
const SIDEBAR_WIDTH_KEY = "dbview.sidebarWidth";
// Mínimo: bajo eso la lista de tablas pierde legibilidad. Máximo: más de eso
// roba demasiado al área de trabajo en pantallas chicas.
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 520;
const SIDEBAR_WIDTH_DEFAULT = 264;
const GLOBAL_TREE_KEY = "dbview.globalTreeView";
// Same cap the desktop picker enforces; bigger files freeze the editor.
const MAX_SQL_FILE_BYTES = 16 * 1024 * 1024;

function readInitialGlobalTreeView(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(GLOBAL_TREE_KEY) === "1";
  } catch {
    return false;
  }
}

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

function stripSqlExt(name: string): string {
  return name.replace(/\.sql$/i, "");
}

function untitledSqlName(tabs: WorkspaceTab[]): string {
  const taken = new Set(
    tabs.filter((t) => t.kind === "sql").map((t) => (t as { title: string }).title),
  );
  let n = 1;
  while (taken.has(`Sin título ${n}`)) n++;
  return `Sin título ${n}`;
}

export function AppShell({
  userArea,
  enableCloseTabShortcut,
  onPickSqlFile,
  appVersion,
}: Props) {
  const transport = useTransport();
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [manageRefreshToken, setManageRefreshToken] = useState(0);
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
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_WIDTH_DEFAULT);
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [showCreateTable, setShowCreateTable] = useState<string | null>(null);
  const [dropDbName, setDropDbName] = useState<string | null>(null);
  const [dropDbCascade, setDropDbCascade] = useState(false);
  const [dropTableTarget, setDropTableTarget] = useState<
    { schema: string; name: string } | null
  >(null);
  const [dropTableCascade, setDropTableCascade] = useState(false);
  const [truncateTarget, setTruncateTarget] = useState<
    { schema: string; name: string } | null
  >(null);
  const [truncateCascade, setTruncateCascade] = useState(false);
  const [deleteConnectionId, setDeleteConnectionId] = useState<string | null>(
    null,
  );
  /** Bumped whenever a schema/table is created so the Sidebar's effects
   * re-fetch schemas/relations without us having to plumb a callback through
   * its internals. The Sidebar keys its useEffect deps on `connectionId` and
   * `activeSchema`; we leverage a noop schema bounce here instead. */
  const [sidebarRefreshToken, setSidebarRefreshToken] = useState(0);

  // Hidratar el ancho del sidebar desde localStorage al montar. Se hace en un
  // efecto (en vez de en el initializer del useState) para no romper SSR.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n)) {
        const clamped = Math.min(
          SIDEBAR_WIDTH_MAX,
          Math.max(SIDEBAR_WIDTH_MIN, n),
        );
        setSidebarWidth(clamped);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleSidebarWidthChange = useCallback((next: number) => {
    setSidebarWidth(next);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    } catch {
      /* ignore */
    }
  }, []);

  // Global tree view: ignores the active connection and lets the user navigate
  // every connection's databases/tables from the sidebar at once.
  // Starts false and is read from localStorage after mount: reading it in the
  // useState initializer made the web's SSR markup differ from the client's
  // first render (hydration error).
  const [globalTreeView, setGlobalTreeView] = useState(false);

  useIsomorphicLayoutEffect(() => {
    if (readInitialGlobalTreeView()) setGlobalTreeView(true);
  }, []);

  const toggleGlobalTreeView = useCallback(() => {
    const next = !globalTreeView;
    setGlobalTreeView(next);
    try {
      window.localStorage.setItem(GLOBAL_TREE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [globalTreeView]);

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
      // Keep the active connection only while it still exists (it may have
      // been deleted elsewhere); otherwise fall back to the last one used,
      // then to the first one.
      setActiveId((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        const last = readJSON<unknown>(ACTIVE_CONNECTION_KEY, null);
        if (typeof last === "string" && list.some((c) => c.id === last)) return last;
        return list[0]?.id ?? null;
      });
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

  useEffect(() => {
    if (activeId) writeJSON(ACTIVE_CONNECTION_KEY, activeId);
  }, [activeId]);

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
      setError(null);
      return;
    }
    // Storage may hold data from older versions or be corrupt; restore it
    // defensively instead of trusting the shape.
    const restored = restoreWorkspace(
      {
        tabs: readJSON<unknown>(TABS_KEY(activeId), []),
        activeTabId: readJSON<unknown>(ACTIVE_KEY(activeId), null),
        groups: readJSON<unknown>(GROUPS_KEY(activeId), []),
        files: readJSON<unknown>(FILES_KEY(activeId), []),
      },
      uid,
    );
    setTabs(restored.tabs);
    setActiveTabId(restored.activeTabId);
    setFiles(restored.files);
    setGroups(restored.groups);
    setSchemas([]);
    setActiveSchema(null);
    // Errors belong to the previous connection.
    setError(null);
    setHydratedFor(activeId);
  }, [activeId]);

  // Until the hydration effect above has run for the current connection,
  // `tabs`/`activeSchema` still belong to the previous one. Rendering them
  // against the new connection fired queries for the old tables/schemas on
  // the new server, so the workspace waits for this flag.
  const hydrated = activeId !== null && hydratedFor === activeId;

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
    () => (hydrated ? tabs.find((t) => t.id === activeTabId) ?? null : null),
    [hydrated, tabs, activeTabId],
  );

  // Groups without members are dropped whatever emptied them (closing tabs,
  // moving the last tab elsewhere, …) so they don't linger in "Agregar a
  // grupo".
  // Keyed on group membership only: depending on `tabs` ran this on every
  // keystroke in a SQL tab, and the extra state update per keystroke piled up
  // with CodeMirror's synchronous dispatches into "Maximum update depth
  // exceeded" while typing fast.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const usedGroupIds = useMemo(
    () =>
      Array.from(new Set(tabs.map((t) => t.groupId).filter(Boolean)))
        .sort()
        .join("\u0001"),
    [tabs],
  );
  useEffect(() => {
    if (!hydrated) return;
    setGroups((gs) => pruneGroups(gs, tabsRef.current));
  }, [hydrated, usedGroupIds]);

  // Focusing a tab that sits inside a collapsed group (e.g. clicking in the
  // sidebar a table whose tab is grouped) expands the group, so the active
  // tab is never invisible in the tab bar.
  useEffect(() => {
    if (!hydrated) return;
    setGroups((gs) => expandGroupOf(gs, tabs, activeTabId));
    // Only on focus changes: collapsing the active tab's group on purpose
    // (when there's nothing else to focus) must stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, activeTabId]);

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

  /** Open a tab, focusing the existing one when its identity matches.
   *
   * Preview semantics (VS Code-style):
   * - `opts.preview = true`: open as a preview tab. If a preview tab already
   *   exists, REPLACE it in place (same slot/group), so single-clicking
   *   different items in the sidebar swaps the preview without piling up tabs.
   * - `opts.preview = false` (default): open as a regular pinned tab.
   *
   * If the requested item already has an existing tab (non-sql identity), we
   * just focus it. We additionally pin the existing tab when the caller asked
   * for a pinned open — e.g., double-clicking a sidebar item already in
   * preview should keep it open. */
  const openTab = useCallback(
    (
      tab: DistributiveOmit<WorkspaceTab, "id">,
      opts?: { preview?: boolean },
    ) => {
      const preview = opts?.preview ?? false;
      const newTab = {
        ...tab,
        id: uid(),
        isPreview: preview,
      } as WorkspaceTab;
      const key = tabIdentityKey(newTab);
      if (newTab.kind !== "sql") {
        const existing = tabs.find((t) => tabIdentityKey(t) === key);
        if (existing) {
          setActiveTabId(existing.id);
          if (!preview && existing.isPreview) {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === existing.id ? { ...t, isPreview: false } : t,
              ),
            );
          }
          return;
        }
      }
      if (preview) {
        setTabs((prev) => {
          const previewIdx = prev.findIndex((t) => t.isPreview);
          if (previewIdx < 0) return [...prev, newTab];
          // Inherit the slot's groupId so the swap stays inside the same group.
          const replaced = prev[previewIdx]!;
          const next = [...prev];
          next[previewIdx] = { ...newTab, groupId: replaced.groupId ?? null };
          return next;
        });
      } else {
        setTabs((prev) => [...prev, newTab]);
      }
      setActiveTabId(newTab.id);
    },
    [tabs],
  );

  /** Pin a tab (clears its preview flag). Called when the user signals intent
   * to keep the tab around — edits, double-click on the tab, drag, etc. */
  const pinTab = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id && t.isPreview ? { ...t, isPreview: false } : t,
      ),
    );
  }, []);

  /** Close tabs without asking (callers handle confirmation). Focus moves to
   * the nearest visible tab; emptied groups are pruned by the effect above. */
  const closeTabIds = useCallback(
    (ids: string[]) => {
      const next = closeTabs({ tabs, activeTabId }, ids, groups, uid);
      if (next.tabs !== tabs) setTabs(next.tabs);
      if (next.activeTabId !== activeTabId) setActiveTabId(next.activeTabId);
    },
    [tabs, activeTabId, groups],
  );

  const closeTab = useCallback(
    (id: string) => {
      const target = tabs.find((t) => t.id === id);
      if (!target) return;
      if (target.kind === "sql" && isSqlTabDirty(target, files)) {
        const ok = window.confirm(
          `Tenés cambios sin guardar en "${target.title}". ¿Cerrar igual?`,
        );
        if (!ok) return;
      }
      closeTabIds([id]);
    },
    [closeTabIds, files, tabs],
  );

  // Ctrl/Cmd+W para cerrar la pestaña activa (solo desktop). En navegador no
  // se habilita porque el atajo lo captura el browser antes que el webview.
  useEffect(() => {
    if (!enableCloseTabShortcut) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key !== "w" && e.key !== "W") return;
      if (!activeTabId) return;
      e.preventDefault();
      closeTab(activeTabId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableCloseTabShortcut, activeTabId, closeTab]);

  // ── Tab groups ─────────────────────────────────────────────────────────────
  // Group members must stay contiguous (the tab bar renders one header per
  // run of tabs); the helpers in workspace-state take care of that.

  const addTabToGroup = useCallback((tabId: string, groupId: string) => {
    setTabs((prev) => assignTabToGroup(prev, tabId, groupId));
  }, []);

  const createGroupFromTab = useCallback((tabId: string, name: string) => {
    const id = uid();
    setGroups((gs) => [...gs, { id, name, collapsed: false }]);
    setTabs((prev) => assignTabToGroup(prev, tabId, id));
  }, []);

  const removeTabFromGroup = useCallback((tabId: string) => {
    setTabs((prev) => ungroupTab(prev, tabId));
  }, []);

  /** Drag & drop reorder from the tab bar. */
  const reorderTab = useCallback(
    (dragId: string, targetId: string, place: DropPlace) => {
      setTabs((prev) => moveTab(prev, dragId, targetId, place));
    },
    [],
  );

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
      const willCollapse =
        groups.find((g) => g.id === groupId)?.collapsed === false;
      if (!willCollapse) return;
      const fallback = focusAfterCollapse(tabs, groups, activeTabId, groupId);
      if (fallback) setActiveTabId(fallback);
    },
    [groups, activeTabId, tabs],
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
      const dirty = groupTabs.filter((t) => isSqlTabDirty(t, files)).length;
      const ok = window.confirm(
        `¿Cerrar ${groupTabs.length} pestaña${
          groupTabs.length === 1 ? "" : "s"
        } del grupo "${group?.name ?? ""}"?${
          dirty > 0
            ? `\n\n${dirty} ${
                dirty === 1 ? "tiene" : "tienen"
              } cambios sin guardar que se van a perder.`
            : ""
        }`,
      );
      if (!ok) return;
      closeTabIds(groupTabs.map((t) => t.id));
    },
    [groups, tabs, files, closeTabIds],
  );

  const openSql = useCallback(
    (
      seed?: string,
      opts?: { database?: string | null; title?: string },
    ) => {
      const newId = uid();
      setTabs((prev) => [
        ...prev,
        {
          id: newId,
          kind: "sql",
          title: opts?.title ?? untitledSqlName(prev),
          sql: seed ?? "",
          fileId: null,
          database:
            opts?.database !== undefined ? opts.database : activeSchema,
        },
      ]);
      setActiveTabId(newId);
    },
    [activeSchema],
  );

  // ── Open .sql from disk ────────────────────────────────────────────────────
  // Desktop wires `onPickSqlFile` to a Tauri dialog + Rust read_text_file
  // command. In the browser we lazy-create a hidden `<input type="file">` so
  // the user picks via the OS dialog and FileReader gives us the contents.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () => () => {
      fileInputRef.current?.remove();
      fileInputRef.current = null;
    },
    [],
  );
  const openSqlFromDisk = useCallback(async () => {
    try {
      if (onPickSqlFile) {
        const picked = await onPickSqlFile();
        if (!picked) return;
        openSql(picked.sql, { title: stripSqlExt(picked.name) });
        return;
      }
      // Fallback path: hidden <input type="file"> for the web app.
      const input =
        fileInputRef.current ?? document.createElement("input");
      input.type = "file";
      input.accept = ".sql,text/plain";
      input.style.display = "none";
      if (!fileInputRef.current) {
        document.body.appendChild(input);
        fileInputRef.current = input;
      }
      const file = await new Promise<File | null>((resolve) => {
        input.value = "";
        input.onchange = () => {
          const f = input.files?.[0] ?? null;
          resolve(f);
        };
        // Dismissing the picker fires `cancel` (no `change`); without this the
        // promise stayed pending forever.
        input.oncancel = () => resolve(null);
        input.click();
      });
      if (!file) return;
      if (file.size > MAX_SQL_FILE_BYTES) {
        setError(
          `"${file.name}" pesa ${(file.size / 1024 / 1024).toFixed(1)} MB; el máximo para abrir en el editor es 16 MB.`,
        );
        return;
      }
      const sql = await file.text();
      openSql(sql, { title: stripSqlExt(file.name) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onPickSqlFile, openSql]);

  const openTable = useCallback(
    (schema: string, name: string, opts?: { preview?: boolean }) => {
      openTab({ kind: "table", schema, name }, opts);
      setActiveSchema(schema);
    },
    [openTab],
  );

  // Fetches the table's column metadata and opens a SQL editor tab seeded
  // with the requested DML skeleton. Right-click → Generar X in the sidebar
  // routes through here. `connId` comes from the clicked item, which in the
  // global tree may belong to a connection that isn't active yet.
  const generateSqlFor = useCallback(
    async (
      connId: string,
      schema: string,
      name: string,
      kind: "select" | "insert" | "update" | "delete" | "ddl",
    ) => {
      try {
        const details = await transport.describeTable(connId, schema, name);
        const cols = details.columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          isPrimaryKey: c.isPrimaryKey,
        }));
        const driver = connections.find((c) => c.id === connId)?.driver ?? null;
        let text: string;
        switch (kind) {
          case "select":
            text = generateSelectSql(driver, schema, name, cols);
            break;
          case "insert":
            text = generateInsertSql(driver, schema, name, cols);
            break;
          case "update":
            text = generateUpdateSql(driver, schema, name, cols);
            break;
          case "delete":
            text = generateDeleteSql(driver, schema, name, cols);
            break;
          case "ddl":
            // generateFullTableDDL needs the actual driver to quote
            // identifiers correctly — fall back to "postgres" rules when the
            // driver lookup fails, since they're the most permissive.
            text = generateFullTableDDL(driver ?? "postgres", details);
            break;
        }
        // Target the table's schema explicitly: when the action came from
        // another connection in the global tree, this callback's
        // `activeSchema` still belongs to the previous connection.
        openSql(text, { title: `${name}.${kind}`, database: schema });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport, connections, openSql],
  );

  // When the user clicks an item in the global tree that belongs to a DIFFERENT
  // connection, we (a) switch the active connection and (b) enqueue the open
  // until the new connection's tabs have been hydrated. Otherwise the tab
  // would be written to localStorage for the *previous* connection.
  const [pendingOpen, setPendingOpen] = useState<
    | {
        kind: "table";
        connId: string;
        schema: string;
        name: string;
        preview: boolean;
      }
    | { kind: "database"; connId: string; schema: string; preview: boolean }
    | null
  >(null);

  const openTableInConnection = useCallback(
    (
      connId: string,
      schema: string,
      name: string,
      opts?: { preview?: boolean },
    ) => {
      if (connId === activeId) {
        openTable(schema, name, opts);
        return;
      }
      setPendingOpen({
        kind: "table",
        connId,
        schema,
        name,
        preview: opts?.preview ?? false,
      });
      setActiveId(connId);
    },
    [activeId, openTable],
  );

  const openDatabase = useCallback(
    (schema: string, opts?: { preview?: boolean }) => {
      openTab({ kind: "database-overview", schema }, opts);
      setActiveSchema(schema);
    },
    [openTab],
  );

  const openDatabaseInConnection = useCallback(
    (connId: string, schema: string, opts?: { preview?: boolean }) => {
      if (connId === activeId) {
        openDatabase(schema, opts);
        return;
      }
      setPendingOpen({
        kind: "database",
        connId,
        schema,
        preview: opts?.preview ?? false,
      });
      setActiveId(connId);
    },
    [activeId, openDatabase],
  );

  // Flush a pending cross-connection open once hydration of the target
  // connection finishes (so the new tab lands in the right localStorage slot).
  useEffect(() => {
    if (!pendingOpen) return;
    if (hydratedFor !== pendingOpen.connId) return;
    if (pendingOpen.kind === "table") {
      const { schema, name, preview } = pendingOpen;
      openTab({ kind: "table", schema, name }, { preview });
      setActiveSchema(schema);
    } else {
      const { schema, preview } = pendingOpen;
      openTab({ kind: "database-overview", schema }, { preview });
      setActiveSchema(schema);
    }
    setPendingOpen(null);
  }, [pendingOpen, hydratedFor, openTab]);

  const openConnectionOverview = useCallback(
    (opts?: { preview?: boolean }) => {
      openTab({ kind: "connection-overview" }, opts);
    },
    [openTab],
  );

  const openSchemaDiagram = useCallback(
    (opts?: { preview?: boolean }) => {
      openTab({ kind: "schema", schema: activeSchema }, opts);
    },
    [openTab, activeSchema],
  );

  const openHistory = useCallback(
    (opts?: { preview?: boolean }) => {
      openTab({ kind: "history" }, opts);
    },
    [openTab],
  );

  const updateTabSql = useCallback((id: string, sql: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id && t.kind === "sql"
          ? // Typing/editing is the canonical "interaction" that pins a
            // preview tab — once you put work into it, we don't want a stray
            // sidebar click to swap it out from under you.
            { ...t, sql, isPreview: false }
          : t,
      ),
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
    (file: SavedFile, opts?: { preview?: boolean }) => {
      const preview = opts?.preview ?? false;
      const existing = tabs.find(
        (t) => t.kind === "sql" && t.fileId === file.id,
      );
      if (existing) {
        setActiveTabId(existing.id);
        if (!preview && existing.isPreview) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === existing.id ? { ...t, isPreview: false } : t,
            ),
          );
        }
        return;
      }
      const newId = uid();
      const fileTab: WorkspaceTab = {
        id: newId,
        kind: "sql",
        title: file.name,
        sql: file.sql,
        fileId: file.id,
        database: activeSchema,
        isPreview: preview,
      };
      if (preview) {
        setTabs((prev) => {
          const previewIdx = prev.findIndex((t) => t.isPreview);
          if (previewIdx < 0) return [...prev, fileTab];
          const replaced = prev[previewIdx]!;
          const next = [...prev];
          next[previewIdx] = { ...fileTab, groupId: replaced.groupId ?? null };
          return next;
        });
      } else {
        setTabs((prev) => [...prev, fileTab]);
      }
      setActiveTabId(newId);
    },
    [activeSchema, tabs],
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
    for (const t of tabs) if (isSqlTabDirty(t, files)) set.add(t.id);
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
            onOpenSqlEditor={() =>
              openSql(`-- ${tab.schema}\n`, { database: tab.schema })
            }
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
            onOpenInSqlEditor={(sql) => openSql(sql, { database: tab.schema })}
            onAfterDrop={() => {
              setSidebarRefreshToken((n) => n + 1);
              closeTab(tab.id);
            }}
            onAfterTruncate={() =>
              setSidebarRefreshToken((n) => n + 1)
            }
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
            onOpenLocalFile={openSqlFromDisk}
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
        globalTreeView={globalTreeView}
        onToggleGlobalTreeView={toggleGlobalTreeView}
        rightSlot={userArea}
      />
      <div
        className="dv-app-body"
        style={{ ["--dv-sidebar-width" as string]: `${sidebarWidth}px` }}
      >
        <Sidebar
          connectionId={activeId}
          driver={active?.driver ?? null}
          activeTab={activeTab}
          // Withheld until hydrated: right after a switch it's still the
          // previous connection's schema.
          activeSchema={hydrated ? activeSchema : null}
          onChangeSchema={changeSchema}
          onSchemasLoaded={handleSchemasLoaded}
          onOpenTable={openTable}
          onOpenDatabase={openDatabase}
          onOpenConnectionOverview={openConnectionOverview}
          onOpenSql={() => openSql()}
          onOpenSchema={openSchemaDiagram}
          onOpenHistory={openHistory}
          globalTreeView={globalTreeView}
          connections={connections}
          folders={folders}
          tags={tags}
          onSelectConnection={selectConnection}
          onOpenTableInConnection={openTableInConnection}
          onOpenDatabaseInConnection={openDatabaseInConnection}
          onCreateDatabase={active ? () => setShowCreateDb(true) : undefined}
          onCreateTable={
            active
              ? (schema) => setShowCreateTable(schema ?? activeSchema ?? null)
              : undefined
          }
          onDropDatabase={
            active
              ? (name) => {
                  setDropDbCascade(false);
                  setDropDbName(name);
                }
              : undefined
          }
          onDropTable={
            active
              ? (schemaName, name) => {
                  setDropTableCascade(false);
                  setDropTableTarget({ schema: schemaName, name });
                }
              : undefined
          }
          onTruncateTable={
            active
              ? (schemaName, name) => {
                  setTruncateCascade(false);
                  setTruncateTarget({ schema: schemaName, name });
                }
              : undefined
          }
          onGenerateSql={
            active
              ? (schemaName, name, kind, connId) =>
                  void generateSqlFor(
                    connId ?? active.id,
                    schemaName,
                    name,
                    kind,
                  )
              : undefined
          }
          onEditConnection={(id) => {
            setEditingConnectionId(id);
            setShowForm(true);
          }}
          onDeleteConnection={(id) => setDeleteConnectionId(id)}
          refreshToken={sidebarRefreshToken}
          appVersion={appVersion}
        />
        <SidebarResizer
          width={sidebarWidth}
          onChange={handleSidebarWidthChange}
          defaultWidth={SIDEBAR_WIDTH_DEFAULT}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
        />
        <main className="dv-main">
          {/* e.g. listConnections failing (server down, expired session):
              without this the user only saw "Creá una conexión". */}
          {!active && error && (
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          )}
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
          {active && hydrated && (
            <>
              <WorkspaceTabBar
                tabs={tabs}
                groups={groups}
                activeTabId={activeTabId}
                dirtyTabIds={dirtyTabIds}
                onActivate={setActiveTabId}
                onClose={closeTab}
                onPinTab={pinTab}
                onNewSql={() => openSql()}
                onCreateGroupFromTab={createGroupFromTab}
                onAddTabToGroup={addTabToGroup}
                onRemoveTabFromGroup={removeTabFromGroup}
                onRenameGroup={renameGroup}
                onToggleGroupCollapsed={toggleGroupCollapsed}
                onDissolveGroup={dissolveGroup}
                onCloseGroup={closeGroup}
                onMoveTab={reorderTab}
              />
              {error && (
                <ErrorBanner error={error} onDismiss={() => setError(null)} />
              )}
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
      {showManage && (
        <ManageConnectionsModal
          onClose={() => setShowManage(false)}
          onChanged={refresh}
          onEditConnection={(id) => {
            setEditingConnectionId(id);
            setShowForm(true);
          }}
          refreshToken={manageRefreshToken}
          escapeEnabled={!showForm}
        />
      )}
      {/* Rendered after the manage modal so when both are open the form
          stacks visually on top. */}
      {showCreateDb && active && (
        <CreateDatabaseModal
          connection={active}
          onClose={() => setShowCreateDb(false)}
          onCreated={(name) => {
            setShowCreateDb(false);
            setSidebarRefreshToken((n) => n + 1);
            setActiveSchema(name);
            openDatabase(name, { preview: false });
          }}
        />
      )}
      {showCreateTable !== null && active && (
        <CreateTableModal
          connection={active}
          schemas={schemas}
          initialSchema={showCreateTable}
          onClose={() => setShowCreateTable(null)}
          onCreated={({ schema, name }) => {
            setShowCreateTable(null);
            setSidebarRefreshToken((n) => n + 1);
            setActiveSchema(schema);
            openTable(schema, name, { preview: false });
          }}
        />
      )}
      {dropDbName && active && (
        <ConfirmDialog
          title={`DROP ${active.driver === "mysql" ? "DATABASE" : "SCHEMA"} ${dropDbName}`}
          message={
            <>
              Esto borra <strong>todo el contenido</strong> de{" "}
              <code>{dropDbName}</code>. La acción no se puede deshacer.
            </>
          }
          confirmText={dropDbName}
          confirmLabel={`DROP ${active.driver === "mysql" ? "database" : "schema"}`}
          destructive
          toggle={
            active.driver === "postgres"
              ? {
                  label: "CASCADE",
                  checked: dropDbCascade,
                  onChange: setDropDbCascade,
                  hint: "Borra también todo objeto que dependa de este schema.",
                }
              : undefined
          }
          onCancel={() => {
            setDropDbName(null);
            setDropDbCascade(false);
          }}
          onConfirm={async () => {
            await transport.dropSchema(active.id, dropDbName, {
              cascade: dropDbCascade,
            });
            // If the dropped schema is the one currently selected, clear it
            // so the workspace doesn't try to load tables from a dead schema.
            if (activeSchema === dropDbName) setActiveSchema(null);
            // Its table/overview/diagram tabs would only show errors now.
            const dead = tabs
              .filter(
                (t) =>
                  (t.kind === "table" ||
                    t.kind === "database-overview" ||
                    t.kind === "schema") &&
                  t.schema === dropDbName,
              )
              .map((t) => t.id);
            if (dead.length > 0) closeTabIds(dead);
            setDropDbName(null);
            setDropDbCascade(false);
            setSidebarRefreshToken((n) => n + 1);
          }}
        />
      )}
      {truncateTarget && active && (
        <ConfirmDialog
          title={`TRUNCATE ${truncateTarget.schema}.${truncateTarget.name}`}
          message={
            <>
              Esto borra <strong>todas las filas</strong> manteniendo la
              estructura. La acción no se puede deshacer.
            </>
          }
          confirmText={truncateTarget.name}
          confirmLabel="TRUNCATE table"
          destructive
          toggle={
            active.driver === "postgres"
              ? {
                  label: "CASCADE",
                  checked: truncateCascade,
                  onChange: setTruncateCascade,
                  hint: "Truncar también las tablas referenciadas por FK.",
                }
              : undefined
          }
          onCancel={() => {
            setTruncateTarget(null);
            setTruncateCascade(false);
          }}
          onConfirm={async () => {
            const target = truncateTarget;
            await transport.truncateTable(active.id, target.schema, target.name, {
              cascade: truncateCascade,
            });
            setTruncateTarget(null);
            setTruncateCascade(false);
            setSidebarRefreshToken((n) => n + 1);
          }}
        />
      )}
      {dropTableTarget && active && (
        <ConfirmDialog
          title={`DROP TABLE ${dropTableTarget.schema}.${dropTableTarget.name}`}
          message={
            <>
              Esto borra <strong>la tabla y todos sus datos</strong>. La acción
              no se puede deshacer.
            </>
          }
          confirmText={dropTableTarget.name}
          confirmLabel="DROP table"
          destructive
          toggle={
            active.driver === "postgres"
              ? {
                  label: "CASCADE",
                  checked: dropTableCascade,
                  onChange: setDropTableCascade,
                  hint: "Borra también views/FKs que dependan de esta tabla.",
                }
              : undefined
          }
          onCancel={() => {
            setDropTableTarget(null);
            setDropTableCascade(false);
          }}
          onConfirm={async () => {
            const target = dropTableTarget;
            await transport.dropTable(active.id, target.schema, target.name, {
              cascade: dropTableCascade,
            });
            // Close the corresponding tab if it's open.
            const open = tabs.find(
              (t) =>
                t.kind === "table" &&
                t.schema === target.schema &&
                t.name === target.name,
            );
            if (open) closeTab(open.id);
            setDropTableTarget(null);
            setDropTableCascade(false);
            setSidebarRefreshToken((n) => n + 1);
          }}
        />
      )}
      {deleteConnectionId && (() => {
        const target = connections.find((c) => c.id === deleteConnectionId);
        if (!target) {
          // La conexión ya no está (la borraron desde otro lado); cerramos.
          return null;
        }
        return (
          <ConfirmDialog
            title={`Eliminar conexión ${target.name}`}
            message={
              <>
                Esto borra la conexión <strong>{target.name}</strong> y sus
                pestañas / archivos SQL guardados localmente. No toca la base
                de datos remota.
              </>
            }
            confirmText={target.name}
            confirmLabel="Eliminar"
            destructive
            onCancel={() => setDeleteConnectionId(null)}
            onConfirm={async () => {
              await transport.deleteConnection(target.id);
              // Limpiar storage local de esa conexión para no dejar basura.
              if (typeof window !== "undefined") {
                try {
                  window.localStorage.removeItem(TABS_KEY(target.id));
                  window.localStorage.removeItem(ACTIVE_KEY(target.id));
                  window.localStorage.removeItem(FILES_KEY(target.id));
                  window.localStorage.removeItem(GROUPS_KEY(target.id));
                } catch {
                  /* ignore */
                }
              }
              if (activeId === target.id) {
                setActiveId(null);
              }
              setDeleteConnectionId(null);
              await refresh();
            }}
          />
        );
      })()}
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
            const wasEditing = editingConnectionId !== null;
            setShowForm(false);
            setEditingConnectionId(null);
            await refresh();
            // The manage modal keeps its own copy of the connections.
            if (showManage) setManageRefreshToken((n) => n + 1);
            // Only switch to the saved connection when creating a brand-new
            // one; editing (from the sidebar or from "Gestionar conexiones")
            // keeps the user where they were.
            if (!wasEditing) {
              setActiveId(id);
            } else if (id === activeId) {
              // Host/database/credentials may have changed: the sidebar keys
              // its fetches on the connection id, so force a reload.
              setSidebarRefreshToken((n) => n + 1);
            }
          }}
        />
      )}
    </div>
  );
}

function ErrorBanner({
  error,
  onDismiss,
}: {
  error: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="dv-error"
      role="alert"
      style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
    >
      <span style={{ flex: 1 }}>{error}</span>
      <button
        type="button"
        className="dv-icon-button"
        onClick={onDismiss}
        aria-label="Cerrar error"
        title="Cerrar"
      >
        ✕
      </button>
    </div>
  );
}
