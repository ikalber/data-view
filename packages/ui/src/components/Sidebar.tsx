"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { DatabaseDriver, RelationInfo, SchemaInfo } from "@data-view/core";
import { useTransport } from "../transport-context";
import type { ViewKey } from "./view";

type Mode = "select" | "tree";
const MODE_KEY = "dbview.tablesMode";

interface Props {
  connectionId: string | null;
  driver: DatabaseDriver | null;
  view: ViewKey;
  activeTable: { schema: string; name: string } | null;
  activeSchema: string | null;
  onChangeView: (v: ViewKey) => void;
  onChangeSchema: (schema: string) => void;
  onSchemasLoaded: (schemas: SchemaInfo[]) => void;
  onOpenTable: (schema: string, name: string) => void;
}

const NAV_ITEMS: { key: ViewKey; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "▤" },
  { key: "sql", label: "SQL Editor", icon: "›_" },
  { key: "schema", label: "Schema", icon: "◇" },
  { key: "history", label: "History", icon: "↻" },
];

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
  view,
  activeTable,
  activeSchema,
  onChangeView,
  onChangeSchema,
  onSchemasLoaded,
  onOpenTable,
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
  const [treeRelations, setTreeRelations] = useState<Record<string, RelationInfo[]>>(
    {},
  );
  const [loadingSchema, setLoadingSchema] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
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
        // populate the tree cache so switching modes is instant
        setTreeRelations((prev) => ({ ...prev, [activeSchema]: r }));
      })
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
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

  const userSchemas = useMemo(() => schemas.filter((s) => !s.isSystem), [schemas]);
  const systemSchemas = useMemo(() => schemas.filter((s) => s.isSystem), [schemas]);
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

  return (
    <aside className="dv-sidebar">
      <nav className="dv-nav-group">
        <div className="dv-nav-group-label">Workspace</div>
        {NAV_ITEMS.map((item) => (
          <div
            key={item.key}
            className={clsx(
              "dv-nav-item",
              view === item.key && !activeTable && "is-active",
            )}
            onClick={() => onChangeView(item.key)}
            role="button"
            tabIndex={0}
          >
            <span className="dv-nav-item-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </nav>

      {connectionId && (
        <div className="dv-schema-picker" ref={pickerRef}>
          <div className="dv-schema-picker-label-row">
            <span className="dv-schema-picker-label">{pickerLabel}</span>
            <div className="dv-mode-toggle" role="group" aria-label="Modo de navegación">
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
                <span className="dv-schema-picker-count">{relations.length}</span>
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
                  onClick={() => {
                    onChangeSchema(s.name);
                    setPickerOpen(false);
                    setPickerFilter("");
                  }}
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
                      onClick={() => {
                        onChangeSchema(s.name);
                        setPickerOpen(false);
                        setPickerFilter("");
                      }}
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

      {mode === "select" ? (
        <div className="dv-tables-section">
          <div className="dv-tables-header">
            <span>
              Tablas{activeSchema ? ` · ${relations.length}` : ""}
            </span>
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
              const isActive =
                view === "table" &&
                activeTable?.schema === r.schema &&
                activeTable?.name === r.name;
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
                Sin {pickerLabel.toLowerCase() === "database" ? "databases" : "schemas"}.
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
                    if (!isExpanded) onChangeSchema(s.name);
                    void toggleExpand(s.name);
                  }}
                >
                  <span className="dv-schema-tree-caret">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <span>{s.name}</span>
                  {rels && (
                    <span className="dv-schema-tree-count">
                      {rels.length}
                    </span>
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
                      const isActive =
                        view === "table" &&
                        activeTable?.schema === r.schema &&
                        activeTable?.name === r.name;
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
          {mode === "tree"
            ? `${userSchemas.length} ${pickerLabel.toLowerCase()}s`
            : activeSchema
            ? `${relations.length} tablas`
            : `${userSchemas.length} ${pickerLabel.toLowerCase()}s`}
        </span>
        <span>v0.1</span>
      </div>
    </aside>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
