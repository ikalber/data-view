"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type {
  ColumnInfo,
  DatabaseDriver,
  TableDetails,
} from "@data-view/core";
import { useTransport } from "../transport-context";

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

interface ColumnDraft {
  /** Stable id: original name for existing rows, "new:n" for added rows. */
  id: string;
  isNew: boolean;
  isDropped: boolean;
  original?: ColumnInfo;
  name: string;
  dataType: string;
  nullable: boolean;
  /** Raw default expression as the user typed it (verbatim into SQL). Empty
   *  string means "no default"; literal `NULL` means SET DEFAULT NULL. */
  defaultExpr: string;
  comment: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
}

function quoteIdent(driver: DatabaseDriver | null, s: string): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
        ? `"${s}"`
        : `"${s.replace(/"/g, '""')}"`;
  }
}

function quoteStringLit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function qualified(
  driver: DatabaseDriver | null,
  schema: string,
  table: string,
): string {
  return `${quoteIdent(driver, schema)}.${quoteIdent(driver, table)}`;
}

/** Per-driver catalog of base data types. The base goes in the <select>; if
 *  the type accepts parameters (length / precision / enum values), an adjacent
 *  input collects them. The combined `base(params)` becomes the dataType. */
type ParamSpec = "none" | "length" | "precision-scale" | "enum";

interface TypeOption {
  base: string;
  params: ParamSpec;
}

const TYPE_CATALOG: Record<DatabaseDriver, TypeOption[]> = {
  mysql: [
    { base: "TINYINT", params: "length" },
    { base: "SMALLINT", params: "length" },
    { base: "MEDIUMINT", params: "length" },
    { base: "INT", params: "length" },
    { base: "BIGINT", params: "length" },
    { base: "DECIMAL", params: "precision-scale" },
    { base: "FLOAT", params: "none" },
    { base: "DOUBLE", params: "none" },
    { base: "BIT", params: "length" },
    { base: "BOOLEAN", params: "none" },
    { base: "CHAR", params: "length" },
    { base: "VARCHAR", params: "length" },
    { base: "TINYTEXT", params: "none" },
    { base: "TEXT", params: "none" },
    { base: "MEDIUMTEXT", params: "none" },
    { base: "LONGTEXT", params: "none" },
    { base: "BINARY", params: "length" },
    { base: "VARBINARY", params: "length" },
    { base: "TINYBLOB", params: "none" },
    { base: "BLOB", params: "none" },
    { base: "MEDIUMBLOB", params: "none" },
    { base: "LONGBLOB", params: "none" },
    { base: "JSON", params: "none" },
    { base: "DATE", params: "none" },
    { base: "DATETIME", params: "none" },
    { base: "TIMESTAMP", params: "none" },
    { base: "TIME", params: "none" },
    { base: "YEAR", params: "none" },
    { base: "ENUM", params: "enum" },
    { base: "SET", params: "enum" },
  ],
  postgres: [
    { base: "smallint", params: "none" },
    { base: "integer", params: "none" },
    { base: "bigint", params: "none" },
    { base: "smallserial", params: "none" },
    { base: "serial", params: "none" },
    { base: "bigserial", params: "none" },
    { base: "decimal", params: "precision-scale" },
    { base: "numeric", params: "precision-scale" },
    { base: "real", params: "none" },
    { base: "double precision", params: "none" },
    { base: "money", params: "none" },
    { base: "varchar", params: "length" },
    { base: "character varying", params: "length" },
    { base: "char", params: "length" },
    { base: "character", params: "length" },
    { base: "text", params: "none" },
    { base: "bytea", params: "none" },
    { base: "timestamp", params: "none" },
    { base: "timestamptz", params: "none" },
    { base: "date", params: "none" },
    { base: "time", params: "none" },
    { base: "timetz", params: "none" },
    { base: "interval", params: "none" },
    { base: "boolean", params: "none" },
    { base: "uuid", params: "none" },
    { base: "json", params: "none" },
    { base: "jsonb", params: "none" },
    { base: "xml", params: "none" },
    { base: "inet", params: "none" },
    { base: "cidr", params: "none" },
    { base: "macaddr", params: "none" },
    { base: "bit", params: "length" },
    { base: "bit varying", params: "length" },
    { base: "tsvector", params: "none" },
    { base: "tsquery", params: "none" },
  ],
  mssql: [
    { base: "BIT", params: "none" },
    { base: "TINYINT", params: "none" },
    { base: "SMALLINT", params: "none" },
    { base: "INT", params: "none" },
    { base: "BIGINT", params: "none" },
    { base: "DECIMAL", params: "precision-scale" },
    { base: "NUMERIC", params: "precision-scale" },
    { base: "MONEY", params: "none" },
    { base: "SMALLMONEY", params: "none" },
    { base: "FLOAT", params: "none" },
    { base: "REAL", params: "none" },
    { base: "DATE", params: "none" },
    { base: "TIME", params: "none" },
    { base: "DATETIME", params: "none" },
    { base: "DATETIME2", params: "none" },
    { base: "DATETIMEOFFSET", params: "none" },
    { base: "SMALLDATETIME", params: "none" },
    { base: "CHAR", params: "length" },
    { base: "VARCHAR", params: "length" },
    { base: "NCHAR", params: "length" },
    { base: "NVARCHAR", params: "length" },
    { base: "TEXT", params: "none" },
    { base: "NTEXT", params: "none" },
    { base: "BINARY", params: "length" },
    { base: "VARBINARY", params: "length" },
    { base: "IMAGE", params: "none" },
    { base: "UNIQUEIDENTIFIER", params: "none" },
    { base: "XML", params: "none" },
    { base: "ROWVERSION", params: "none" },
  ],
};

/** Split "VARCHAR(255)" into { base: "VARCHAR", params: "(255)" }. Tolerates
 *  spaces and multi-word bases like "double precision". */
function splitDataType(dt: string): { base: string; params: string } {
  const trimmed = dt.trim();
  if (!trimmed) return { base: "", params: "" };
  const open = trimmed.indexOf("(");
  if (open < 0) return { base: trimmed, params: "" };
  return {
    base: trimmed.slice(0, open).trim(),
    params: trimmed.slice(open).trim(),
  };
}

function findTypeSpec(
  driver: DatabaseDriver | null,
  base: string,
): TypeOption | undefined {
  const list = TYPE_CATALOG[driver ?? "postgres"] ?? [];
  const lower = base.toLowerCase();
  return list.find((t) => t.base.toLowerCase() === lower);
}

function joinDataType(base: string, params: string): string {
  const b = base.trim();
  const p = params.trim();
  if (!b) return p;
  if (!p) return b;
  return `${b}${p.startsWith("(") ? p : `(${p})`}`;
}

function paramsPlaceholder(spec: ParamSpec): string {
  switch (spec) {
    case "length":
      return "(255)";
    case "precision-scale":
      return "(10,2)";
    case "enum":
      return "('a','b')";
    default:
      return "";
  }
}

/** Normalize a dataType string to the catalog's canonical form so casing
 *  drift between the driver (e.g. MySQL returns lowercase) and the editor
 *  (catalog uses MySQL uppercase) doesn't show up as a spurious diff. */
function normalizeDataType(driver: DatabaseDriver | null, dt: string): string {
  const { base, params } = splitDataType(dt);
  const spec = findTypeSpec(driver, base);
  return joinDataType(spec ? spec.base : base, params);
}

function draftFromColumn(c: ColumnInfo): ColumnDraft {
  return {
    id: c.name,
    isNew: false,
    isDropped: false,
    original: c,
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultExpr: c.default ?? "",
    comment: c.comment ?? "",
    isPrimaryKey: c.isPrimaryKey,
    isUnique: c.isUnique,
  };
}

function emptyDraft(seq: number): ColumnDraft {
  return {
    id: `new:${seq}`,
    isNew: true,
    isDropped: false,
    name: "",
    dataType: "",
    nullable: true,
    defaultExpr: "",
    comment: "",
    isPrimaryKey: false,
    isUnique: false,
  };
}

function isExistingDirty(
  driver: DatabaseDriver | null,
  d: ColumnDraft,
): boolean {
  if (!d.original) return false;
  if (d.isDropped) return true;
  return (
    d.name !== d.original.name ||
    normalizeDataType(driver, d.dataType) !==
      normalizeDataType(driver, d.original.dataType) ||
    d.nullable !== d.original.nullable ||
    (d.defaultExpr || "") !== (d.original.default ?? "") ||
    (d.comment || "") !== (d.original.comment ?? "")
  );
}

/** Build the column-definition fragment used in ADD/MODIFY/CHANGE. */
function colDefFragment(driver: DatabaseDriver | null, d: ColumnDraft): string {
  const parts: string[] = [d.dataType.trim() || "TEXT"];
  parts.push(d.nullable ? "NULL" : "NOT NULL");
  if (d.defaultExpr.trim() !== "") {
    parts.push(`DEFAULT ${d.defaultExpr.trim()}`);
  }
  // Inline PK/UNIQUE only on ADD COLUMN — drivers accept it inline for new
  // columns, while toggling on existing requires constraint statements which
  // we don't generate from this editor (that's the Indexes tab's job).
  if (d.isNew) {
    if (d.isPrimaryKey) parts.push("PRIMARY KEY");
    else if (d.isUnique) parts.push("UNIQUE");
  }
  if (driver === "mysql" && d.comment.trim() !== "") {
    parts.push(`COMMENT ${quoteStringLit(d.comment.trim())}`);
  }
  return parts.join(" ");
}

/** Produce the ordered list of SQL statements that turn `originals` into the
 *  current `drafts`. Statements are run sequentially; first failure halts. */
function buildAlterStatements(
  driver: DatabaseDriver | null,
  schema: string,
  table: string,
  drafts: ColumnDraft[],
): string[] {
  const out: string[] = [];
  const tableRef = qualified(driver, schema, table);

  // Drops first: avoids name conflicts when renaming or re-adding.
  for (const d of drafts) {
    if (d.original && d.isDropped) {
      out.push(
        `ALTER TABLE ${tableRef} DROP COLUMN ${quoteIdent(driver, d.original.name)}`,
      );
    }
  }

  // Modifications.
  for (const d of drafts) {
    if (!d.original || d.isDropped || !isExistingDirty(driver, d)) continue;
    const oldName = d.original.name;
    const newName = d.name.trim() || oldName;

    if (driver === "mysql") {
      // CHANGE COLUMN handles rename + full redefinition in one shot.
      out.push(
        `ALTER TABLE ${tableRef} CHANGE COLUMN ${quoteIdent(driver, oldName)} ${quoteIdent(
          driver,
          newName,
        )} ${colDefFragment(driver, d)}`,
      );
    } else if (driver === "postgres") {
      if (newName !== oldName) {
        out.push(
          `ALTER TABLE ${tableRef} RENAME COLUMN ${quoteIdent(driver, oldName)} TO ${quoteIdent(driver, newName)}`,
        );
      }
      const colRef = quoteIdent(driver, newName);
      if (d.dataType.trim() !== d.original.dataType) {
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} TYPE ${d.dataType.trim()}`,
        );
      }
      if (d.nullable !== d.original.nullable) {
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} ${d.nullable ? "DROP" : "SET"} NOT NULL`,
        );
      }
      const newDefault = d.defaultExpr.trim();
      const oldDefault = (d.original.default ?? "").trim();
      if (newDefault !== oldDefault) {
        out.push(
          newDefault === ""
            ? `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} DROP DEFAULT`
            : `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} SET DEFAULT ${newDefault}`,
        );
      }
      const newComment = d.comment.trim();
      const oldComment = (d.original.comment ?? "").trim();
      if (newComment !== oldComment) {
        out.push(
          `COMMENT ON COLUMN ${tableRef}.${colRef} IS ${newComment === "" ? "NULL" : quoteStringLit(newComment)}`,
        );
      }
    } else {
      // mssql — best effort; SSMS-style separate statements.
      if (newName !== oldName) {
        out.push(
          `EXEC sp_rename ${quoteStringLit(`${schema}.${table}.${oldName}`)}, ${quoteStringLit(newName)}, 'COLUMN'`,
        );
      }
      const colRef = quoteIdent(driver, newName);
      if (
        d.dataType.trim() !== d.original.dataType ||
        d.nullable !== d.original.nullable
      ) {
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} ${d.dataType.trim() || d.original.dataType} ${d.nullable ? "NULL" : "NOT NULL"}`,
        );
      }
      // Defaults/comments on MSSQL require named constraints / extended
      // properties — out of scope for this editor.
    }
  }

  // Adds last so renames clear the old names.
  for (const d of drafts) {
    if (!d.isNew || d.isDropped) continue;
    if (!d.name.trim()) continue;
    out.push(
      `ALTER TABLE ${tableRef} ADD COLUMN ${quoteIdent(driver, d.name.trim())} ${colDefFragment(driver, d)}`,
    );
    if (driver === "postgres" && d.comment.trim() !== "") {
      out.push(
        `COMMENT ON COLUMN ${tableRef}.${quoteIdent(driver, d.name.trim())} IS ${quoteStringLit(d.comment.trim())}`,
      );
    }
  }

  return out;
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

  // Reset drafts whenever a fresh `details` snapshot arrives (table change or
  // post-save refetch).
  useEffect(() => {
    if (!details) return;
    setDrafts(details.columns.map(draftFromColumn));
    setNewSeq(0);
    setError(null);
  }, [details]);

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
    if (details) setDrafts(details.columns.map(draftFromColumn));
    setNewSeq(0);
    setError(null);
  }

  async function saveAll() {
    if (saving || statements.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      // Run sequentially — drivers don't all support multi-statement, and we
      // want to halt at the first failure rather than leave a partial state.
      for (const sql of statements) {
        await transport.runQuery(connectionId, sql);
      }
      onAfterSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function previewSql() {
    if (statements.length === 0) return;
    onOpenInSqlEditor(statements.map((s) => s + ";").join("\n"));
  }

  if (loading && !details) {
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
            disabled={statements.length === 0 || saving}
          >
            {saving ? "Aplicando…" : `Aplicar (${statements.length})`}
          </button>
        </div>
      </div>

      {error && <div className="dv-error">{error}</div>}

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
