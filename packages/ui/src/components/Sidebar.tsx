"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type {
  ConnectionConfig,
  DatabaseDriver,
  Folder,
  RelationInfo,
  SchemaInfo,
  Tag,
} from "@data-view/core";
import { useTransport } from "../transport-context";
import type { WorkspaceTab, WorkspaceTabKind } from "./workspace-tab";

type Mode = "select" | "tree";
const MODE_KEY = "dbview.tablesMode";

interface Props {
  connectionId: string | null;
  driver: DatabaseDriver | null;
  activeTab: WorkspaceTab | null;
  activeSchema: string | null;
  onChangeSchema: (schema: string) => void;
  onSchemasLoaded: (schemas: SchemaInfo[]) => void;
  onOpenTable: (schema: string, name: string) => void;
  onOpenDatabase: (schema: string) => void;
  onOpenConnectionOverview: () => void;
  onOpenSql: () => void;
  onOpenSchema: () => void;
  onOpenHistory: () => void;
  /** When true, replace the schema/tables UI with a cross-connection tree. */
  globalTreeView?: boolean;
  /** All known connections (used by the global tree). */
  connections?: ConnectionConfig[];
  /** All known folders (used by the global tree to group connections). */
  folders?: Folder[];
  /** All known tags (reserved for future surfacing in the global tree). */
  tags?: Tag[];
  /** Switch the active connection from the global tree. */
  onSelectConnection?: (id: string) => void;
  /** Open a table in a (potentially different) connection from the global tree. */
  onOpenTableInConnection?: (
    connectionId: string,
    schema: string,
    name: string,
  ) => void;
}

interface NavItem {
  key: WorkspaceTabKind;
  label: string;
  icon: string;
  onClick: () => void;
}

function readInitialMode(): Mode {
  if (typeof window === "undefined") return "select";
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === "select" || stored === "tree") return stored;
  } catch {
    /* ignore */
  }
  return "select";
}

export function Sidebar({
  connectionId,
  driver,
  activeTab,
  activeSchema,
  onChangeSchema,
  onSchemasLoaded,
  onOpenTable,
  onOpenDatabase,
  onOpenConnectionOverview,
  onOpenSql,
  onOpenSchema,
  onOpenHistory,
  globalTreeView = false,
  connections = [],
  folders = [],
  onSelectConnection,
  onOpenTableInConnection,
}: Props) {
  const transport = useTransport();
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [relations, setRelations] = useState<RelationInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [loadingRelations, setLoadingRelations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => readInitialMode());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeRelations, setTreeRelations] = useState<
    Record<string, RelationInfo[]>
  >({});
  const [loadingSchema, setLoadingSchema] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Global tree state (caches survive across renders while the toggle is on)
  const [globalExpandedConns, setGlobalExpandedConns] = useState<Set<string>>(
    new Set(),
  );
  const [globalExpandedSchemas, setGlobalExpandedSchemas] = useState<
    Set<string>
  >(new Set()); // key: `${connId}|${schema}`
  const [globalSchemaCache, setGlobalSchemaCache] = useState<
    Record<string, SchemaInfo[]>
  >({});
  const [globalRelCache, setGlobalRelCache] = useState<
    Record<string, RelationInfo[]>
  >({});
  const [globalLoadingConn, setGlobalLoadingConn] = useState<Set<string>>(
    new Set(),
  );
  const [globalLoadingSchema, setGlobalLoadingSchema] = useState<Set<string>>(
    new Set(),
  );
  const [globalCollapsedFolders, setGlobalCollapsedFolders] = useState<
    Set<string>
  >(new Set());
  const [globalError, setGlobalError] = useState<Record<string, string>>({});

  const navItems: NavItem[] = useMemo(
    () => [
      {
        key: "connection-overview",
        label: "Overview",
        icon: "▤",
        onClick: onOpenConnectionOverview,
      },
      { key: "sql", label: "SQL Editor", icon: "›_", onClick: onOpenSql },
      { key: "schema", label: "Schema", icon: "◇", onClick: onOpenSchema },
      { key: "history", label: "History", icon: "↻", onClick: onOpenHistory },
    ],
    [onOpenConnectionOverview, onOpenSql, onOpenSchema, onOpenHistory],
  );

  // Persist mode preference
  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // Load list of schemas/databases when connection changes.
  useEffect(() => {
    if (!connectionId) {
      setSchemas([]);
      setRelations([]);
      setTreeRelations({});
      setExpanded(new Set());
      return;
    }
    let cancel = false;
    setLoadingSchemas(true);
    setError(null);
    transport
      .listSchemas(connectionId)
      .then((s) => {
        if (cancel) return;
        setSchemas(s);
        onSchemasLoaded(s);
      })
      .catch(
        (e) => !cancel && setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => !cancel && setLoadingSchemas(false));
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, transport]);

  // Reset cached tree relations when connection changes.
  useEffect(() => {
    setTreeRelations({});
    setExpanded(new Set());
  }, [connectionId]);

  // Load tables for the active schema (used by select mode and to highlight
  // the active table in tree mode).
  useEffect(() => {
    if (!connectionId || !activeSchema) {
      setRelations([]);
      return;
    }
    let cancel = false;
    setLoadingRelations(true);
    setError(null);
    transport
      .listRelations(connectionId, activeSchema)
      .then((r) => {
        if (cancel) return;
        setRelations(r);
        setTreeRelations((prev) => ({ ...prev, [activeSchema]: r }));
      })
      .catch(
        (e) => !cancel && setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => !cancel && setLoadingRelations(false));
    return () => {
      cancel = true;
    };
  }, [connectionId, activeSchema, transport]);

  // In tree mode, ensure the active schema is auto-expanded.
  useEffect(() => {
    if (mode !== "tree" || !activeSchema) return;
    setExpanded((prev) => {
      if (prev.has(activeSchema)) return prev;
      const next = new Set(prev);
      next.add(activeSchema);
      return next;
    });
  }, [mode, activeSchema]);

  // Close picker on click-outside / Esc.
  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const userSchemas = useMemo(
    () => schemas.filter((s) => !s.isSystem),
    [schemas],
  );
  const systemSchemas = useMemo(
    () => schemas.filter((s) => s.isSystem),
    [schemas],
  );
  const pickerLabel = driver === "mysql" ? "Database" : "Schema";

  const filteredPickerUser = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    if (!q) return userSchemas;
    return userSchemas.filter((s) => s.name.toLowerCase().includes(q));
  }, [pickerFilter, userSchemas]);

  const filteredPickerSystem = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    if (!q) return systemSchemas;
    return systemSchemas.filter((s) => s.name.toLowerCase().includes(q));
  }, [pickerFilter, systemSchemas]);

  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return relations;
    return relations.filter((r) => r.name.toLowerCase().includes(q));
  }, [filter, relations]);

  const sorted = useMemo(
    () => [...filteredTables].sort((a, b) => a.name.localeCompare(b.name)),
    [filteredTables],
  );

  async function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
    if (!treeRelations[name] && connectionId) {
      setLoadingSchema(name);
      try {
        const rels = await transport.listRelations(connectionId, name);
        setTreeRelations((r) => ({ ...r, [name]: rels }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingSchema((prev) => (prev === name ? null : prev));
      }
    }
  }

  /** Picking a database from the dropdown opens its overview tab AND seeds
   * the sidebar so the tables list switches over. */
  function selectDatabase(name: string) {
    onChangeSchema(name);
    onOpenDatabase(name);
    setPickerOpen(false);
    setPickerFilter("");
  }

  function isNavActive(key: WorkspaceTabKind): boolean {
    if (!activeTab) return false;
    return activeTab.kind === key;
  }

  function isTableActive(schema: string, name: string): boolean {
    return (
      activeTab?.kind === "table" &&
      activeTab.schema === schema &&
      activeTab.name === name
    );
  }

  // ── Global tree: lazy loaders + grouping helpers ─────────────────────────
  async function loadGlobalSchemas(connId: string) {
    if (globalSchemaCache[connId]) return;
    setGlobalLoadingConn((prev) => {
      const next = new Set(prev);
      next.add(connId);
      return next;
    });
    setGlobalError((e) => {
      if (!e[connId]) return e;
      const { [connId]: _omit, ...rest } = e;
      return rest;
    });
    try {
      const list = await transport.listSchemas(connId);
      setGlobalSchemaCache((c) => ({ ...c, [connId]: list }));
    } catch (e) {
      setGlobalError((prev) => ({
        ...prev,
        [connId]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setGlobalLoadingConn((prev) => {
        const next = new Set(prev);
        next.delete(connId);
        return next;
      });
    }
  }

  async function loadGlobalRelations(connId: string, schema: string) {
    const key = `${connId}|${schema}`;
    if (globalRelCache[key]) return;
    setGlobalLoadingSchema((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      const list = await transport.listRelations(connId, schema);
      setGlobalRelCache((c) => ({ ...c, [key]: list }));
    } catch (e) {
      setGlobalError((prev) => ({
        ...prev,
        [key]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setGlobalLoadingSchema((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleGlobalConn(connId: string) {
    const willOpen = !globalExpandedConns.has(connId);
    setGlobalExpandedConns((prev) => {
      const next = new Set(prev);
      if (next.has(connId)) next.delete(connId);
      else next.add(connId);
      return next;
    });
    // Activate this connection so the workspace + top-nav follow what the
    // user is exploring. We do this on every expand click (not only the
    // first) because it matches the mental model of "I'm browsing this".
    if (willOpen && onSelectConnection && connId !== connectionId) {
      onSelectConnection(connId);
    }
    if (willOpen) void loadGlobalSchemas(connId);
  }

  function toggleGlobalSchema(connId: string, schema: string) {
    const key = `${connId}|${schema}`;
    const willOpen = !globalExpandedSchemas.has(key);
    setGlobalExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (willOpen) void loadGlobalRelations(connId, schema);
  }

  function toggleGlobalFolder(folderKey: string) {
    setGlobalCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) next.delete(folderKey);
      else next.add(folderKey);
      return next;
    });
  }

  function handleGlobalTableClick(
    connId: string,
    schema: string,
    name: string,
  ) {
    if (onOpenTableInConnection) {
      onOpenTableInConnection(connId, schema, name);
    } else if (connId === connectionId) {
      onOpenTable(schema, name);
    }
  }

  // Group connections by folder for the global tree. Mirrors ConnectionPicker.
  const globalGrouped = useMemo(() => {
    const map = new Map<string | null, ConnectionConfig[]>();
    map.set(null, []);
    for (const f of folders) map.set(f.id, []);
    for (const c of connections) {
      const key = c.folderId && map.has(c.folderId) ? c.folderId : null;
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [connections, folders]);

  // Auto-expand the active connection the first time we enter global mode so
  // the user lands oriented rather than facing a fully-collapsed tree.
  useEffect(() => {
    if (!globalTreeView || !connectionId) return;
    setGlobalExpandedConns((prev) => {
      if (prev.has(connectionId)) return prev;
      const next = new Set(prev);
      next.add(connectionId);
      return next;
    });
    void loadGlobalSchemas(connectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalTreeView, connectionId]);

  return (
    <aside className="dv-sidebar">
      <nav className="dv-nav-group">
        <div className="dv-nav-group-label">Workspace</div>
        {navItems.map((item) => (
          <div
            key={item.key}
            className={clsx(
              "dv-nav-item",
              isNavActive(item.key) && "is-active",
            )}
            onClick={item.onClick}
            role="button"
            tabIndex={0}
          >
            <span className="dv-nav-item-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </nav>

      {!globalTreeView && connectionId && (
        <div className="dv-schema-picker" ref={pickerRef}>
          <div className="dv-schema-picker-label-row">
            <span className="dv-schema-picker-label">{pickerLabel}</span>
            <div
              className="dv-mode-toggle"
              role="group"
              aria-label="Modo de navegación"
            >
              <button
                type="button"
                title="Modo selección — elegí una database y ves sus tablas"
                aria-pressed={mode === "select"}
                className={clsx(mode === "select" && "is-active")}
                onClick={() => setMode("select")}
              >
                ≡
              </button>
              <button
                type="button"
                title="Modo árbol — todas las databases con sus tablas anidadas"
                aria-pressed={mode === "tree"}
                className={clsx(mode === "tree" && "is-active")}
                onClick={() => setMode("tree")}
              >
                ⊟
              </button>
            </div>
          </div>
          {mode === "select" && (
            <button
              type="button"
              className={clsx(
                "dv-schema-picker-trigger",
                !activeSchema && "is-empty",
              )}
              onClick={() => setPickerOpen((o) => !o)}
              disabled={loadingSchemas || schemas.length === 0}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
            >
              <span className="dv-schema-picker-icon">▸</span>
              <span className="dv-schema-picker-name">
                {loadingSchemas
                  ? "Cargando…"
                  : activeSchema
                  ? activeSchema
                  : userSchemas.length === 0
                  ? "Sin databases"
                  : "Elegí una"}
              </span>
              {activeSchema && relations.length > 0 && (
                <span className="dv-schema-picker-count">
                  {relations.length}
                </span>
              )}
              <span className="dv-schema-picker-icon">▾</span>
            </button>
          )}

          {mode === "select" && pickerOpen && (
            <div className="dv-schema-picker-popover" role="listbox">
              {schemas.length > 6 && (
                <div className="dv-schema-picker-search">
                  <input
                    type="search"
                    className="dv-input"
                    placeholder={`Filtrar ${pickerLabel.toLowerCase()}…`}
                    value={pickerFilter}
                    onChange={(e) => setPickerFilter(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
              {filteredPickerUser.map((s) => (
                <div
                  key={s.name}
                  role="option"
                  aria-selected={s.name === activeSchema}
                  className={clsx(
                    "dv-schema-picker-option",
                    s.name === activeSchema && "is-active",
                  )}
                  onClick={() => selectDatabase(s.name)}
                >
                  <span className="dv-schema-picker-option-check">
                    {s.name === activeSchema ? "✓" : ""}
                  </span>
                  <span style={{ flex: 1 }}>{s.name}</span>
                </div>
              ))}
              {filteredPickerSystem.length > 0 && (
                <>
                  <div className="dv-schema-picker-section-label">Sistema</div>
                  {filteredPickerSystem.map((s) => (
                    <div
                      key={s.name}
                      role="option"
                      aria-selected={s.name === activeSchema}
                      className={clsx(
                        "dv-schema-picker-option",
                        s.name === activeSchema && "is-active",
                      )}
                      onClick={() => selectDatabase(s.name)}
                    >
                      <span className="dv-schema-picker-option-check">
                        {s.name === activeSchema ? "✓" : ""}
                      </span>
                      <span style={{ flex: 1 }}>{s.name}</span>
                      <span className="dv-schema-picker-option-tag">sys</span>
                    </div>
                  ))}
                </>
              )}
              {filteredPickerUser.length === 0 &&
                filteredPickerSystem.length === 0 && (
                  <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                    Sin resultados.
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {globalTreeView ? (
        renderGlobalTree({
          connections,
          folders,
          activeConnId: connectionId,
          activeSchemaName: activeSchema,
          activeTab,
          grouped: globalGrouped,
          expandedConns: globalExpandedConns,
          expandedSchemas: globalExpandedSchemas,
          schemaCache: globalSchemaCache,
          relCache: globalRelCache,
          loadingConn: globalLoadingConn,
          loadingSchemaSet: globalLoadingSchema,
          collapsedFolders: globalCollapsedFolders,
          errors: globalError,
          onToggleFolder: toggleGlobalFolder,
          onToggleConn: toggleGlobalConn,
          onToggleSchema: toggleGlobalSchema,
          onTableClick: handleGlobalTableClick,
        })
      ) : mode === "select" ? (
        <div className="dv-tables-section">
          <div className="dv-tables-header">
            <span>Tablas{activeSchema ? ` · ${relations.length}` : ""}</span>
          </div>
          {activeSchema && relations.length > 8 && (
            <div className="dv-tables-search">
              <input
                type="search"
                className="dv-input"
                placeholder="Filtrar tablas…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
          <div className="dv-tables-list">
            {!connectionId && (
              <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                Elegí una conexión.
              </div>
            )}
            {connectionId && !activeSchema && !loadingSchemas && (
              <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                Elegí{" "}
                {pickerLabel.toLowerCase() === "database"
                  ? "una database"
                  : "un schema"}{" "}
                para ver sus tablas.
              </div>
            )}
            {connectionId && activeSchema && loadingRelations && (
              <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                Cargando…
              </div>
            )}
            {connectionId && error && <div className="dv-error">{error}</div>}
            {connectionId &&
              activeSchema &&
              !loadingRelations &&
              !error &&
              sorted.length === 0 && (
                <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                  {filter ? "Sin resultados." : "Sin tablas."}
                </div>
              )}
            {sorted.map((r) => {
              const isActive = isTableActive(r.schema, r.name);
              return (
                <div
                  key={`${r.schema}.${r.name}`}
                  className={clsx("dv-table-row", isActive && "is-active")}
                  onClick={() => onOpenTable(r.schema, r.name)}
                  title={`${r.schema}.${r.name}${
                    r.approxRowCount != null
                      ? ` · ${r.approxRowCount.toLocaleString()} filas`
                      : ""
                  }`}
                >
                  <span className="dv-table-row-icon">
                    {r.kind === "view"
                      ? "◇"
                      : r.kind === "materialized_view"
                      ? "◈"
                      : "▦"}
                  </span>
                  <span className="dv-table-row-name">{r.name}</span>
                  {r.approxRowCount != null && (
                    <span className="dv-table-row-count">
                      {formatCount(r.approxRowCount)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="dv-schema-tree">
          {!connectionId && (
            <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
              Elegí una conexión.
            </div>
          )}
          {connectionId && loadingSchemas && (
            <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
              Cargando…
            </div>
          )}
          {connectionId && error && <div className="dv-error">{error}</div>}
          {connectionId &&
            !loadingSchemas &&
            !error &&
            userSchemas.length === 0 &&
            systemSchemas.length === 0 && (
              <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                Sin{" "}
                {pickerLabel.toLowerCase() === "database"
                  ? "databases"
                  : "schemas"}
                .
              </div>
            )}
          {[...userSchemas, ...systemSchemas].map((s) => {
            const isExpanded = expanded.has(s.name);
            const isActiveSchema = s.name === activeSchema;
            const rels = treeRelations[s.name];
            const loading = loadingSchema === s.name && !rels;
            return (
              <div key={s.name}>
                <div
                  className={clsx(
                    "dv-schema-tree-head",
                    isActiveSchema && "is-active",
                    s.isSystem && "is-system",
                  )}
                  onClick={() => {
                    onChangeSchema(s.name);
                    onOpenDatabase(s.name);
                    void toggleExpand(s.name);
                  }}
                >
                  <span className="dv-schema-tree-caret">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <span>{s.name}</span>
                  {rels && (
                    <span className="dv-schema-tree-count">{rels.length}</span>
                  )}
                </div>
                {isExpanded && (
                  <div className="dv-schema-tree-children">
                    {loading && (
                      <div className="dv-schema-tree-loading">cargando…</div>
                    )}
                    {!loading && rels && rels.length === 0 && (
                      <div className="dv-schema-tree-loading">sin tablas</div>
                    )}
                    {(rels ?? []).map((r) => {
                      const isActive = isTableActive(r.schema, r.name);
                      return (
                        <div
                          key={`${r.schema}.${r.name}`}
                          className={clsx(
                            "dv-table-row",
                            "dv-table-row-nested",
                            isActive && "is-active",
                          )}
                          onClick={() => onOpenTable(r.schema, r.name)}
                          title={`${r.schema}.${r.name}${
                            r.approxRowCount != null
                              ? ` · ${r.approxRowCount.toLocaleString()} filas`
                              : ""
                          }`}
                        >
                          <span className="dv-table-row-icon">
                            {r.kind === "view"
                              ? "◇"
                              : r.kind === "materialized_view"
                              ? "◈"
                              : "▦"}
                          </span>
                          <span className="dv-table-row-name">{r.name}</span>
                          {r.approxRowCount != null && (
                            <span className="dv-table-row-count">
                              {formatCount(r.approxRowCount)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="dv-sidebar-footer">
        <span>
          {globalTreeView
            ? `${connections.length} conexiones`
            : mode === "tree"
            ? `${userSchemas.length} ${pickerLabel.toLowerCase()}s`
            : activeSchema
            ? `${relations.length} tablas`
            : `${userSchemas.length} ${pickerLabel.toLowerCase()}s`}
        </span>
        <span>v0.1.9</span>
      </div>
    </aside>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

interface GlobalTreeProps {
  connections: ConnectionConfig[];
  folders: Folder[];
  activeConnId: string | null;
  activeSchemaName: string | null;
  activeTab: WorkspaceTab | null;
  grouped: Map<string | null, ConnectionConfig[]>;
  expandedConns: Set<string>;
  expandedSchemas: Set<string>;
  schemaCache: Record<string, SchemaInfo[]>;
  relCache: Record<string, RelationInfo[]>;
  loadingConn: Set<string>;
  loadingSchemaSet: Set<string>;
  collapsedFolders: Set<string>;
  errors: Record<string, string>;
  onToggleFolder: (key: string) => void;
  onToggleConn: (id: string) => void;
  onToggleSchema: (connId: string, schema: string) => void;
  onTableClick: (connId: string, schema: string, name: string) => void;
}

function renderGlobalTree(p: GlobalTreeProps) {
  const {
    connections,
    folders,
    activeConnId,
    activeSchemaName,
    activeTab,
    grouped,
    expandedConns,
    expandedSchemas,
    schemaCache,
    relCache,
    loadingConn,
    loadingSchemaSet,
    collapsedFolders,
    errors,
    onToggleFolder,
    onToggleConn,
    onToggleSchema,
    onTableClick,
  } = p;

  if (connections.length === 0) {
    return (
      <div className="dv-schema-tree">
        <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
          Sin conexiones todavía.
        </div>
      </div>
    );
  }

  const orderedFolderIds = folders.map((f) => f.id);
  const noFolder = grouped.get(null) ?? [];

  function tableIsActive(connId: string, schema: string, name: string) {
    return (
      connId === activeConnId &&
      activeTab?.kind === "table" &&
      activeTab.schema === schema &&
      activeTab.name === name
    );
  }

  function renderFolderGroup(folder: Folder | null, conns: ConnectionConfig[]) {
    if (conns.length === 0) return null;
    const folderKey = folder?.id ?? "__none__";
    const collapsed = collapsedFolders.has(folderKey);
    const label = folder ? folder.name : "Sin carpeta";
    const color = folder?.color ?? "neutral";

    return (
      <div key={folderKey} className="dv-conn-tree-folder">
        <button
          type="button"
          className="dv-conn-tree-folder-head"
          onClick={() => onToggleFolder(folderKey)}
          aria-expanded={!collapsed}
        >
          <span className="dv-schema-tree-caret">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className={clsx("dv-tone-dot", `is-${color}`)} aria-hidden />
          <span className="dv-conn-tree-folder-name">{label}</span>
          <span className="dv-schema-tree-count">{conns.length}</span>
        </button>
        {!collapsed && (
          <div className="dv-conn-tree-folder-children">
            {conns.map((c) => renderConnection(c))}
          </div>
        )}
      </div>
    );
  }

  function renderConnection(c: ConnectionConfig) {
    const isExpanded = expandedConns.has(c.id);
    const isActive = c.id === activeConnId;
    const schemas = schemaCache[c.id];
    const userSchemas = schemas?.filter((s) => !s.isSystem) ?? [];
    const sysSchemas = schemas?.filter((s) => s.isSystem) ?? [];
    const loadingSchemas = loadingConn.has(c.id);
    const err = errors[c.id];

    return (
      <div key={c.id} className="dv-conn-tree-conn">
        <div
          className={clsx(
            "dv-conn-tree-conn-head",
            isActive && "is-active",
          )}
          onClick={() => onToggleConn(c.id)}
          role="button"
          tabIndex={0}
          title={`${c.driver} · ${c.host}:${c.port}`}
        >
          <span className="dv-schema-tree-caret">
            {isExpanded ? "▾" : "▸"}
          </span>
          <span className="dv-conn-tree-conn-body">
            <span className="dv-conn-tree-conn-name">{c.name}</span>
            <span className="dv-conn-tree-conn-sub">
              {c.driver} · {c.host}
            </span>
          </span>
          {isActive && <span className="dv-topbar-status-dot" />}
        </div>
        {isExpanded && (
          <div className="dv-conn-tree-conn-children">
            {loadingSchemas && !schemas && (
              <div className="dv-schema-tree-loading">cargando…</div>
            )}
            {err && (
              <div
                className="dv-error"
                style={{ margin: "4px 12px", fontSize: 11 }}
              >
                {err}
              </div>
            )}
            {!loadingSchemas &&
              schemas &&
              schemas.length === 0 &&
              !err && (
                <div className="dv-schema-tree-loading">sin databases</div>
              )}
            {[...userSchemas, ...sysSchemas].map((s) =>
              renderSchema(c, s),
            )}
          </div>
        )}
      </div>
    );
  }

  function renderSchema(c: ConnectionConfig, s: SchemaInfo) {
    const key = `${c.id}|${s.name}`;
    const isExpanded = expandedSchemas.has(key);
    const rels = relCache[key];
    const loading = loadingSchemaSet.has(key) && !rels;
    const isActiveSchema =
      c.id === activeConnId && s.name === activeSchemaName;
    const err = errors[key];

    return (
      <div key={key} className="dv-conn-tree-schema">
        <div
          className={clsx(
            "dv-conn-tree-schema-head",
            isActiveSchema && "is-active",
            s.isSystem && "is-system",
          )}
          onClick={() => onToggleSchema(c.id, s.name)}
        >
          <span className="dv-schema-tree-caret">
            {isExpanded ? "▾" : "▸"}
          </span>
          <span className="dv-conn-tree-schema-name">{s.name}</span>
          {rels && (
            <span className="dv-schema-tree-count">{rels.length}</span>
          )}
        </div>
        {isExpanded && (
          <div className="dv-conn-tree-schema-children">
            {loading && (
              <div className="dv-schema-tree-loading">cargando…</div>
            )}
            {err && (
              <div
                className="dv-error"
                style={{ margin: "4px 12px", fontSize: 11 }}
              >
                {err}
              </div>
            )}
            {!loading && rels && rels.length === 0 && !err && (
              <div className="dv-schema-tree-loading">sin tablas</div>
            )}
            {(rels ?? []).map((r) => {
              const active = tableIsActive(c.id, r.schema, r.name);
              return (
                <div
                  key={`${r.schema}.${r.name}`}
                  className={clsx(
                    "dv-table-row",
                    "dv-conn-tree-table",
                    active && "is-active",
                  )}
                  onClick={() => onTableClick(c.id, r.schema, r.name)}
                  title={`${c.name} · ${r.schema}.${r.name}`}
                >
                  <span className="dv-table-row-icon">
                    {r.kind === "view"
                      ? "◇"
                      : r.kind === "materialized_view"
                      ? "◈"
                      : "▦"}
                  </span>
                  <span className="dv-table-row-name">{r.name}</span>
                  {r.approxRowCount != null && (
                    <span className="dv-table-row-count">
                      {formatCount(r.approxRowCount)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dv-schema-tree dv-conn-tree">
      {orderedFolderIds.map((fid) => {
        const folder = folders.find((f) => f.id === fid);
        if (!folder) return null;
        const list = grouped.get(fid) ?? [];
        return renderFolderGroup(folder, list);
      })}
      {noFolder.length > 0 && renderFolderGroup(null, noFolder)}
    </div>
  );
}
