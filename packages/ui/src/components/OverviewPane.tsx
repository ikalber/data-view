"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConnectionConfig, RelationInfo } from "@data-view/core";
import { useTransport } from "../transport-context";
import { formatBytes } from "../format";

interface Props {
  connection: ConnectionConfig;
  activeSchema: string | null;
  onOpenSqlEditor: () => void;
  onOpenTable: (schema: string, name: string) => void;
}

type SortBy = "rows" | "size";

export function OverviewPane({
  connection,
  activeSchema,
  onOpenSqlEditor,
  onOpenTable,
}: Props) {
  const transport = useTransport();
  const [relations, setRelations] = useState<RelationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("rows");

  useEffect(() => {
    if (!activeSchema) {
      setRelations([]);
      setLoading(false);
      return;
    }
    let cancel = false;
    setLoading(true);
    setError(null);
    transport
      .listRelations(connection.id, activeSchema)
      .then((r) => !cancel && setRelations(r))
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [connection.id, activeSchema, transport]);

  const totalTables = relations.length;
  const totalRows = relations.reduce((sum, r) => sum + (r.approxRowCount ?? 0), 0);
  const totalSize = relations.reduce((sum, r) => sum + (r.totalBytes ?? 0), 0);
  const totalIndexes = relations.reduce((sum, r) => sum + (r.indexBytes ?? 0), 0);
  const withRowCount = relations.filter((r) => r.approxRowCount != null);
  const withSize = relations.filter((r) => r.totalBytes != null);
  const tableCount = relations.filter((r) => r.kind === "table").length;
  const viewCount = relations.length - tableCount;

  const sorted = useMemo(() => {
    const copy = [...relations];
    if (sortBy === "size") {
      copy.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
    } else {
      copy.sort((a, b) => (b.approxRowCount ?? 0) - (a.approxRowCount ?? 0));
    }
    return copy;
  }, [relations, sortBy]);

  const maxValue = sorted.reduce(
    (m, t) =>
      Math.max(m, sortBy === "size" ? t.totalBytes ?? 0 : t.approxRowCount ?? 0),
    0,
  );

  const dbLabel = connection.driver === "mysql" ? "Database" : "Schema";

  return (
    <div className="dv-page">
      <div className="dv-page-eyebrow">
        <span>Workspace</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>{connection.driver}</span>
        {activeSchema && (
          <>
            <span className="sep">/</span>
            <span style={{ color: "var(--dv-text-dim)" }}>{activeSchema}</span>
          </>
        )}
      </div>
      <div className="dv-page-header">
        <div>
          <h1 className="dv-page-title">
            {activeSchema ?? connection.database ?? connection.name}
          </h1>
          <div className="dv-page-subtitle" style={{ marginTop: 6 }}>
            {connection.name} · {connection.host}:{connection.port}
          </div>
        </div>
        <div className="dv-page-actions">
          <button
            className="dv-button is-primary"
            onClick={onOpenSqlEditor}
            disabled={!activeSchema}
          >
            Nueva query
          </button>
        </div>
      </div>

      {!activeSchema ? (
        <div className="dv-card" style={{ marginTop: 24 }}>
          <div className="dv-card-body">
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
              Elegí {dbLabel.toLowerCase() === "database" ? "una database" : "un schema"} en el panel izquierdo.
            </div>
            <div style={{ fontSize: 13, color: "var(--dv-text-dim)" }}>
              Esta conexión expone {dbLabel.toLowerCase()}s múltiples — seleccioná uno para ver sus tablas y stats.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="dv-stats-grid">
            <Stat
              label="Relations"
              value={loading ? "—" : String(totalTables)}
              sub={
                viewCount > 0
                  ? `${tableCount} tablas · ${viewCount} views`
                  : `${tableCount} tablas`
              }
            />
            <Stat
              label="Filas (aprox.)"
              value={loading ? "—" : totalRows ? totalRows.toLocaleString() : "—"}
              sub={withRowCount.length ? `${withRowCount.length} con stats` : "sin datos"}
            />
            <Stat
              label="Tamaño total"
              value={loading ? "—" : formatBytes(totalSize || undefined)}
              sub={
                totalIndexes > 0
                  ? `índices ${formatBytes(totalIndexes)}`
                  : withSize.length
                  ? `${withSize.length} medidas`
                  : "sin datos"
              }
            />
            <Stat
              label="Motor"
              value={connection.driver}
              sub={connection.ssl ? "SSL activo" : "sin SSL"}
            />
          </div>

          <div className="dv-card" style={{ marginTop: 16 }}>
            <div className="dv-card-header">
              <div>
                <div className="dv-card-title">Tablas</div>
                <div className="dv-card-sub">
                  {loading
                    ? "Cargando…"
                    : `${totalTables} en ${activeSchema} · ordenadas por ${
                        sortBy === "size" ? "tamaño" : "filas"
                      }`}
                </div>
              </div>
              <div className="dv-card-actions">
                <div className="dv-segmented">
                  <button
                    className={`dv-segmented-option${sortBy === "rows" ? " is-active" : ""}`}
                    onClick={() => setSortBy("rows")}
                  >
                    Filas
                  </button>
                  <button
                    className={`dv-segmented-option${sortBy === "size" ? " is-active" : ""}`}
                    onClick={() => setSortBy("size")}
                  >
                    Tamaño
                  </button>
                </div>
              </div>
            </div>
            <div className="dv-card-body is-tight">
              {error && <div className="dv-error">{error}</div>}
              {!error && !loading && sorted.length === 0 && (
                <div className="dv-empty">Sin tablas en {activeSchema}.</div>
              )}
              {!error && sorted.length > 0 && (
                <div className="dv-rel-table">
                  <div className="dv-rel-table-head">
                    <div>Nombre</div>
                    <div className="is-num">Filas</div>
                    <div className="is-num">Datos</div>
                    <div className="is-num">Índices</div>
                    <div className="is-num">Total</div>
                    <div className="is-num">Distribución</div>
                  </div>
                  {sorted.map((t) => {
                    const value =
                      sortBy === "size" ? t.totalBytes ?? 0 : t.approxRowCount ?? 0;
                    const pct =
                      maxValue > 0 ? Math.max(2, Math.round((value / maxValue) * 100)) : 0;
                    return (
                      <div
                        key={`${t.schema}.${t.name}`}
                        className="dv-rel-table-row"
                        onClick={() => onOpenTable(t.schema, t.name)}
                      >
                        <div className="dv-rel-name">
                          <span className="dv-table-row-icon">
                            {t.kind === "view"
                              ? "◇"
                              : t.kind === "materialized_view"
                              ? "◈"
                              : "▦"}
                          </span>
                          <span style={{ fontWeight: 500 }}>{t.name}</span>
                          {t.kind !== "table" && (
                            <span className="dv-rel-kind">{t.kind}</span>
                          )}
                        </div>
                        <div className="is-num dv-mono">
                          {t.approxRowCount != null
                            ? t.approxRowCount.toLocaleString()
                            : "—"}
                        </div>
                        <div className="is-num dv-mono">{formatBytes(t.dataBytes)}</div>
                        <div className="is-num dv-mono">{formatBytes(t.indexBytes)}</div>
                        <div className="is-num dv-mono">{formatBytes(t.totalBytes)}</div>
                        <div className="dv-rel-bar">
                          <div style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="dv-stats-cell">
      <div className="dv-stats-label">{label}</div>
      <div className="dv-stats-value">{value}</div>
      <div className="dv-stats-sub">{sub}</div>
    </div>
  );
}
