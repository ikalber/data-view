"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type {
  ConnectionConfig,
  ExportDatabaseOptions,
  ExportDatabaseResult,
  SchemaInfo,
} from "@data-view/core";
import { useTransport } from "../transport-context";
import { formatBytes } from "../format";

interface Props {
  connection: ConnectionConfig;
  /** Optional pre-selected schema (e.g. when the user clicks "Dump" from a schema). */
  initialSchema?: string | null;
  onClose: () => void;
}

type Phase = "idle" | "running" | "done" | "error";

export function ExportDatabaseModal({
  connection,
  initialSchema,
  onClose,
}: Props) {
  const transport = useTransport();
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [dropIfExists, setDropIfExists] = useState(false);
  const [batchSize, setBatchSize] = useState(100);

  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ExportDatabaseResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    transport
      .listSchemas(connection.id)
      .then((items) => {
        if (cancel) return;
        const userSchemas = items.filter((s) => !s.isSystem);
        setSchemas(items);
        const preset = new Set<string>();
        if (initialSchema) {
          preset.add(initialSchema);
        } else if (userSchemas.length > 0) {
          userSchemas.forEach((s) => preset.add(s.name));
        }
        setSelected(preset);
      })
      .catch((e) => !cancel && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [connection.id, initialSchema, transport]);

  // Escape closes when idle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && phase !== "running") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const userSchemas = useMemo(
    () => schemas.filter((s) => !s.isSystem),
    [schemas],
  );
  const systemSchemas = useMemo(
    () => schemas.filter((s) => s.isSystem),
    [schemas],
  );

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAll(items: SchemaInfo[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      items.forEach((s) => next.add(s.name));
      return next;
    });
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function run() {
    if (selected.size === 0 || (!includeSchema && !includeData)) return;
    setPhase("running");
    setErrorMessage(null);
    setResult(null);
    const opts: ExportDatabaseOptions = {
      schemas: Array.from(selected),
      includeSchema,
      includeData,
      dropIfExists,
      batchSize: Math.max(1, Math.min(1000, batchSize)),
    };
    try {
      const r = await transport.exportDatabase(connection.id, opts);
      setResult(r);
      setPhase("done");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const canRun =
    selected.size > 0 && (includeSchema || includeData) && phase !== "running";

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== "running") onClose();
      }}
    >
      <div
        className="dv-modal"
        style={{ width: 580 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Exportar base de datos</h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--dv-text-dim)",
            marginTop: -10,
            marginBottom: 16,
          }}
        >
          {connection.name} · {connection.driver} · {connection.host}
        </div>

        {loadError && <div className="dv-error">{loadError}</div>}

        {!loadError && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div className="dv-export-modal-header">
                <span style={{ fontSize: 12, color: "var(--dv-text-dim)" }}>
                  Schemas a incluir
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="dv-button is-sm"
                    onClick={() => selectAll(userSchemas)}
                    disabled={phase === "running"}
                  >
                    Todos
                  </button>
                  <button
                    type="button"
                    className="dv-button is-sm"
                    onClick={clearAll}
                    disabled={phase === "running"}
                  >
                    Ninguno
                  </button>
                </div>
              </div>
              <div className="dv-export-schema-list">
                {loading && (
                  <div
                    style={{
                      padding: 12,
                      fontSize: 13,
                      color: "var(--dv-text-dim)",
                    }}
                  >
                    Cargando schemas…
                  </div>
                )}
                {!loading &&
                  userSchemas.map((s) => (
                    <label key={s.name} className="dv-export-schema-item">
                      <input
                        type="checkbox"
                        checked={selected.has(s.name)}
                        onChange={() => toggle(s.name)}
                        disabled={phase === "running"}
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                {!loading && systemSchemas.length > 0 && (
                  <details className="dv-export-system-schemas">
                    <summary>
                      Sistema ({systemSchemas.length})
                    </summary>
                    {systemSchemas.map((s) => (
                      <label key={s.name} className="dv-export-schema-item">
                        <input
                          type="checkbox"
                          checked={selected.has(s.name)}
                          onChange={() => toggle(s.name)}
                          disabled={phase === "running"}
                        />
                        <span>{s.name}</span>
                      </label>
                    ))}
                  </details>
                )}
              </div>
            </div>

            <div className="dv-export-options">
              <label className="dv-export-option">
                <input
                  type="checkbox"
                  checked={includeSchema}
                  onChange={(e) => setIncludeSchema(e.target.checked)}
                  disabled={phase === "running"}
                />
                <span>
                  <strong>Incluir DDL</strong>{" "}
                  <span style={{ color: "var(--dv-text-dim)" }}>
                    (CREATE TABLE)
                  </span>
                </span>
              </label>
              <label className="dv-export-option">
                <input
                  type="checkbox"
                  checked={includeData}
                  onChange={(e) => setIncludeData(e.target.checked)}
                  disabled={phase === "running"}
                />
                <span>
                  <strong>Incluir data</strong>{" "}
                  <span style={{ color: "var(--dv-text-dim)" }}>
                    (INSERT statements)
                  </span>
                </span>
              </label>
              <label className="dv-export-option">
                <input
                  type="checkbox"
                  checked={dropIfExists}
                  onChange={(e) => setDropIfExists(e.target.checked)}
                  disabled={!includeSchema || phase === "running"}
                />
                <span>
                  <strong>DROP TABLE IF EXISTS</strong>{" "}
                  <span style={{ color: "var(--dv-text-dim)" }}>
                    antes de crear
                  </span>
                </span>
              </label>
              <div className="dv-export-option">
                <span style={{ fontWeight: 500 }}>Batch size</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className="dv-input dv-export-batch-input"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value) || 100)}
                  disabled={!includeData || phase === "running"}
                />
                <span style={{ color: "var(--dv-text-dim)", fontSize: 12 }}>
                  filas por INSERT
                </span>
              </div>
            </div>

            {phase === "running" && (
              <div
                style={{
                  marginTop: 16,
                  fontSize: 13,
                  color: "var(--dv-text-dim)",
                  fontStyle: "italic",
                }}
              >
                Generando dump… esto puede tardar varios minutos para tablas grandes.
              </div>
            )}

            {phase === "error" && errorMessage && (
              <div className="dv-error" style={{ marginTop: 12 }}>
                {errorMessage}
              </div>
            )}

            {phase === "done" && result && (
              <div className="dv-export-result">
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  ✓ Dump generado
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--dv-text-dim)",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: "4px 16px",
                  }}
                >
                  <span>Tablas:</span>
                  <span>{result.tableCount}</span>
                  <span>Filas:</span>
                  <span>{result.rowCount.toLocaleString()}</span>
                  <span>Tamaño:</span>
                  <span>{formatBytes(result.bytes)}</span>
                  <span>Duración:</span>
                  <span>{(result.durationMs / 1000).toFixed(1)}s</span>
                  {result.filePath && (
                    <>
                      <span>Archivo:</span>
                      <span style={{ fontFamily: "var(--dv-mono)" }}>
                        {result.filePath}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        <div className="dv-modal-actions">
          <button
            className="dv-button"
            onClick={onClose}
            disabled={phase === "running"}
          >
            {phase === "done" ? "Cerrar" : "Cancelar"}
          </button>
          {phase !== "done" && (
            <button
              className={clsx("dv-button is-primary")}
              onClick={run}
              disabled={!canRun}
            >
              {phase === "running" ? "Generando…" : "Exportar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
