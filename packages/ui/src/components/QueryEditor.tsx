"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import type { QueryResult } from "@data-view/core";
import { useTransport } from "../transport-context";
import { recordHistoryEntry } from "../query-history";
import { ResultsTable } from "./ResultsTable";

interface SavedFile {
  id: string;
  name: string;
  sql: string;
  updatedAt: string;
}

interface QueryTab {
  id: string;
  title: string;
  sql: string;
  /** Linked saved-file id; null when tab is unsaved. */
  fileId: string | null;
}

interface TabRuntime {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
}

interface Props {
  connectionId: string;
  /** Bumping `nonce` opens a new tab seeded with `sql`. */
  seed?: { sql: string; nonce: number } | null;
}

const TABS_KEY = (id: string) => `dbview.sqlTabs.${id}`;
const ACTIVE_KEY = (id: string) => `dbview.sqlActiveTab.${id}`;
const FILES_KEY = (id: string) => `dbview.sqlFiles.${id}`;

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

function untitledName(tabs: QueryTab[]): string {
  const taken = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (taken.has(`Sin título ${n}`)) n++;
  return `Sin título ${n}`;
}

const EMPTY_RUNTIME: TabRuntime = { result: null, error: null, running: false };

export function QueryEditor({ connectionId, seed }: Props) {
  const transport = useTransport();
  const [tabs, setTabs] = useState<QueryTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [files, setFiles] = useState<SavedFile[]>([]);
  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({});
  const [filesOpen, setFilesOpen] = useState(false);
  // Connection id whose tabs/files have been hydrated into state. The persist
  // effects gate on this so a stale render right after a connection switch
  // doesn't clobber the new connection's storage.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const seenSeedRef = useRef<number | null>(null);
  const filesMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load tabs/files when connection changes.
  useEffect(() => {
    const loadedTabs = readJSON<QueryTab[]>(TABS_KEY(connectionId), []);
    const loadedActive = readJSON<string | null>(ACTIVE_KEY(connectionId), null);
    const loadedFiles = readJSON<SavedFile[]>(FILES_KEY(connectionId), []);
    if (loadedTabs.length === 0) {
      const t: QueryTab = {
        id: uid(),
        title: "Sin título 1",
        sql: "",
        fileId: null,
      };
      setTabs([t]);
      setActiveId(t.id);
    } else {
      setTabs(loadedTabs);
      const first = loadedTabs[0];
      setActiveId(
        loadedActive && loadedTabs.some((t) => t.id === loadedActive)
          ? loadedActive
          : first
          ? first.id
          : null,
      );
    }
    setFiles(loadedFiles);
    setRuntime({});
    seenSeedRef.current = null;
    setHydratedFor(connectionId);
  }, [connectionId]);

  // Persist tabs/active/files only after state has been hydrated for the
  // current connection.
  useEffect(() => {
    if (hydratedFor !== connectionId) return;
    writeJSON(TABS_KEY(connectionId), tabs);
  }, [hydratedFor, connectionId, tabs]);
  useEffect(() => {
    if (hydratedFor !== connectionId || activeId == null) return;
    writeJSON(ACTIVE_KEY(connectionId), activeId);
  }, [hydratedFor, connectionId, activeId]);
  useEffect(() => {
    if (hydratedFor !== connectionId) return;
    writeJSON(FILES_KEY(connectionId), files);
  }, [hydratedFor, connectionId, files]);

  // Open a fresh tab whenever a new seed nonce arrives.
  useEffect(() => {
    if (!seed) return;
    if (seenSeedRef.current === seed.nonce) return;
    seenSeedRef.current = seed.nonce;
    setTabs((prev) => {
      const t: QueryTab = {
        id: uid(),
        title: untitledName(prev),
        sql: seed.sql,
        fileId: null,
      };
      setActiveId(t.id);
      return [...prev, t];
    });
  }, [seed]);

  // Click-outside / Esc closes the files popover.
  useEffect(() => {
    if (!filesOpen) return;
    const onClick = (e: MouseEvent) => {
      if (filesMenuRef.current && !filesMenuRef.current.contains(e.target as Node)) {
        setFilesOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setFilesOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [filesOpen]);

  const active = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );
  const activeRuntime: TabRuntime =
    (active && runtime[active.id]) || EMPTY_RUNTIME;

  const isDirty = useCallback(
    (t: QueryTab) => {
      if (t.fileId == null) return t.sql.length > 0;
      const f = files.find((x) => x.id === t.fileId);
      return !f || f.sql !== t.sql;
    },
    [files],
  );

  const sortedFiles = useMemo(
    () =>
      [...files].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [files],
  );

  const newTab = useCallback((seedSql = "") => {
    setTabs((prev) => {
      const t: QueryTab = {
        id: uid(),
        title: untitledName(prev),
        sql: seedSql,
        fileId: null,
      };
      setActiveId(t.id);
      return [...prev, t];
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const target = tabs.find((t) => t.id === id);
      if (!target) return;
      if (isDirty(target)) {
        const ok = window.confirm(
          `Tenés cambios sin guardar en "${target.title}". ¿Cerrar igual?`,
        );
        if (!ok) return;
      }
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx < 0) return prev;
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const t: QueryTab = {
            id: uid(),
            title: "Sin título 1",
            sql: "",
            fileId: null,
          };
          setActiveId(t.id);
          return [t];
        }
        if (id === activeId) {
          const fallback = next[Math.max(0, idx - 1)] ?? next[0];
          if (fallback) setActiveId(fallback.id);
        }
        return next;
      });
      setRuntime((r) => {
        if (!(id in r)) return r;
        const { [id]: _drop, ...rest } = r;
        return rest;
      });
    },
    [tabs, activeId, isDirty],
  );

  const updateActiveSql = useCallback(
    (sql: string) => {
      if (!active) return;
      setTabs((prev) =>
        prev.map((t) => (t.id === active.id ? { ...t, sql } : t)),
      );
    },
    [active],
  );

  const saveActive = useCallback(() => {
    if (!active) return;
    if (active.fileId == null) {
      const def = active.title.startsWith("Sin título") ? "" : active.title;
      const name = window.prompt("Nombre del archivo:", def);
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      const id = uid();
      const file: SavedFile = {
        id,
        name: trimmed,
        sql: active.sql,
        updatedAt: new Date().toISOString(),
      };
      setFiles((prev) => [file, ...prev]);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === active.id ? { ...t, fileId: id, title: trimmed } : t,
        ),
      );
    } else {
      const fileId = active.fileId;
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, sql: active.sql, updatedAt: new Date().toISOString() }
            : f,
        ),
      );
    }
  }, [active]);

  const openFile = useCallback(
    (file: SavedFile) => {
      setFilesOpen(false);
      const existing = tabs.find((t) => t.fileId === file.id);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const t: QueryTab = {
        id: uid(),
        title: file.name,
        sql: file.sql,
        fileId: file.id,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    },
    [tabs],
  );

  const deleteFile = useCallback((file: SavedFile) => {
    const ok = window.confirm(`¿Borrar "${file.name}"?`);
    if (!ok) return;
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    setTabs((prev) =>
      prev.map((t) => (t.fileId === file.id ? { ...t, fileId: null } : t)),
    );
  }, []);

  const run = useCallback(async () => {
    if (!active || activeRuntime.running) return;
    const sql = active.sql;
    if (!sql.trim()) return;
    const tabId = active.id;
    setRuntime((r) => ({
      ...r,
      [tabId]: { result: r[tabId]?.result ?? null, error: null, running: true },
    }));
    try {
      const result = await transport.runQuery(connectionId, sql);
      setRuntime((r) => ({
        ...r,
        [tabId]: { result, error: null, running: false },
      }));
      recordHistoryEntry({
        connectionId,
        sql,
        status: "ok",
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        affectedRows: result.affectedRows,
        truncated: result.truncated,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRuntime((r) => ({
        ...r,
        [tabId]: { result: null, error: message, running: false },
      }));
      recordHistoryEntry({
        connectionId,
        sql,
        status: "error",
        error: message,
      });
    }
  }, [active, activeRuntime.running, transport, connectionId]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveActive();
    }
  }

  function onTabMouseDown(e: ReactMouseEvent<HTMLDivElement>, id: string) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(id);
    }
  }

  return (
    <>
      <div className="dv-sql-tabs">
        <div className="dv-sql-tab-list" role="tablist">
          {tabs.map((t) => {
            const isActive = t.id === activeId;
            const dirty = isDirty(t);
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={clsx("dv-sql-tab", isActive && "is-active")}
                onClick={() => setActiveId(t.id)}
                onMouseDown={(e) => onTabMouseDown(e, t.id)}
                title={t.fileId ? `Archivo: ${t.title}` : t.title}
              >
                <span className="dv-sql-tab-icon">
                  {t.fileId ? "▤" : "›_"}
                </span>
                <span className="dv-sql-tab-title">{t.title}</span>
                {dirty && (
                  <span className="dv-sql-tab-dot" aria-label="sin guardar">
                    •
                  </span>
                )}
                <button
                  type="button"
                  className="dv-sql-tab-close"
                  aria-label="Cerrar pestaña"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="dv-sql-tab-new"
            onClick={() => newTab()}
            title="Nueva pestaña"
            aria-label="Nueva pestaña"
          >
            +
          </button>
        </div>
        <div className="dv-sql-files" ref={filesMenuRef}>
          <button
            type="button"
            className={clsx("dv-sql-files-trigger", filesOpen && "is-open")}
            onClick={() => setFilesOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={filesOpen}
          >
            Archivos
            {files.length > 0 && (
              <span className="dv-sql-files-count">{files.length}</span>
            )}
            <span className="dv-sql-files-caret">▾</span>
          </button>
          {filesOpen && (
            <div className="dv-sql-files-popover" role="menu">
              {sortedFiles.length === 0 ? (
                <div className="dv-empty" style={{ padding: 14, fontSize: 12 }}>
                  Sin archivos guardados.
                </div>
              ) : (
                sortedFiles.map((f) => (
                  <div
                    key={f.id}
                    role="menuitem"
                    className="dv-sql-file-row"
                    onClick={() => openFile(f)}
                    title={`Actualizado ${new Date(f.updatedAt).toLocaleString()}`}
                  >
                    <span className="dv-sql-file-row-icon">▤</span>
                    <span className="dv-sql-file-row-name">{f.name}</span>
                    <button
                      type="button"
                      className="dv-sql-file-row-del"
                      aria-label="Borrar archivo"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFile(f);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="dv-toolbar">
        <button
          className="dv-button is-primary"
          onClick={run}
          disabled={!active || activeRuntime.running}
        >
          {activeRuntime.running ? "Ejecutando…" : "Run"}
          <span className="dv-kbd" style={{ marginLeft: 4 }}>⌘⏎</span>
        </button>
        <button
          className="dv-button"
          onClick={saveActive}
          disabled={!active}
          title={
            active?.fileId
              ? `Guardar "${active.title}"`
              : "Guardar como archivo"
          }
        >
          Guardar
          <span className="dv-kbd" style={{ marginLeft: 4 }}>⌘S</span>
        </button>
        <span className="dv-toolbar-meta">
          {activeRuntime.result
            ? `${activeRuntime.result.rowCount} filas · ${activeRuntime.result.durationMs}ms${
                activeRuntime.result.truncated ? " · truncado" : ""
              }`
            : active?.fileId
            ? `Archivo: ${active.title}`
            : "SQL editor"}
        </span>
      </div>
      <div className="dv-editor">
        <textarea
          ref={textareaRef}
          value={active?.sql ?? ""}
          onChange={(e) => updateActiveSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="-- Escribí tu SQL acá. Ctrl+Enter para ejecutar, Ctrl+S para guardar."
          disabled={!active}
        />
      </div>
      <div className="dv-results">
        <div className="dv-results-header">
          {activeRuntime.error
            ? "Error"
            : activeRuntime.result
            ? `${activeRuntime.result.rowCount} filas`
            : "Resultados"}
        </div>
        <div className="dv-results-body">
          {activeRuntime.error ? (
            <div className="dv-error">{activeRuntime.error}</div>
          ) : (
            <ResultsTable result={activeRuntime.result} />
          )}
        </div>
      </div>
    </>
  );
}
