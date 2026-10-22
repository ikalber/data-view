"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { DatabaseDriver, TableDetails } from "@data-view/core";
import { useTransport } from "../transport-context";
import {
  TYPE_CATALOG,
  buildAlterStatements,
  columnExtrasQuery,
  draftFromColumn,
  emptyDraft,
  findTypeSpec,
  isExistingDirty,
  joinDataType,
  paramsPlaceholder,
  parseColumnExtras,
  splitDataType,
  validateDrafts,
  type ColumnDraft,
  type ColumnExtras,
} from "../structure-sql";

interface Props {
  connectionId: string;
  driver: DatabaseDriver | null;
  schema: string;
  name: string;
  details: TableDetails | null;
  loading: boolean;
  onAfterSave: () => void;
  onOpenInSqlEditor: (sql: string) => void;
}

export function StructureEditor({
  connectionId,
  driver,
  schema,
  name,
  details,
  loading,
  onAfterSave,
  onOpenInSqlEditor,
}: Props) {
  const transport = useTransport();
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  const [newSeq, setNewSeq] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Comments / MySQL `extra` / SQL Server full types, tagged with the
  // `details` snapshot they were fetched for. See `columnExtrasQuery`.
  const [extrasState, setExtrasState] = useState<{
    for: TableDetails;
    map: Map<string, ColumnExtras>;
  } | null>(null);
  const extras =
    details && extrasState?.for === details ? extrasState.map : null;
  // Error from a partially applied save, shown again once the refetched
  // details arrive (the reset below would otherwise wipe it).
  const pendingErrorRef = useRef<string | null>(null);

  // Fetch the extra column metadata for each fresh `details` snapshot. A
  // failure isn't fatal: the editor falls back to describeTable's data.
  useEffect(() => {
    if (!details) return;
    const sql = columnExtrasQuery(driver, schema, name);
    if (!sql) {
      setExtrasState({ for: details, map: new Map() });
      return;
    }
    let cancel = false;
    transport
      .runQuery(connectionId, sql)
      .then(
        (r) =>
          !cancel &&
          setExtrasState({ for: details, map: parseColumnExtras(driver, r) }),
      )
      .catch(() => !cancel && setExtrasState({ for: details, map: new Map() }));
    return () => {
      cancel = true;
    };
  }, [details, driver, schema, name, connectionId, transport]);

  function draftsFrom(d: TableDetails, ex: Map<string, ColumnExtras>) {
    return d.columns.map((c) => draftFromColumn(driver, c, ex.get(c.name)));
  }

  // Reset drafts whenever a fresh `details` snapshot (table change or
  // post-save refetch) and its extras arrive.
  useEffect(() => {
    if (!details || !extras) return;
    setDrafts(draftsFrom(details, extras));
    setNewSeq(0);
    setError(pendingErrorRef.current);
    pendingErrorRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details, extras]);

  const dirtyCount = useMemo(
    () =>
      drafts.filter(
        (d) =>
          (d.isNew && (d.name.trim() || d.dataType.trim())) ||
          isExistingDirty(driver, d),
      ).length,
    [drafts, driver],
  );

  const statements = useMemo(
    () => buildAlterStatements(driver, schema, name, drafts),
    [driver, schema, name, drafts],
  );
  const validationErrors = useMemo(
    () => validateDrafts(driver, drafts),
    [driver, drafts],
  );

  function patchDraft(id: string, patch: Partial<ColumnDraft>) {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }

  function toggleDrop(id: string) {
    setDrafts((prev) =>
      prev
        .map((d) => {
          if (d.id !== id) return d;
          if (d.isNew) return d; // handled by removeNew
          return { ...d, isDropped: !d.isDropped };
        })
        .filter(Boolean) as ColumnDraft[],
    );
  }

  function removeNew(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  function addColumn() {
    const seq = newSeq + 1;
    setNewSeq(seq);
    setDrafts((prev) => [...prev, emptyDraft(seq)]);
  }

  function discardAll() {
    if (details) setDrafts(draftsFrom(details, extras ?? new Map()));
    setNewSeq(0);
    setError(null);
  }

  async function saveAll() {
    if (saving || statements.length === 0 || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    let applied = 0;
    try {
      // Run sequentially — drivers don't all support multi-statement, and we
      // want to halt at the first failure rather than leave a partial state.
      for (const sql of statements) {
        await transport.runQuery(connectionId, sql);
        applied++;
      }
      onAfterSave();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (applied > 0) {
        // Each statement runs (and commits) on its own, so what ran is
        // permanent. Reload the structure so the drafts reflect reality
        // (re-running the already-applied statements would just fail again).
        pendingErrorRef.current = `Se aplicaron ${applied} de ${statements.length} sentencias; falló: ${message}`;
        onAfterSave();
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  function previewSql() {
    if (statements.length === 0) return;
    onOpenInSqlEditor(statements.map((s) => s + ";").join("\n"));
  }

  if ((loading && !details) || (details && !extras)) {
    return (
      <div className="dv-empty" style={{ marginTop: 20 }}>
        Cargando estructura…
      </div>
    );
  }
  if (!details) return null;

  const typeOptions = TYPE_CATALOG[driver ?? "postgres"] ?? [];

  return (
    <div style={{ marginTop: 16 }}>
      <div className="dv-struct-toolbar">
        <button className="dv-button is-sm" onClick={addColumn}>
          + Agregar columna
        </button>
        <span className="dv-struct-hint">
          Editá nombre, tipo, null, default y comentario. PK/UNIQUE solo se
          aplican a columnas nuevas — para tablas existentes manejá llaves
          desde la pestaña Indexes.
        </span>
        <div className="dv-struct-toolbar-actions">
          <button
            className="dv-button is-sm"
            onClick={previewSql}
            disabled={statements.length === 0}
            title="Abrir las sentencias en el editor SQL"
          >
            Previsualizar SQL
          </button>
          <button
            className="dv-button is-sm"
            onClick={discardAll}
            disabled={dirtyCount === 0 || saving}
          >
            Descartar
          </button>
          <button
            className="dv-button is-sm is-primary"
            onClick={() => void saveAll()}
            disabled={
              statements.length === 0 || saving || validationErrors.length > 0
            }
          >
            {saving ? "Aplicando…" : `Aplicar (${statements.length})`}
          </button>
        </div>
      </div>

      {error && <div className="dv-error">{error}</div>}
      {validationErrors.map((msg) => (
        <div key={msg} className="dv-error">
          {msg}
        </div>
      ))}

      <div className="dv-card" style={{ overflow: "hidden" }}>
        <div className="dv-card-body is-tight" style={{ overflow: "auto" }}>
          <table className="dv-deflist dv-struct-table">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Columna</th>
                <th>Tipo</th>
                <th style={{ width: 60 }}>Null</th>
                <th>Default</th>
                <th>Comentario</th>
                <th style={{ width: 50 }}>PK</th>
                <th style={{ width: 50 }}>UQ</th>
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => {
                const dirty = d.isNew
                  ? !!(d.name.trim() || d.dataType.trim())
                  : isExistingDirty(driver, d);
                return (
                  <tr
                    key={d.id}
                    className={clsx(
                      "dv-struct-row",
                      d.isNew && "is-new",
                      d.isDropped && "is-dropped",
                      dirty && !d.isDropped && !d.isNew && "is-dirty",
                    )}
                  >
                    <td className="dv-struct-marker">
                      {d.isDropped ? "✕" : d.isNew ? "+" : dirty ? "●" : ""}
                    </td>
                    <td>
                      <input
                        className="dv-input dv-struct-input"
                        value={d.name}
                        disabled={d.isDropped}
                        onChange={(e) =>
                          patchDraft(d.id, { name: e.target.value })
                        }
                        placeholder="nombre"
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      {(() => {
                        const { base: rawBase, params } = splitDataType(
                          d.dataType,
                        );
                        const spec = findTypeSpec(driver, rawBase);
                        // Canonical-cased base from the catalog when known so
                        // the <select> value matches one of its <option>s.
                        // Drivers return mixed casing (MySQL: lowercase,
                        // MSSQL: mixed), but the catalog has one canonical
                        // form per driver — without this, the select silently
                        // falls back to its first option.
                        const selectValue = spec ? spec.base : rawBase;
                        // If the column already has a type that's not in our
                        // catalog (custom domain, vendor extension, …), keep
                        // it selectable so we don't silently lose it.
                        const isCustom = rawBase !== "" && !spec;
                        const showParams = (spec?.params ?? "none") !== "none";
                        return (
                          <div className="dv-struct-type">
                            <select
                              className="dv-select dv-struct-input is-mono"
                              value={selectValue}
                              disabled={d.isDropped}
                              onChange={(e) => {
                                const newBase = e.target.value;
                                const newSpec = findTypeSpec(driver, newBase);
                                // Drop existing params if the new type doesn't
                                // accept any (e.g. switching VARCHAR → TEXT).
                                const keepParams =
                                  (newSpec?.params ?? "none") !== "none"
                                    ? params
                                    : "";
                                patchDraft(d.id, {
                                  dataType: joinDataType(
                                    newSpec ? newSpec.base : newBase,
                                    keepParams,
                                  ),
                                });
                              }}
                            >
                              {selectValue === "" && (
                                <option value="" disabled>
                                  — elegir tipo —
                                </option>
                              )}
                              {isCustom && (
                                <option value={rawBase}>{rawBase}</option>
                              )}
                              {typeOptions.map((opt) => (
                                <option key={opt.base} value={opt.base}>
                                  {opt.base}
                                </option>
                              ))}
                            </select>
                            {showParams && (
                              <input
                                className="dv-input dv-struct-input is-mono dv-struct-type-params"
                                value={params}
                                disabled={d.isDropped}
                                onChange={(e) =>
                                  patchDraft(d.id, {
                                    dataType: joinDataType(
                                      selectValue,
                                      e.target.value,
                                    ),
                                  })
                                }
                                placeholder={paramsPlaceholder(
                                  spec?.params ?? "none",
                                )}
                                spellCheck={false}
                              />
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={d.nullable}
                        disabled={d.isDropped}
                        onChange={(e) =>
                          patchDraft(d.id, { nullable: e.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="dv-input dv-struct-input is-mono"
                        value={d.defaultExpr}
                        disabled={d.isDropped}
                        onChange={(e) =>
                          patchDraft(d.id, { defaultExpr: e.target.value })
                        }
                        placeholder="NULL · 0 · 'foo' · CURRENT_TIMESTAMP"
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <input
                        className="dv-input dv-struct-input"
                        value={d.comment}
                        disabled={d.isDropped}
                        onChange={(e) =>
                          patchDraft(d.id, { comment: e.target.value })
                        }
                        placeholder=""
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {d.isNew ? (
                        <input
                          type="checkbox"
                          checked={d.isPrimaryKey}
                          onChange={(e) =>
                            patchDraft(d.id, {
                              isPrimaryKey: e.target.checked,
                              ...(e.target.checked ? { nullable: false } : {}),
                            })
                          }
                        />
                      ) : d.isPrimaryKey ? (
                        <span className="dv-tag is-accent">PK</span>
                      ) : (
                        <span className="is-dim">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {d.isNew ? (
                        <input
                          type="checkbox"
                          checked={d.isUnique}
                          disabled={d.isPrimaryKey}
                          onChange={(e) =>
                            patchDraft(d.id, { isUnique: e.target.checked })
                          }
                        />
                      ) : d.isUnique && !d.isPrimaryKey ? (
                        <span className="dv-tag is-info">UQ</span>
                      ) : (
                        <span className="is-dim">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {d.isNew ? (
                        <button
                          className="dv-icon-button"
                          onClick={() => removeNew(d.id)}
                          title="Quitar columna nueva"
                          aria-label="Quitar columna nueva"
                        >
                          ✕
                        </button>
                      ) : (
                        <button
                          className="dv-icon-button"
                          onClick={() => toggleDrop(d.id)}
                          title={d.isDropped ? "Cancelar eliminación" : "Eliminar columna"}
                          aria-label="Eliminar columna"
                        >
                          {d.isDropped ? "↺" : "🗑"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {statements.length > 0 && (
        <details className="dv-struct-sql-preview">
          <summary>
            SQL a ejecutar ({statements.length} sentencia
            {statements.length === 1 ? "" : "s"})
          </summary>
          <pre>{statements.map((s) => s + ";").join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
