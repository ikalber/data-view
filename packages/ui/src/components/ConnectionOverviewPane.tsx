"use client";

import { useEffect, useState } from "react";
import type { ConnectionConfig, ConnectionOverview } from "@data-view/core";
import { useTransport } from "../transport-context";
import { formatBytes, formatUptime, shortServerVersion } from "../format";

interface Props {
  connection: ConnectionConfig;
  /** Callback when the user clicks a database in the list. */
  onSelectDatabase?: (name: string) => void;
}

export function ConnectionOverviewPane({ connection, onSelectDatabase }: Props) {
  const transport = useTransport();
  const [data, setData] = useState<ConnectionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    transport
      .getConnectionOverview(connection.id)
      .then((d) => !cancel && setData(d))
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [connection.id, transport]);

  const dbLabel = connection.driver === "postgres" ? "Schema" : "Database";
  const databases = data?.databases ?? [];
  const userDatabases = databases.filter((d) => !d.isSystem);
  const maxSize = databases.reduce((m, d) => Math.max(m, d.sizeBytes ?? 0), 0);

  return (
    <div className="dv-page">
      <div className="dv-page-eyebrow">
        <span>Workspace</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>conexión</span>
      </div>
      <div className="dv-page-header">
        <div>
          <h1 className="dv-page-title">{connection.name}</h1>
          <div className="dv-page-subtitle" style={{ marginTop: 6 }}>
            {connection.driver} · {connection.host}:{connection.port}
            {connection.database ? ` · ${connection.database}` : ""}
          </div>
        </div>
      </div>

      {error && (
        <div className="dv-error" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      <div className="dv-stats-grid">
        <Stat
          label="Versión"
          value={loading ? "—" : shortServerVersion(data?.serverVersion).split(",")[0] ?? "—"}
          sub={data?.currentUser ? `como ${data.currentUser}` : connection.username}
        />
        <Stat
          label={`${dbLabel}s`}
          value={loading ? "—" : String(databases.length)}
          sub={
            userDatabases.length !== databases.length
              ? `${userDatabases.length} de usuario`
              : "sin sistema"
          }
        />
        <Stat
          label="Tamaño total"
          value={loading ? "—" : formatBytes(data?.totalSizeBytes)}
          sub={
            data?.totalSizeBytes != null && databases.length > 0
              ? `${dbLabel.toLowerCase()}s sumadas`
              : "sin datos"
          }
        />
        <Stat
          label="Uptime"
          value={loading ? "—" : formatUptime(data?.uptimeSeconds)}
          sub={
            data?.activeConnections != null
              ? `${data.activeConnections}${
                  data.maxConnections ? `/${data.maxConnections}` : ""
                } sesiones`
              : "sin datos"
          }
        />
      </div>

      <div className="dv-card" style={{ marginTop: 16 }}>
        <div className="dv-card-header">
          <div>
            <div className="dv-card-title">{dbLabel}s</div>
            <div className="dv-card-sub">
              {loading
                ? "Cargando…"
                : `${databases.length} ${dbLabel.toLowerCase()}${
                    databases.length === 1 ? "" : "s"
                  } visibles · clic para abrir`}
            </div>
          </div>
        </div>
        <div className="dv-card-body is-tight">
          {!loading && databases.length === 0 && !error && (
            <div className="dv-empty">Sin {dbLabel.toLowerCase()}s para mostrar.</div>
          )}
          {databases.length > 0 && (
            <div className="dv-rel-table is-db">
              <div className="dv-rel-table-head">
                <div>Nombre</div>
                <div className="is-num">Tablas</div>
                <div className="is-num">Tamaño</div>
                <div className="is-num">Distribución</div>
              </div>
              {databases.map((d) => {
                const pct =
                  maxSize > 0 && d.sizeBytes != null
                    ? Math.max(2, Math.round((d.sizeBytes / maxSize) * 100))
                    : 0;
                const isCurrent = data?.currentDatabase === d.name;
                return (
                  <div
                    key={d.name}
                    className={`dv-rel-table-row${onSelectDatabase ? "" : " is-static"}`}
                    onClick={() => onSelectDatabase?.(d.name)}
                  >
                    <div className="dv-rel-name">
                      <span className="dv-table-row-icon">⛁</span>
                      <span style={{ fontWeight: 500 }}>{d.name}</span>
                      {isCurrent && <span className="dv-rel-kind">activa</span>}
                      {d.isSystem && <span className="dv-rel-kind">sistema</span>}
                      {d.details && (
                        <span className="dv-rel-kind" style={{ opacity: 0.7 }}>
                          {d.details}
                        </span>
                      )}
                    </div>
                    <div className="is-num dv-mono">
                      {d.relationCount != null ? d.relationCount.toLocaleString() : "—"}
                    </div>
                    <div className="is-num dv-mono">{formatBytes(d.sizeBytes)}</div>
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

      <div className="dv-card" style={{ marginTop: 16 }}>
        <div className="dv-card-header">
          <div>
            <div className="dv-card-title">Servidor</div>
            <div className="dv-card-sub">Detalle de la conexión activa.</div>
          </div>
        </div>
        <div className="dv-card-body">
          <dl className="dv-meta-grid">
            <Meta label="Host" value={`${connection.host}:${connection.port}`} mono />
            <Meta label="Usuario" value={data?.currentUser ?? connection.username} mono />
            <Meta
              label="Default DB"
              value={data?.currentDatabase ?? connection.database ?? "—"}
              mono
            />
            <Meta label="SSL" value={connection.ssl ? "activo" : "desactivado"} />
            <Meta
              label="Hora servidor"
              value={data?.serverTime ? new Date(data.serverTime).toLocaleString() : "—"}
            />
            <Meta
              label="Versión completa"
              value={shortServerVersion(data?.serverVersion)}
              wide
            />
          </dl>
        </div>
      </div>
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

function Meta({
  label,
  value,
  mono,
  wide,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`dv-meta-cell${wide ? " is-wide" : ""}`}>
      <div className="dv-meta-label">{label}</div>
      <div className={`dv-meta-value${mono ? " dv-mono" : ""}`}>{value}</div>
    </div>
  );
}
