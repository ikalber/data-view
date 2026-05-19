"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";
import type { DatabaseDriver, QueryResult, SchemaInfo } from "@data-view/core";
import { useTransport } from "../transport-context";
import { recordHistoryEntry } from "../query-history";
import { ResultsTable } from "./ResultsTable";
import { ExportMenu } from "./ExportMenu";

export interface SavedFile {
  id: string;
  name: string;
  sql: string;
  updatedAt: string;
}

interface Props {
  connectionId: string;
  /** This tab's id — used as a stable key for runtime state. */
  tabId: string;
  /** Current SQL text of this tab. */
  sql: string;
  /** Updates the parent tab's SQL. */
  onChangeSql: (sql: string) => void;
  /** Display title for the tab; used as a default name when saving. */
  title: string;
  /** Linked saved-file id; null when the tab is unsaved. */
  fileId: string | null;
  /** Saved scripts available for this connection. */
  files: SavedFile[];
  /** Save the current SQL as a new file (or overwrite the linked file).
   * Returns the resulting fileId so the caller can update the tab. */
  onSave: (info: {
    tabId: string;
    title: string;
    sql: string;
    fileId: string | null;
  }) => { fileId: string; title: string } | null;
  /** Open a saved file in a new tab. */
  onOpenFile: (file: SavedFile) => void;
  /** Delete a saved file. */
  onDeleteFile: (file: SavedFile) => void;
  /** Whether this editor is the currently visible tab. */
  isActive: boolean;
  /** Database/schema the script targets; null = connection default. */
  database: string | null;
  /** Updates the parent tab's database. */
  onChangeDatabase: (database: string | null) => void;
  /** All schemas/databases the user can pick. */
  schemas: SchemaInfo[];
  driver: DatabaseDriver | null;
}

interface Runtime {
  result: QueryResult | null;
  error: string | null;
  running: boolean;
}

export function QueryEditor({
  connectionId,
  tabId,
  sql,
  onChangeSql,
  title,
  fileId,
  files,
  onSave,
  onOpenFile,
  onDeleteFile,
  isActive,
  database,
  onChangeDatabase,
  schemas,
  driver,
}: Props) {
  const transport = useTransport();
  const [runtime, setRuntime] = useState<Runtime>({
    result: null,
    error: null,
    running: false,
  });
  const [filesOpen, setFilesOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [dbFilter, setDbFilter] = useState("");
  const filesMenuRef = useRef<HTMLDivElement>(null);
  const dbMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dbLabel = driver === "postgres" ? "Schema" : "Database";
  const userSchemas = useMemo(
    () => schemas.filter((s) => !s.isSystem),
    [schemas],
  );
  const systemSchemas = useMemo(
    () => schemas.filter((s) => s.isSystem),
    [schemas],
  );
  const filteredUser = useMemo(() => {
    const q = dbFilter.trim().toLowerCase();
    if (!q) return userSchemas;
    return userSchemas.filter((s) => s.name.toLowerCase().includes(q));
  }, [dbFilter, userSchemas]);
  const filteredSystem = useMemo(() => {
    const q = dbFilter.trim().toLowerCase();
    if (!q) return systemSchemas;
    return systemSchemas.filter((s) => s.name.toLowerCase().includes(q));
  }, [dbFilter, systemSchemas]);

  // Click-outside / Esc closes the files popover.
  useEffect(() => {
    if (!filesOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        filesMenuRef.current &&
        !filesMenuRef.current.contains(e.target as Node)
      ) {
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

  useEffect(() => {
    if (!dbPickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (dbMenuRef.current && !dbMenuRef.current.contains(e.target as Node)) {
        setDbPickerOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setDbPickerOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [dbPickerOpen]);

  const sortedFiles = useMemo(
    () =>
      [...files].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [files],
  );

  const run = useCallback(async () => {
    if (runtime.running) return;
    if (!sql.trim()) return;
    setRuntime((r) => ({ result: r.result, error: null, running: true }));
    try {
      const result = await transport.runQuery(connectionId, sql, {
        schema: database ?? undefined,
      });
      setRuntime({ result, error: null, running: false });
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
      setRuntime({ result: null, error: message, running: false });
      recordHistoryEntry({
        connectionId,
        sql,
        status: "error",
        error: message,
      });
    }
  }, [runtime.running, transport, connectionId, sql, database]);

  const saveActive = useCallback(() => {
    onSave({ tabId, title, sql, fileId });
  }, [onSave, tabId, title, sql, fileId]);

  // Keep the runtime relevant when the connection or SQL is dropped.
  useEffect(() => {
    setRuntime({ result: null, error: null, running: false });
  }, [connectionId]);

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

  // Focus when this tab becomes active.
  useEffect(() => {
    if (isActive) {
      // Defer so the pane is visible before focusing.
      const t = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [isActive]);

  return (
    <div className="dv-sql-pane">
      <div className="dv-toolbar">
        <div className="dv-sql-db-picker" ref={dbMenuRef}>
          <button
            type="button"
            className={clsx(
              "dv-sql-db-trigger",
              !database && "is-empty",
              dbPickerOpen && "is-open",
            )}
            onClick={() => setDbPickerOpen((o) => !o)}
            disabled={schemas.length === 0}
            aria-haspopup="listbox"
            aria-expanded={dbPickerOpen}
            title={
              database
                ? `Ejecutar en ${dbLabel.toLowerCase()} "${database}"`
                : `Sin ${dbLabel.toLowerCase()} seleccionada — usa el default de la conexión`
            }
          >
            <span className="dv-sql-db-trigger-icon">⛁</span>
            <span className="dv-sql-db-trigger-name">
              {database ?? `(${dbLabel.toLowerCase()} default)`}
            </span>
            <span className="dv-sql-db-trigger-caret">▾</span>
          </button>
          {dbPickerOpen && (
            <div className="dv-sql-db-popover" role="listbox">
              {schemas.length > 6 && (
                <div className="dv-sql-db-search">
                  <input
                    type="search"
                    className="dv-input"
                    placeholder={`Filtrar ${dbLabel.toLowerCase()}…`}
                    value={dbFilter}
                    onChange={(e) => setDbFilter(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
              <div
                role="option"
                aria-selected={database == null}
                className={clsx(
                  "dv-sql-db-option",
                  database == null && "is-active",
                )}
                onClick={() => {
                  onChangeDatabase(null);
                  setDbPickerOpen(false);
                  setDbFilter("");
                }}
              >
                <span className="dv-sql-db-option-check">
                  {database == null ? "✓" : ""}
                </span>
                <span style={{ flex: 1, fontStyle: "italic" }}>
                  default de la conexión
                </span>
              </div>
              {filteredUser.map((s) => (
                <div
                  key={s.name}
                  role="option"
                  aria-selected={s.name === database}
                  className={clsx(
                    "dv-sql-db-option",
                    s.name === database && "is-active",
                  )}
                  onClick={() => {
                    onChangeDatabase(s.name);
                    setDbPickerOpen(false);
                    setDbFilter("");
                  }}
                >
                  <span className="dv-sql-db-option-check">
                    {s.name === database ? "✓" : ""}
                  </span>
                  <span style={{ flex: 1 }}>{s.name}</span>
                </div>
              ))}
              {filteredSystem.length > 0 && (
                <>
                  <div className="dv-sql-db-section-label">Sistema</div>
                  {filteredSystem.map((s) => (
                    <div
                      key={s.name}
                      role="option"
                      aria-selected={s.name === database}
                      className={clsx(
                        "dv-sql-db-option",
                        s.name === database && "is-active",
                      )}
                      onClick={() => {
                        onChangeDatabase(s.name);
                        setDbPickerOpen(false);
                        setDbFilter("");
                      }}
                    >
                      <span className="dv-sql-db-option-check">
                        {s.name === database ? "✓" : ""}
                      </span>
                      <span style={{ flex: 1 }}>{s.name}</span>
                      <span className="dv-sql-db-option-tag">sys</span>
                    </div>
                  ))}
                </>
              )}
              {filteredUser.length === 0 && filteredSystem.length === 0 && (
                <div className="dv-empty" style={{ padding: 14, fontSize: 12 }}>
                  Sin resultados.
                </div>
              )}
            </div>
          )}
        </div>
        <button
          className="dv-button is-primary"
          onClick={run}
          disabled={runtime.running}
        >
          {runtime.running ? "Ejecutando…" : "Run"}
          <span className="dv-kbd" style={{ marginLeft: 4 }}>
            ⌘⏎
          </span>
        </button>
        <button
          className="dv-button"
          onClick={saveActive}
          title={fileId ? `Guardar "${title}"` : "Guardar como archivo"}
        >
          Guardar
          <span className="dv-kbd" style={{ marginLeft: 4 }}>
            ⌘S
          </span>
        </button>
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
                    onClick={() => {
                      setFilesOpen(false);
                      onOpenFile(f);
                    }}
                    title={`Actualizado ${new Date(
                      f.updatedAt,
                    ).toLocaleString()}`}
                  >
                    <span className="dv-sql-file-row-icon">▤</span>
                    <span className="dv-sql-file-row-name">{f.name}</span>
                    <button
                      type="button"
                      className="dv-sql-file-row-del"
                      aria-label="Borrar archivo"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteFile(f);
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
        <span className="dv-toolbar-meta">
          {runtime.result
            ? `${runtime.result.rowCount} filas · ${runtime.result.durationMs}ms${
                runtime.result.truncated ? " · truncado" : ""
              }`
            : fileId
            ? `Archivo: ${title}`
            : "SQL editor"}
        </span>
      </div>
      <div className="dv-editor">
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => onChangeSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="-- Escribí tu SQL acá. Ctrl+Enter para ejecutar, Ctrl+S para guardar."
        />
      </div>
      <div className="dv-results">
        <div className="dv-results-header">
          <span>
            {runtime.error
              ? "Error"
              : runtime.result
              ? `${runtime.result.rowCount} filas`
              : "Resultados"}
          </span>
          {runtime.result && !runtime.error && (
            <ExportMenu
              result={runtime.result}
              baseName={fileId ? title : "query"}
              driver={driver}
              schema={database ?? undefined}
              table="query"
              label="Export"
              className="is-sm"
            />
          )}
        </div>
        <div className="dv-results-body">
          {runtime.error ? (
            <div className="dv-error">{runtime.error}</div>
          ) : (
            <ResultsTable result={runtime.result} />
          )}
        </div>
      </div>
    </div>
  );
}
