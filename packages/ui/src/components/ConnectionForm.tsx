"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  defaultPort,
  driverLabel,
  type ConnectionInput,
  type DatabaseDriver,
  type Folder,
  type Tag,
  type TestConnectionResult,
} from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  folders: Folder[];
  tags: Tag[];
  initial?: Partial<ConnectionInput> & {
    id?: string;
    folderId?: string | null;
    tagIds?: string[];
  };
  onCancel: () => void;
  onSaved: (id: string) => void;
}

const DRIVERS: DatabaseDriver[] = ["postgres", "mysql", "mssql"];

/** Port to show after switching driver: follow the new driver's default
 * unless the user had typed a custom port (e.g. a Docker-mapped 15432). */
export function portAfterDriverChange(
  prevDriver: DatabaseDriver,
  nextDriver: DatabaseDriver,
  port: number,
): number {
  if (!Number.isInteger(port) || port <= 0 || port === defaultPort(prevDriver)) {
    return defaultPort(nextDriver);
  }
  return port;
}

/** Spanish error for the fields we can check client-side, or null. */
export function validateConnectionInput(form: ConnectionInput): string | null {
  if (!form.name.trim()) return "El nombre es obligatorio.";
  if (!form.host.trim()) return "El host es obligatorio.";
  if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) {
    return "El puerto tiene que ser un número entre 1 y 65535.";
  }
  return null;
}

export function ConnectionForm({ folders, tags, initial, onCancel, onSaved }: Props) {
  const transport = useTransport();
  const [form, setForm] = useState<ConnectionInput>({
    name: initial?.name ?? "Nueva conexión",
    driver: initial?.driver ?? "postgres",
    host: initial?.host ?? "localhost",
    port: initial?.port ?? defaultPort(initial?.driver ?? "postgres"),
    database: initial?.database ?? "",
    username: initial?.username ?? "",
    password: initial?.password ?? "",
    ssl: initial?.ssl ?? false,
    options: initial?.options ?? {},
    folderId: initial?.folderId ?? null,
    tagIds: initial?.tagIds ?? [],
    id: initial?.id,
  });
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every edit so a "Probar" still in flight doesn't report its
  // result for a config the user has since changed.
  const testSeqRef = useRef(0);

  function update<K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    testSeqRef.current += 1;
    setTest(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function toggleTag(id: string) {
    setForm((f) => {
      const current = f.tagIds ?? [];
      const next = current.includes(id)
        ? current.filter((t) => t !== id)
        : [...current, id];
      return { ...f, tagIds: next };
    });
  }

  async function handleTest() {
    const invalid = validateConnectionInput(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    const seq = ++testSeqRef.current;
    try {
      const res = await transport.testConnection(form);
      if (seq === testSeqRef.current) setTest(res);
    } catch (e) {
      if (seq === testSeqRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    const invalid = validateConnectionInput(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await transport.saveConnection(form);
      onSaved(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selectedTagIds = new Set(form.tagIds ?? []);

  return (
    <div className="dv-modal-backdrop" role="dialog" aria-modal>
      <div className="dv-modal">
        <h2>{initial?.id ? "Editar conexión" : "Nueva conexión"}</h2>

        <div className="dv-form-row">
          <label>Nombre</label>
          <input
            className="dv-input"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </div>
        <div className="dv-form-row">
          <label>Motor</label>
          <select
            className="dv-select"
            value={form.driver}
            onChange={(e) => {
              const driver = e.target.value as DatabaseDriver;
              setForm((f) => ({
                ...f,
                driver,
                port: portAfterDriverChange(f.driver, driver, f.port),
              }));
              testSeqRef.current += 1;
              setTest(null);
            }}
          >
            {DRIVERS.map((d) => (
              <option key={d} value={d}>
                {driverLabel(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="dv-form-row">
          <label>Host</label>
          <input
            className="dv-input"
            value={form.host}
            onChange={(e) => update("host", e.target.value)}
          />
        </div>
        <div className="dv-form-row">
          <label>Puerto</label>
          <input
            className="dv-input"
            type="number"
            value={form.port}
            onChange={(e) => update("port", Number(e.target.value))}
          />
        </div>
        <div className="dv-form-row">
          <label>Base de datos</label>
          <input
            className="dv-input"
            value={form.database}
            onChange={(e) => update("database", e.target.value)}
          />
        </div>
        <div className="dv-form-row">
          <label>Usuario</label>
          <input
            className="dv-input"
            value={form.username}
            onChange={(e) => update("username", e.target.value)}
          />
        </div>
        <div className="dv-form-row">
          <label>Contraseña</label>
          <input
            className="dv-input"
            type="password"
            value={form.password ?? ""}
            onChange={(e) => update("password", e.target.value)}
            // The saved password never reaches the UI; leaving this blank
            // keeps it.
            placeholder={initial?.id ? "Sin cambios" : undefined}
            autoComplete="new-password"
          />
        </div>
        <div className="dv-form-row">
          <label>SSL</label>
          <input
            type="checkbox"
            checked={!!form.ssl}
            onChange={(e) => update("ssl", e.target.checked)}
          />
        </div>
        <div className="dv-form-row">
          <label>Carpeta</label>
          <select
            className="dv-select"
            value={form.folderId ?? ""}
            onChange={(e) =>
              update("folderId", e.target.value ? e.target.value : null)
            }
          >
            <option value="">Sin carpeta</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="dv-form-row dv-form-row-stack">
          <label>Etiquetas</label>
          {tags.length === 0 ? (
            <span className="dv-text-mute" style={{ fontSize: 12 }}>
              Aún no hay etiquetas. Creá algunas desde "Gestionar".
            </span>
          ) : (
            <div className="dv-tag-cloud">
              {tags.map((t) => {
                const selected = selectedTagIds.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={clsx(
                      "dv-tag dv-tag-toggle",
                      `is-${t.color}`,
                      selected && "is-selected",
                    )}
                    onClick={() => toggleTag(t.id)}
                    aria-pressed={selected}
                  >
                    {selected ? "✓ " : ""}
                    {t.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {test && (
          <div
            className={test.ok ? "dv-status-ok" : "dv-status-fail"}
            style={{ fontSize: 12, marginTop: 8 }}
          >
            {test.ok ? "✓" : "✗"} {test.message}
            {test.latencyMs != null && ` (${test.latencyMs}ms)`}
          </div>
        )}
        {error && <div className="dv-error">{error}</div>}

        <div className="dv-modal-actions">
          <button className="dv-button" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button className="dv-button" onClick={handleTest} disabled={busy}>
            Probar
          </button>
          <button className="dv-button is-primary" onClick={handleSave} disabled={busy}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
