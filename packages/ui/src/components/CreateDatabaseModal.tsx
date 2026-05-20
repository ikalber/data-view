"use client";

import { useEffect, useRef, useState } from "react";
import type { ConnectionConfig } from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  connection: ConnectionConfig;
  onClose: () => void;
  /** Called with the new schema/database name after a successful CREATE. */
  onCreated: (name: string) => void;
}

const LABELS = {
  postgres: { title: "Crear schema", what: "schema" },
  mssql: { title: "Crear schema", what: "schema" },
  mysql: { title: "Crear database", what: "database" },
} as const;

export function CreateDatabaseModal({ connection, onClose, onCreated }: Props) {
  const transport = useTransport();
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  const [owner, setOwner] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const labels = LABELS[connection.driver];
  const isMysql = connection.driver === "mysql";
  const isPostgres = connection.driver === "postgres";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("El nombre es obligatorio");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await transport.createSchema(connection.id, {
        name: trimmed,
        charset: isMysql ? charset.trim() || undefined : undefined,
        collation: isMysql ? collation.trim() || undefined : undefined,
        owner: isPostgres ? owner.trim() || undefined : undefined,
      });
      onCreated(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="dv-modal"
        style={{ width: 420 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{labels.title}</h2>
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

        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span>Nombre del {labels.what}</span>
            <input
              ref={inputRef}
              type="text"
              className="dv-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="mi_base"
              disabled={running}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {isMysql && (
            <>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                <span>Character set (opcional)</span>
                <input
                  type="text"
                  className="dv-input"
                  value={charset}
                  onChange={(e) => setCharset(e.target.value)}
                  placeholder="utf8mb4"
                  disabled={running}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                <span>Collation (opcional)</span>
                <input
                  type="text"
                  className="dv-input"
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  placeholder="utf8mb4_unicode_ci"
                  disabled={running}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </>
          )}

          {isPostgres && (
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Owner (opcional)</span>
              <input
                type="text"
                className="dv-input"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="postgres"
                disabled={running}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
        </div>

        {error && (
          <div className="dv-error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="dv-modal-actions">
          <button
            type="button"
            className="dv-button"
            onClick={onClose}
            disabled={running}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="dv-button is-primary"
            onClick={submit}
            disabled={running || !name.trim()}
          >
            {running ? "Creando…" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}
