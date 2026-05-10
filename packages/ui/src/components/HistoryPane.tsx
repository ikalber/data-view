"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type { ConnectionConfig } from "@data-view/core";
import {
  useQueryHistory,
  type QueryHistoryEntry,
} from "../query-history";

interface Props {
  connection: ConnectionConfig;
  connections: ConnectionConfig[];
  onOpenInSqlEditor: (sql: string) => void;
}

type Scope = "current" | "all";
type StatusFilter = "all" | "ok" | "error";

export function HistoryPane({
  connection,
  connections,
  onOpenInSqlEditor,
}: Props) {
  const { entries, remove, clear } = useQueryHistory();
  const [scope, setScope] = useState<Scope>("current");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filter, setFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const connectionsById = useMemo(() => {
    const map = new Map<string, ConnectionConfig>();
    for (const c of connections) map.set(c.id, c);
    return map;
  }, [connections]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (scope === "current" && e.connectionId !== connection.id) return false;
      if (status !== "all" && e.status !== status) return false;
      if (q && !e.sql.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, scope, status, filter, connection.id]);

  const totalForScope = useMemo(
    () =>
      entries.filter(
        (e) => scope === "all" || e.connectionId === connection.id,
      ).length,
    [entries, scope, connection.id],
  );

  function handleClear() {
    if (totalForScope === 0) return;
    const label =
      scope === "current"
        ? `Eliminar ${totalForScope} entrada(s) de "${connection.name}"?`
        : `Eliminar las ${totalForScope} entradas del historial?`;
    if (!window.confirm(label)) return;
    clear(scope === "current" ? connection.id : undefined);
  }

  return (
    <div className="dv-page">
      <div className="dv-page-eyebrow">
        <span>Workspace</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>History</span>
      </div>
      <div className="dv-page-header">
        <div>
          <h1 className="dv-page-title">History</h1>
          <div className="dv-page-subtitle" style={{ marginTop: 6 }}>
            {entries.length === 0
              ? "Las queries que ejecutes desde el SQL Editor aparecen acá."
              : `${filtered.length} de ${entries.length} entradas`}
          </div>
        </div>
        <div className="dv-page-actions">
          <div className="dv-segmented">
            <button
              className={clsx(
                "dv-segmented-option",
                scope === "current" && "is-active",
              )}
              onClick={() => setScope("current")}
            >
              Esta conexión
            </button>
            <button
              className={clsx(
                "dv-segmented-option",
                scope === "all" && "is-active",
              )}
              onClick={() => setScope("all")}
            >
              Todas
            </button>
          </div>
          <div className="dv-segmented">
            <button
              className={clsx(
                "dv-segmented-option",
                status === "all" && "is-active",
              )}
              onClick={() => setStatus("all")}
            >
              Todas
            </button>
            <button
              className={clsx(
                "dv-segmented-option",
                status === "ok" && "is-active",
              )}
              onClick={() => setStatus("ok")}
            >
              OK
            </button>
            <button
              className={clsx(
                "dv-segmented-option",
                status === "error" && "is-active",
              )}
              onClick={() => setStatus("error")}
            >
              Error
            </button>
          </div>
          <button
            className="dv-button is-ghost"
            onClick={handleClear}
            disabled={totalForScope === 0}
            title={
              scope === "current"
                ? "Borrar el historial de esta conexión"
                : "Borrar todo el historial"
            }
          >
            Limpiar
          </button>
        </div>
      </div>

      <div className="dv-history-toolbar">
        <input
          type="search"
          className="dv-input"
          placeholder="Filtrar por SQL…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="dv-card" style={{ marginTop: 16 }}>
          <div className="dv-card-body">
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
              {entries.length === 0
                ? "Todavía no hay queries"
                : "Sin resultados"}
            </div>
            <div style={{ fontSize: 13, color: "var(--dv-text-dim)" }}>
              {entries.length === 0
                ? "Ejecutá algo desde el SQL Editor y va a quedar registrado acá."
                : "Probá ajustar los filtros o limpiar el buscador."}
            </div>
          </div>
        </div>
      ) : (
        <div className="dv-history-list">
          {filtered.map((entry) => {
            const conn = connectionsById.get(entry.connectionId);
            const isExpanded = expandedId === entry.id;
            return (
              <HistoryRow
                key={entry.id}
                entry={entry}
                connectionLabel={conn?.name ?? "conexión eliminada"}
                showConnection={scope === "all"}
                isExpanded={isExpanded}
                onToggle={() =>
                  setExpandedId((prev) => (prev === entry.id ? null : entry.id))
                }
                canRerun={entry.connectionId === connection.id}
                onRerun={() => onOpenInSqlEditor(entry.sql)}
                onCopy={() => {
                  void navigator.clipboard?.writeText(entry.sql);
                }}
                onDelete={() => remove(entry.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  entry: QueryHistoryEntry;
  connectionLabel: string;
  showConnection: boolean;
  isExpanded: boolean;
  canRerun: boolean;
  onToggle: () => void;
  onRerun: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function HistoryRow({
  entry,
  connectionLabel,
  showConnection,
  isExpanded,
  canRerun,
  onToggle,
  onRerun,
  onCopy,
  onDelete,
}: RowProps) {
  const preview = useMemo(() => firstLine(entry.sql), [entry.sql]);
  const meta = useMemo(() => buildMeta(entry), [entry]);

  return (
    <div
      className={clsx(
        "dv-history-row",
        entry.status === "error" && "is-error",
        isExpanded && "is-expanded",
      )}
    >
      <button
        type="button"
        className="dv-history-row-summary"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span
          className={clsx(
            "dv-history-status",
            entry.status === "ok" ? "is-ok" : "is-error",
          )}
          aria-hidden
        />
        <span className="dv-history-time" title={entry.ranAt}>
          {formatRelative(entry.ranAt)}
        </span>
        <span className="dv-history-sql-preview" title={entry.sql}>
          {preview}
        </span>
        <span className="dv-history-meta">{meta}</span>
        {showConnection && (
          <span className="dv-history-conn" title={connectionLabel}>
            {connectionLabel}
          </span>
        )}
        <span className="dv-history-caret">{isExpanded ? "▾" : "▸"}</span>
      </button>
      {isExpanded && (
        <div className="dv-history-row-body">
          <pre className="dv-history-sql">{entry.sql}</pre>
          {entry.error && <div className="dv-error">{entry.error}</div>}
          <div className="dv-history-row-actions">
            <button
              className="dv-button is-primary is-sm"
              onClick={onRerun}
              disabled={!canRerun}
              title={
                canRerun
                  ? "Cargar en el SQL Editor"
                  : "La conexión original no está activa — cambiá de conexión para reusarla"
              }
            >
              Abrir en SQL Editor
            </button>
            <button className="dv-button is-ghost is-sm" onClick={onCopy}>
              Copiar
            </button>
            <button className="dv-button is-ghost is-sm" onClick={onDelete}>
              Eliminar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function firstLine(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return "(vacío)";
  const firstNewline = trimmed.indexOf("\n");
  const line = firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline);
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function buildMeta(e: QueryHistoryEntry): string {
  if (e.status === "error") return "error";
  const parts: string[] = [];
  if (e.rowCount != null) parts.push(`${e.rowCount} filas`);
  else if (e.affectedRows != null) parts.push(`${e.affectedRows} afectadas`);
  if (e.durationMs != null) parts.push(`${e.durationMs}ms`);
  if (e.truncated) parts.push("truncado");
  return parts.join(" · ");
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60_000) return "hace unos segundos";
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return `hace ${m} min`;
  }
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000);
    return `hace ${h} h`;
  }
  const d = Math.floor(diff / 86_400_000);
  if (d < 7) return `hace ${d} d`;
  const date = new Date(iso);
  return date.toLocaleDateString();
}
