"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type {
  ConnectionConfig,
  CreateTableColumn,
  CreateTableForeignKey,
  CreateTableIndex,
  DatabaseDriver,
  SchemaInfo,
} from "@data-view/core";
import { quoteIdent } from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  connection: ConnectionConfig;
  schemas: SchemaInfo[];
  initialSchema: string | null;
  onClose: () => void;
  /** Called with `{ schema, name }` after a successful CREATE. */
  onCreated: (info: { schema: string; name: string }) => void;
}

const CUSTOM = "__custom__";
const ENUM = "__enum__";

interface TypeParam {
  /** Short label shown above the input (e.g. "length", "precision", "scale"). */
  label: string;
  /** Default value used when the user picks this type. */
  default: string;
  /** Optional placeholder hint (e.g. "n o max" for nvarchar). */
  placeholder?: string;
}

interface TypeOption {
  /** Stable key for the `<select>` value. */
  key: string;
  /** Human label shown in the dropdown. Includes the parametrized form
   * (e.g. "varchar(n)") so the user knows extra inputs will appear. */
  label: string;
  /** Base SQL token (e.g. "varchar", "INT"). When `params` is set, the
   * emitted SQL is `${base}(${params.join(",")})`. */
  base: string;
  /** Appended verbatim after the params (e.g. " AUTO_INCREMENT"). */
  suffix?: string;
  /** Positional parameters. When absent the type is emitted as `base + suffix`. */
  params?: TypeParam[];
}

/** Driver-specific catalog of common SQL types. Order shown in the dropdown.
 * Each parametric type renders extra inputs below the select. The user can
 * also pick `Personalizado…` for anything outside the catalog. */
const TYPE_CATALOG: Record<DatabaseDriver, TypeOption[]> = {
  postgres: [
    { key: "serial", label: "serial (auto-incremental)", base: "serial" },
    { key: "bigserial", label: "bigserial (auto-incremental)", base: "bigserial" },
    { key: "integer", label: "integer", base: "integer" },
    { key: "bigint", label: "bigint", base: "bigint" },
    { key: "smallint", label: "smallint", base: "smallint" },
    {
      key: "numeric",
      label: "numeric(p,s)",
      base: "numeric",
      params: [
        { label: "precision", default: "10" },
        { label: "scale", default: "2" },
      ],
    },
    { key: "real", label: "real", base: "real" },
    { key: "double", label: "double precision", base: "double precision" },
    { key: "boolean", label: "boolean", base: "boolean" },
    { key: "text", label: "text", base: "text" },
    {
      key: "varchar",
      label: "varchar(n)",
      base: "varchar",
      params: [{ label: "length", default: "255" }],
    },
    {
      key: "char",
      label: "char(n)",
      base: "char",
      params: [{ label: "length", default: "1" }],
    },
    { key: "date", label: "date", base: "date" },
    { key: "timestamp", label: "timestamp", base: "timestamp" },
    { key: "timestamptz", label: "timestamptz", base: "timestamptz" },
    { key: "time", label: "time", base: "time" },
    { key: "uuid", label: "uuid", base: "uuid" },
    { key: "jsonb", label: "jsonb", base: "jsonb" },
    { key: "json", label: "json", base: "json" },
  ],
  mysql: [
    {
      key: "int_ai",
      label: "INT (auto-incremental)",
      base: "INT",
      suffix: " AUTO_INCREMENT",
    },
    {
      key: "bigint_ai",
      label: "BIGINT (auto-incremental)",
      base: "BIGINT",
      suffix: " AUTO_INCREMENT",
    },
    { key: "int", label: "INT", base: "INT" },
    { key: "bigint", label: "BIGINT", base: "BIGINT" },
    { key: "tinyint", label: "TINYINT", base: "TINYINT" },
    { key: "smallint", label: "SMALLINT", base: "SMALLINT" },
    {
      key: "decimal",
      label: "DECIMAL(p,s)",
      base: "DECIMAL",
      params: [
        { label: "precision", default: "10" },
        { label: "scale", default: "2" },
      ],
    },
    {
      key: "float",
      label: "FLOAT(p,s)",
      base: "FLOAT",
      params: [
        { label: "precision", default: "10" },
        { label: "scale", default: "2" },
      ],
    },
    {
      key: "double",
      label: "DOUBLE(p,s)",
      base: "DOUBLE",
      params: [
        { label: "precision", default: "16" },
        { label: "scale", default: "4" },
      ],
    },
    { key: "boolean", label: "BOOLEAN", base: "BOOLEAN" },
    {
      key: "varchar",
      label: "VARCHAR(n)",
      base: "VARCHAR",
      params: [{ label: "length", default: "255" }],
    },
    { key: "text", label: "TEXT", base: "TEXT" },
    {
      key: "char",
      label: "CHAR(n)",
      base: "CHAR",
      params: [{ label: "length", default: "1" }],
    },
    { key: "date", label: "DATE", base: "DATE" },
    { key: "datetime", label: "DATETIME", base: "DATETIME" },
    { key: "timestamp", label: "TIMESTAMP", base: "TIMESTAMP" },
    { key: "time", label: "TIME", base: "TIME" },
    { key: "json", label: "JSON", base: "JSON" },
  ],
  mssql: [
    {
      key: "int_id",
      label: "INT (IDENTITY)",
      base: "int",
      suffix: " IDENTITY(1,1)",
    },
    {
      key: "bigint_id",
      label: "BIGINT (IDENTITY)",
      base: "bigint",
      suffix: " IDENTITY(1,1)",
    },
    { key: "int", label: "int", base: "int" },
    { key: "bigint", label: "bigint", base: "bigint" },
    { key: "smallint", label: "smallint", base: "smallint" },
    { key: "tinyint", label: "tinyint", base: "tinyint" },
    { key: "bit", label: "bit", base: "bit" },
    {
      key: "decimal",
      label: "decimal(p,s)",
      base: "decimal",
      params: [
        { label: "precision", default: "10" },
        { label: "scale", default: "2" },
      ],
    },
    {
      key: "float",
      label: "float(n)",
      base: "float",
      params: [{ label: "precision", default: "53" }],
    },
    {
      key: "nvarchar",
      label: "nvarchar(n)",
      base: "nvarchar",
      params: [{ label: "length", default: "255", placeholder: "n o max" }],
    },
    {
      key: "varchar",
      label: "varchar(n)",
      base: "varchar",
      params: [{ label: "length", default: "255", placeholder: "n o max" }],
    },
    {
      key: "nchar",
      label: "nchar(n)",
      base: "nchar",
      params: [{ label: "length", default: "1" }],
    },
    {
      key: "char",
      label: "char(n)",
      base: "char",
      params: [{ label: "length", default: "1" }],
    },
    { key: "date", label: "date", base: "date" },
    { key: "datetime2", label: "datetime2", base: "datetime2" },
    { key: "time", label: "time", base: "time" },
    { key: "uniqueidentifier", label: "uniqueidentifier", base: "uniqueidentifier" },
  ],
};

function findOption(driver: DatabaseDriver, key: string): TypeOption | null {
  return TYPE_CATALOG[driver].find((t) => t.key === key) ?? null;
}

function defaultParamsFor(option: TypeOption | null): string[] {
  return option?.params?.map((p) => p.default) ?? [];
}

interface FkDraft {
  uid: string;
  name: string;
  /** Local columns on the new table — comma-separated names. */
  columns: string;
  referencedSchema: string;
  referencedTable: string;
  /** Comma-separated; must match the number of local columns. */
  referencedColumns: string;
  /** ON UPDATE action; empty string means "don't emit clause". */
  onUpdate: string;
  /** ON DELETE action; empty string means "don't emit clause". */
  onDelete: string;
}

interface IndexDraft {
  uid: string;
  /** Optional explicit name; when empty the adapter auto-generates one. */
  name: string;
  /** Comma-separated column names. */
  columns: string;
  unique: boolean;
}

const FK_ACTIONS = [
  "",
  "CASCADE",
  "RESTRICT",
  "SET NULL",
  "SET DEFAULT",
  "NO ACTION",
] as const;

function blankFk(defaultRefSchema: string): FkDraft {
  return {
    uid: uid(),
    name: "",
    columns: "",
    referencedSchema: defaultRefSchema,
    referencedTable: "",
    referencedColumns: "",
    onUpdate: "",
    onDelete: "",
  };
}

function blankIndex(): IndexDraft {
  return {
    uid: uid(),
    name: "",
    columns: "",
    unique: false,
  };
}

function parseCommaList(s: string): string[] {
  return s
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

interface DraftColumn {
  /** Stable id so the row inputs aren't re-mounted on reorder. */
  uid: string;
  name: string;
  /** Selected key from the type catalog, or CUSTOM/ENUM sentinels. */
  typeChoice: string;
  /** Positional parameter values for the selected catalog type — same order
   * as `TypeOption.params`. Empty when the type has no params. */
  typeParams: string[];
  /** Free-text SQL when typeChoice === CUSTOM. */
  customType: string;
  /** Enum values when typeChoice === ENUM. Order matters — we emit them
   * verbatim. */
  enumValues: string[];
  nullable: boolean;
  primaryKey: boolean;
  /** Raw default expression (placed after `DEFAULT` literal-style: 0, 'x',
   * NOW(), etc.). */
  default: string | null;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function defaultIdColumn(driver: DatabaseDriver): DraftColumn {
  const idKey =
    driver === "postgres" ? "serial" : driver === "mssql" ? "int_id" : "int_ai";
  return {
    uid: uid(),
    name: "id",
    typeChoice: idKey,
    typeParams: defaultParamsFor(findOption(driver, idKey)),
    customType: "",
    enumValues: [],
    nullable: false,
    primaryKey: true,
    default: null,
  };
}

function blankColumn(driver: DatabaseDriver): DraftColumn {
  const defaultKey =
    driver === "postgres"
      ? "varchar"
      : driver === "mssql"
      ? "nvarchar"
      : "varchar";
  return {
    uid: uid(),
    name: "",
    typeChoice: defaultKey,
    typeParams: defaultParamsFor(findOption(driver, defaultKey)),
    customType: "",
    enumValues: [],
    nullable: true,
    primaryKey: false,
    default: null,
  };
}

const SCHEMA_LABEL: Record<DatabaseDriver, string> = {
  postgres: "Schema",
  mssql: "Schema",
  mysql: "Database",
};

/** Build the SQL data-type string for the given draft column. For non-MySQL
 * drivers the ENUM is emitted as a CHECK constraint that references the
 * column itself, so the result includes the constraint clause. */
function resolveDataType(col: DraftColumn, driver: DatabaseDriver): string {
  if (col.typeChoice === CUSTOM) return col.customType.trim();
  if (col.typeChoice === ENUM) {
    const values = col.enumValues.filter((v) => v.length > 0);
    if (values.length === 0) return "";
    const literals = values.map(quoteLit).join(", ");
    if (driver === "mysql") return `ENUM(${literals})`;
    // Postgres / SQL Server: emit a CHECK constraint referencing this column.
    // The adapter concatenates `<name> <dataType>` so the CHECK lands after
    // the type as a column-level constraint.
    const colRef = quoteIdent(driver, col.name || "valor");
    const stringType = driver === "postgres" ? "text" : "nvarchar(255)";
    return `${stringType} CHECK (${colRef} IN (${literals}))`;
  }
  const entry = findOption(driver, col.typeChoice);
  if (!entry) return "";
  return buildOptionSql(entry, col.typeParams);
}

/** Compose the SQL for a catalog option using the user-provided params.
 * Falls back to each param's default when the user left it blank. */
function buildOptionSql(option: TypeOption, paramValues: string[]): string {
  let s = option.base;
  if (option.params && option.params.length > 0) {
    const values = option.params.map((p, i) =>
      (paramValues[i] ?? "").trim() || p.default,
    );
    s += `(${values.join(",")})`;
  }
  if (option.suffix) s += option.suffix;
  return s;
}

function quoteLit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function CreateTableModal({
  connection,
  schemas,
  initialSchema,
  onClose,
  onCreated,
}: Props) {
  const transport = useTransport();
  const driver = connection.driver;
  const catalog = TYPE_CATALOG[driver];

  const userSchemas = useMemo(
    () => schemas.filter((s) => !s.isSystem),
    [schemas],
  );
  const [schemaName, setSchemaName] = useState<string>(
    initialSchema && userSchemas.some((s) => s.name === initialSchema)
      ? initialSchema
      : userSchemas[0]?.name ?? "",
  );
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<DraftColumn[]>(() => [
    defaultIdColumn(driver),
  ]);
  const [foreignKeys, setForeignKeys] = useState<FkDraft[]>([]);
  const [indexes, setIndexes] = useState<IndexDraft[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tables visible to the user, grouped by schema, used by the FK editor's
  // "referenced table" dropdown. Fetched on-demand per schema as the user
  // picks one.
  const [tablesByRefSchema, setTablesByRefSchema] = useState<
    Record<string, string[]>
  >({});

  async function ensureTablesFor(schema: string) {
    if (tablesByRefSchema[schema] || !schema.trim()) return;
    try {
      const rels = await transport.listRelations(connection.id, schema);
      setTablesByRefSchema((prev) => ({
        ...prev,
        [schema]: rels.map((r) => r.name),
      }));
    } catch {
      setTablesByRefSchema((prev) => ({ ...prev, [schema]: [] }));
    }
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  function update(idx: number, patch: Partial<DraftColumn>) {
    setColumns((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
  }
  function remove(idx: number) {
    setColumns((prev) => prev.filter((_, i) => i !== idx));
  }
  function add() {
    setColumns((prev) => [...prev, blankColumn(driver)]);
  }
  function moveUp(idx: number) {
    if (idx === 0) return;
    setColumns((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
      return next;
    });
  }
  function moveDown(idx: number) {
    setColumns((prev) => {
      if (idx === prev.length - 1) return prev;
      const next = [...prev];
      [next[idx + 1], next[idx]] = [next[idx]!, next[idx + 1]!];
      return next;
    });
  }

  async function submit() {
    if (!schemaName.trim()) {
      setError(
        `Tenés que elegir un ${SCHEMA_LABEL[driver].toLowerCase()}`,
      );
      return;
    }
    if (!tableName.trim()) {
      setError("El nombre de la tabla es obligatorio");
      return;
    }
    if (columns.length === 0) {
      setError("Agregá al menos una columna");
      return;
    }
    // Validate per-column before sending — the server validates again but
    // doing it here gives a nicer message.
    const resolved: CreateTableColumn[] = [];
    for (const c of columns) {
      if (!c.name.trim()) {
        setError("Hay una columna sin nombre");
        return;
      }
      if (c.typeChoice === ENUM && c.enumValues.length === 0) {
        setError(`La columna "${c.name}" es enum pero no tiene valores`);
        return;
      }
      const dataType = resolveDataType(c, driver);
      if (!dataType) {
        setError(`Falta el tipo de "${c.name}"`);
        return;
      }
      resolved.push({
        name: c.name.trim(),
        dataType,
        nullable: c.nullable,
        primaryKey: c.primaryKey,
        default: c.default?.trim() || null,
      });
    }
    // Resolve FKs.
    const resolvedFks: CreateTableForeignKey[] = [];
    for (const fk of foreignKeys) {
      const localCols = parseCommaList(fk.columns);
      const refCols = parseCommaList(fk.referencedColumns);
      if (localCols.length === 0 && refCols.length === 0 && !fk.referencedTable.trim()) {
        continue; // skip empty rows silently
      }
      if (localCols.length === 0) {
        setError("Un FK no tiene columnas locales");
        return;
      }
      if (!fk.referencedTable.trim()) {
        setError("Un FK no tiene tabla referenciada");
        return;
      }
      if (localCols.length !== refCols.length) {
        setError(
          `FK "${fk.referencedTable}": ${localCols.length} columnas locales pero ${refCols.length} referenciadas`,
        );
        return;
      }
      resolvedFks.push({
        name: fk.name.trim() || undefined,
        columns: localCols,
        referencedSchema: fk.referencedSchema.trim() || schemaName.trim(),
        referencedTable: fk.referencedTable.trim(),
        referencedColumns: refCols,
        onUpdate: fk.onUpdate || undefined,
        onDelete: fk.onDelete || undefined,
      });
    }
    // Resolve indexes.
    const resolvedIdxs: CreateTableIndex[] = [];
    for (const idx of indexes) {
      const cols = parseCommaList(idx.columns);
      if (cols.length === 0 && !idx.name.trim()) continue;
      if (cols.length === 0) {
        setError(`El índice "${idx.name || "(sin nombre)"}" no tiene columnas`);
        return;
      }
      resolvedIdxs.push({
        name: idx.name.trim() || undefined,
        columns: cols,
        unique: idx.unique,
      });
    }

    setRunning(true);
    setError(null);
    try {
      await transport.createTable(connection.id, {
        schema: schemaName.trim(),
        name: tableName.trim(),
        columns: resolved,
        foreignKeys: resolvedFks.length > 0 ? resolvedFks : undefined,
        indexes: resolvedIdxs.length > 0 ? resolvedIdxs : undefined,
      });
      onCreated({ schema: schemaName.trim(), name: tableName.trim() });
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
        style={{
          width: 860,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Crear tabla</h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--dv-text-dim)",
            marginTop: -10,
            marginBottom: 16,
          }}
        >
          {connection.name} · {driver} · {connection.host}
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span>{SCHEMA_LABEL[driver]}</span>
            {userSchemas.length > 0 ? (
              <select
                className="dv-input"
                value={schemaName}
                onChange={(e) => setSchemaName(e.target.value)}
                disabled={running}
              >
                {userSchemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="dv-input"
                value={schemaName}
                onChange={(e) => setSchemaName(e.target.value)}
                placeholder={SCHEMA_LABEL[driver].toLowerCase()}
                disabled={running}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span>Nombre de tabla</span>
            <input
              type="text"
              className="dv-input"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="mi_tabla"
              disabled={running}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div
          style={{
            marginTop: 16,
            fontSize: 12,
            color: "var(--dv-text-dim)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Columnas</span>
          <button
            type="button"
            className="dv-button is-sm"
            onClick={add}
            disabled={running}
          >
            + Columna
          </button>
        </div>

        <div
          style={{
            marginTop: 8,
            overflowY: "auto",
            border: "1px solid var(--dv-border)",
            borderRadius: 6,
          }}
        >
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ background: "var(--dv-surface-2)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px", width: "22%" }}>Nombre</th>
                <th style={{ padding: "6px 8px", width: "32%" }}>Tipo</th>
                <th style={{ padding: "6px 8px", width: "18%" }}>Default</th>
                <th style={{ padding: "6px 8px", width: 60, textAlign: "center" }}>
                  Null
                </th>
                <th style={{ padding: "6px 8px", width: 50, textAlign: "center" }}>
                  PK
                </th>
                <th style={{ padding: "6px 8px", width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => (
                <tr key={c.uid} style={{ borderTop: "1px solid var(--dv-border)" }}>
                  <td style={{ padding: 4, verticalAlign: "top" }}>
                    <input
                      type="text"
                      className="dv-input"
                      value={c.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      placeholder="nombre"
                      disabled={running}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </td>
                  <td style={{ padding: 4, verticalAlign: "top" }}>
                    <TypeCell
                      column={c}
                      driver={driver}
                      catalog={catalog}
                      disabled={running}
                      onChangeChoice={(typeChoice) =>
                        // Reset params to the new option's defaults so the
                        // length/precision inputs aren't stuck at irrelevant
                        // values from the previous type.
                        update(i, {
                          typeChoice,
                          typeParams: defaultParamsFor(
                            findOption(driver, typeChoice),
                          ),
                        })
                      }
                      onChangeParam={(paramIdx, value) => {
                        const next = [...c.typeParams];
                        next[paramIdx] = value;
                        update(i, { typeParams: next });
                      }}
                      onChangeCustom={(customType) =>
                        update(i, { customType })
                      }
                      onChangeEnum={(enumValues) => update(i, { enumValues })}
                    />
                  </td>
                  <td style={{ padding: 4, verticalAlign: "top" }}>
                    <input
                      type="text"
                      className="dv-input"
                      value={c.default ?? ""}
                      onChange={(e) =>
                        update(i, { default: e.target.value || null })
                      }
                      placeholder="—"
                      disabled={running}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </td>
                  <td style={{ padding: 4, textAlign: "center", verticalAlign: "top" }}>
                    <input
                      type="checkbox"
                      checked={c.nullable}
                      onChange={(e) => update(i, { nullable: e.target.checked })}
                      disabled={running}
                      style={{ marginTop: 8 }}
                    />
                  </td>
                  <td style={{ padding: 4, textAlign: "center", verticalAlign: "top" }}>
                    <input
                      type="checkbox"
                      checked={c.primaryKey}
                      onChange={(e) =>
                        update(i, {
                          primaryKey: e.target.checked,
                          nullable: e.target.checked ? false : c.nullable,
                        })
                      }
                      disabled={running}
                      style={{ marginTop: 8 }}
                    />
                  </td>
                  <td style={{ padding: 4, whiteSpace: "nowrap", verticalAlign: "top" }}>
                    <button
                      type="button"
                      className="dv-button is-sm"
                      onClick={() => moveUp(i)}
                      disabled={running || i === 0}
                      title="Subir"
                      style={{ padding: "2px 6px" }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="dv-button is-sm"
                      onClick={() => moveDown(i)}
                      disabled={running || i === columns.length - 1}
                      title="Bajar"
                      style={{ padding: "2px 6px", marginLeft: 2 }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="dv-button is-sm"
                      onClick={() => remove(i)}
                      disabled={running || columns.length === 1}
                      title="Borrar"
                      style={{ padding: "2px 6px", marginLeft: 2 }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--dv-text-dim)",
              fontSize: 12,
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            disabled={running}
          >
            <span>{advancedOpen ? "▾" : "▸"}</span>
            <span>
              Avanzado · FKs ({foreignKeys.length}) · índices ({indexes.length})
            </span>
          </button>

          {advancedOpen && (
            <div style={{ marginTop: 8, display: "grid", gap: 16 }}>
              {/* ── Foreign keys ────────────────────────────────────────── */}
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "var(--dv-text-dim)",
                    marginBottom: 6,
                  }}
                >
                  <span>Foreign keys</span>
                  <button
                    type="button"
                    className="dv-button is-sm"
                    disabled={running}
                    onClick={() =>
                      setForeignKeys((prev) => [
                        ...prev,
                        blankFk(schemaName),
                      ])
                    }
                  >
                    + FK
                  </button>
                </div>
                {foreignKeys.length === 0 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--dv-text-mute)",
                      fontStyle: "italic",
                      padding: "8px 4px",
                    }}
                  >
                    Sin foreign keys.
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px solid var(--dv-border)",
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        fontSize: 12,
                        borderCollapse: "collapse",
                      }}
                    >
                      <thead>
                        <tr
                          style={{
                            background: "var(--dv-surface-2)",
                            textAlign: "left",
                          }}
                        >
                          <th style={{ padding: "6px 8px", width: "18%" }}>
                            Local cols
                          </th>
                          <th style={{ padding: "6px 8px", width: "14%" }}>
                            Ref. schema
                          </th>
                          <th style={{ padding: "6px 8px", width: "18%" }}>
                            Ref. tabla
                          </th>
                          <th style={{ padding: "6px 8px", width: "18%" }}>
                            Ref. cols
                          </th>
                          <th style={{ padding: "6px 8px", width: "12%" }}>
                            ON UPDATE
                          </th>
                          <th style={{ padding: "6px 8px", width: "12%" }}>
                            ON DELETE
                          </th>
                          <th style={{ padding: "6px 8px", width: 40 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {foreignKeys.map((fk, i) => (
                          <tr
                            key={fk.uid}
                            style={{ borderTop: "1px solid var(--dv-border)" }}
                          >
                            <td style={{ padding: 4 }}>
                              <input
                                type="text"
                                className="dv-input"
                                value={fk.columns}
                                onChange={(e) =>
                                  setForeignKeys((prev) =>
                                    prev.map((f, idx) =>
                                      idx === i
                                        ? { ...f, columns: e.target.value }
                                        : f,
                                    ),
                                  )
                                }
                                placeholder="col1, col2"
                                disabled={running}
                                spellCheck={false}
                              />
                            </td>
                            <td style={{ padding: 4 }}>
                              <select
                                className="dv-input"
                                value={fk.referencedSchema}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setForeignKeys((prev) =>
                                    prev.map((f, idx) =>
                                      idx === i
                                        ? { ...f, referencedSchema: v }
                                        : f,
                                    ),
                                  );
                                  void ensureTablesFor(v);
                                }}
                                disabled={running}
                              >
                                {userSchemas.map((s) => (
                                  <option key={s.name} value={s.name}>
                                    {s.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: 4 }}>
                              {(tablesByRefSchema[fk.referencedSchema] ?? [])
                                .length > 0 ? (
                                <select
                                  className="dv-input"
                                  value={fk.referencedTable}
                                  onChange={(e) =>
                                    setForeignKeys((prev) =>
                                      prev.map((f, idx) =>
                                        idx === i
                                          ? { ...f, referencedTable: e.target.value }
                                          : f,
                                      ),
                                    )
                                  }
                                  disabled={running}
                                >
                                  <option value="">—</option>
                                  {tablesByRefSchema[fk.referencedSchema]!.map(
                                    (t) => (
                                      <option key={t} value={t}>
                                        {t}
                                      </option>
                                    ),
                                  )}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  className="dv-input"
                                  value={fk.referencedTable}
                                  onChange={(e) =>
                                    setForeignKeys((prev) =>
                                      prev.map((f, idx) =>
                                        idx === i
                                          ? { ...f, referencedTable: e.target.value }
                                          : f,
                                      ),
                                    )
                                  }
                                  onFocus={() =>
                                    ensureTablesFor(fk.referencedSchema)
                                  }
                                  placeholder="tabla"
                                  disabled={running}
                                  spellCheck={false}
                                />
                              )}
                            </td>
                            <td style={{ padding: 4 }}>
                              <input
                                type="text"
                                className="dv-input"
                                value={fk.referencedColumns}
                                onChange={(e) =>
                                  setForeignKeys((prev) =>
                                    prev.map((f, idx) =>
                                      idx === i
                                        ? {
                                            ...f,
                                            referencedColumns: e.target.value,
                                          }
                                        : f,
                                    ),
                                  )
                                }
                                placeholder="id"
                                disabled={running}
                                spellCheck={false}
                              />
                            </td>
                            <td style={{ padding: 4 }}>
                              <select
                                className="dv-input"
                                value={fk.onUpdate}
                                onChange={(e) =>
                                  setForeignKeys((prev) =>
                                    prev.map((f, idx) =>
                                      idx === i
                                        ? { ...f, onUpdate: e.target.value }
                                        : f,
                                    ),
                                  )
                                }
                                disabled={running}
                              >
                                {FK_ACTIONS.map((a) => (
                                  <option key={a || "_none"} value={a}>
                                    {a || "—"}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: 4 }}>
                              <select
                                className="dv-input"
                                value={fk.onDelete}
                                onChange={(e) =>
                                  setForeignKeys((prev) =>
                                    prev.map((f, idx) =>
                                      idx === i
                                        ? { ...f, onDelete: e.target.value }
                                        : f,
                                    ),
                                  )
                                }
                                disabled={running}
                              >
                                {FK_ACTIONS.map((a) => (
                                  <option key={a || "_none"} value={a}>
                                    {a || "—"}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: 4, textAlign: "center" }}>
                              <button
                                type="button"
                                className="dv-button is-sm"
                                onClick={() =>
                                  setForeignKeys((prev) =>
                                    prev.filter((_, idx) => idx !== i),
                                  )
                                }
                                disabled={running}
                                title="Borrar FK"
                                style={{ padding: "2px 6px" }}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Indexes ─────────────────────────────────────────────── */}
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "var(--dv-text-dim)",
                    marginBottom: 6,
                  }}
                >
                  <span>Índices</span>
                  <button
                    type="button"
                    className="dv-button is-sm"
                    disabled={running}
                    onClick={() =>
                      setIndexes((prev) => [...prev, blankIndex()])
                    }
                  >
                    + Índice
                  </button>
                </div>
                {indexes.length === 0 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--dv-text-mute)",
                      fontStyle: "italic",
                      padding: "8px 4px",
                    }}
                  >
                    Sin índices secundarios.
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px solid var(--dv-border)",
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        fontSize: 12,
                        borderCollapse: "collapse",
                      }}
                    >
                      <thead>
                        <tr
                          style={{
                            background: "var(--dv-surface-2)",
                            textAlign: "left",
                          }}
                        >
                          <th style={{ padding: "6px 8px", width: "28%" }}>
                            Nombre
                          </th>
                          <th style={{ padding: "6px 8px", width: "52%" }}>
                            Columnas
                          </th>
                          <th
                            style={{
                              padding: "6px 8px",
                              width: 70,
                              textAlign: "center",
                            }}
                          >
                            UNIQUE
                          </th>
                          <th style={{ padding: "6px 8px", width: 40 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {indexes.map((idx, i) => (
                          <tr
                            key={idx.uid}
                            style={{ borderTop: "1px solid var(--dv-border)" }}
                          >
                            <td style={{ padding: 4 }}>
                              <input
                                type="text"
                                className="dv-input"
                                value={idx.name}
                                onChange={(e) =>
                                  setIndexes((prev) =>
                                    prev.map((it, j) =>
                                      j === i
                                        ? { ...it, name: e.target.value }
                                        : it,
                                    ),
                                  )
                                }
                                placeholder="(auto)"
                                disabled={running}
                                spellCheck={false}
                              />
                            </td>
                            <td style={{ padding: 4 }}>
                              <input
                                type="text"
                                className="dv-input"
                                value={idx.columns}
                                onChange={(e) =>
                                  setIndexes((prev) =>
                                    prev.map((it, j) =>
                                      j === i
                                        ? { ...it, columns: e.target.value }
                                        : it,
                                    ),
                                  )
                                }
                                placeholder="col1, col2"
                                disabled={running}
                                spellCheck={false}
                              />
                            </td>
                            <td
                              style={{
                                padding: 4,
                                textAlign: "center",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={idx.unique}
                                onChange={(e) =>
                                  setIndexes((prev) =>
                                    prev.map((it, j) =>
                                      j === i
                                        ? { ...it, unique: e.target.checked }
                                        : it,
                                    ),
                                  )
                                }
                                disabled={running}
                              />
                            </td>
                            <td style={{ padding: 4, textAlign: "center" }}>
                              <button
                                type="button"
                                className="dv-button is-sm"
                                onClick={() =>
                                  setIndexes((prev) =>
                                    prev.filter((_, j) => j !== i),
                                  )
                                }
                                disabled={running}
                                title="Borrar índice"
                                style={{ padding: "2px 6px" }}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
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
            disabled={running || !tableName.trim() || !schemaName.trim()}
          >
            {running ? "Creando…" : "Crear tabla"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TypeCellProps {
  column: DraftColumn;
  driver: DatabaseDriver;
  catalog: TypeOption[];
  disabled: boolean;
  onChangeChoice: (key: string) => void;
  onChangeParam: (paramIdx: number, value: string) => void;
  onChangeCustom: (sql: string) => void;
  onChangeEnum: (values: string[]) => void;
}

function TypeCell({
  column,
  driver,
  catalog,
  disabled,
  onChangeChoice,
  onChangeParam,
  onChangeCustom,
  onChangeEnum,
}: TypeCellProps) {
  const activeOption = findOption(driver, column.typeChoice);
  const params = activeOption?.params ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <select
        className="dv-input"
        value={column.typeChoice}
        onChange={(e) => onChangeChoice(e.target.value)}
        disabled={disabled}
      >
        {catalog.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
        <option value={ENUM}>Enum (lista de valores)…</option>
        <option value={CUSTOM}>Personalizado…</option>
      </select>
      {params.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${params.length}, minmax(0, 1fr))`,
            gap: 4,
          }}
        >
          {params.map((p, idx) => (
            <label
              key={p.label}
              style={{
                display: "grid",
                gap: 2,
                fontSize: 10,
                color: "var(--dv-text-dim)",
              }}
            >
              <span>{p.label}</span>
              <input
                type="text"
                className="dv-input"
                value={column.typeParams[idx] ?? ""}
                onChange={(e) => onChangeParam(idx, e.target.value)}
                placeholder={p.placeholder ?? p.default}
                disabled={disabled}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                style={{ padding: "4px 6px", fontFamily: "var(--dv-mono)" }}
              />
            </label>
          ))}
        </div>
      )}
      {column.typeChoice === CUSTOM && (
        <input
          type="text"
          className="dv-input"
          value={column.customType}
          onChange={(e) => onChangeCustom(e.target.value)}
          placeholder="ej: varchar(64), numeric(12,4)…"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {column.typeChoice === ENUM && (
        <EnumEditor
          values={column.enumValues}
          onChange={onChangeEnum}
          disabled={disabled}
        />
      )}
    </div>
  );
}

interface EnumEditorProps {
  values: string[];
  onChange: (values: string[]) => void;
  disabled: boolean;
}

function EnumEditor({ values, onChange, disabled }: EnumEditorProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      // Tab still moves focus; comma + Enter both submit a value.
      if (e.key !== "Tab" || draft.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (
      e.key === "Backspace" &&
      draft === "" &&
      values.length > 0
    ) {
      // Backspace on an empty input pops the last chip — same UX as native
      // chip inputs (Gmail, etc.).
      onChange(values.slice(0, -1));
    }
  }

  function remove(value: string) {
    onChange(values.filter((v) => v !== value));
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: "4px 6px",
        border: "1px solid var(--dv-border)",
        borderRadius: 4,
        background: "var(--dv-surface)",
        minHeight: 30,
      }}
    >
      {values.map((v) => (
        <span
          key={v}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 4px 2px 8px",
            background: "var(--dv-panel-2)",
            border: "1px solid var(--dv-border)",
            borderRadius: 4,
            fontSize: 12,
            fontFamily: "var(--dv-mono)",
          }}
        >
          {v}
          <button
            type="button"
            onClick={() => remove(v)}
            disabled={disabled}
            aria-label={`Quitar ${v}`}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--dv-text-dim)",
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        onBlur={commit}
        disabled={disabled}
        placeholder={values.length === 0 ? "valor + Enter" : ""}
        autoComplete="off"
        spellCheck={false}
        style={{
          flex: "1 0 80px",
          minWidth: 60,
          border: "none",
          outline: "none",
          background: "transparent",
          color: "var(--dv-text)",
          fontFamily: "var(--dv-mono)",
          fontSize: 12,
          padding: "2px 0",
        }}
      />
    </div>
  );
}
