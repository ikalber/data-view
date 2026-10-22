/**
 * Pure helpers behind the editable data grid (TablePane / EditableDataGrid):
 * value ↔ SQL literal conversion per dialect and the UPDATE / INSERT /
 * preview-SELECT builders. Kept free of React so they can be unit-tested.
 */
import type {
  CellValue,
  ColumnInfo,
  DatabaseDriver,
} from "@data-view/core";
import { quoteIdent, quoteString } from "@data-view/core";

type Driver = DatabaseDriver | null | undefined;

/** Render a CellValue as a plain string for display / editing. */
export function cellToString(v: CellValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object" && "__binary" in v) return `<binary ${v.bytes}B>`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Computes a stable key for a row from its PK columns' values. */
export function rowPkKey(
  row: CellValue[],
  colNameToIdx: Map<string, number>,
  pkColumns: string[],
): string | null {
  if (pkColumns.length === 0) return null;
  return pkColumns
    .map((c) => {
      const idx = colNameToIdx.get(c);
      if (idx == null) return "";
      return cellToString(row[idx]);
    })
    .join("\u0001");
}

/** Detect MySQL-style enum types from the dataType string. */
export function parseEnumValues(dataType: string | undefined): string[] | null {
  if (!dataType) return null;
  const m = /^enum\((.+)\)$/i.exec(dataType.trim());
  if (!m || !m[1]) return null;
  const matches = m[1].match(/'((?:[^']|'')*)'/g);
  if (!matches) return null;
  return matches.map((s) => s.slice(1, -1).replace(/''/g, "'"));
}

/**
 * Whether a column holds booleans, per dialect. Postgres `bit(1)` is a bit
 * string (literal `'1'`), not a boolean, so it's deliberately excluded there;
 * SQL Server's `bit` and MySQL's `tinyint(1)` / `bit(1)` take 1/0.
 */
export function isBooleanType(driver: Driver, dataType: string | undefined): boolean {
  if (!dataType) return false;
  const dt = dataType.trim().toLowerCase();
  switch (driver) {
    case "postgres":
      return dt === "boolean" || dt === "bool";
    case "mssql":
      return dt === "bit";
    case "mysql":
      return /^(bool|boolean|tinyint\(1\)|bit\(1\))/.test(dt);
    default:
      return /^(bool|boolean|tinyint\(1\)|bit\(1\))/.test(dt);
  }
}

// The trailing \b keeps `interval` (Postgres) from matching `int`.
const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|mediumint|bigint|int|integer|int2|int4|int8|number|numeric|decimal|dec|float|float4|float8|double|real|money|smallmoney|serial|bigserial|smallserial)\b/i;

export function isNumericType(dataType: string | undefined): boolean {
  return !!dataType && NUMERIC_TYPE_RE.test(dataType.trim());
}

/** char/varchar/nvarchar/text/… — the types where '' is a legit value. */
export function isTextualType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  if (parseEnumValues(dataType)) return false;
  return /char|text|clob/i.test(dataType);
}

/**
 * The grid edits values as plain strings, so an empty cell is ambiguous.
 * It means SQL NULL unless the column is a NOT NULL text column, where NULL
 * can't be stored and the user clearly wants an empty string.
 */
export function emptyMeansNull(col: ColumnInfo | undefined): boolean {
  if (!col) return true;
  return col.nullable || !isTextualType(col.dataType);
}

const NUMBER_LITERAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const TRUTHY = new Set(["true", "t", "1", "yes", "y", "on"]);
const FALSY = new Set(["false", "f", "0", "no", "n", "off"]);

function boolLiteral(driver: Driver, value: boolean): string {
  // MySQL stores booleans as tinyint and SQL Server has no TRUE/FALSE.
  if (driver === "mysql" || driver === "mssql") return value ? "1" : "0";
  return value ? "TRUE" : "FALSE";
}

/**
 * Turn the string the user typed into a SQL literal for `col`.
 *  - `context: "insert"` lets an empty NOT NULL column with a default fall
 *    back to `DEFAULT` instead of a NULL the server would reject.
 *  - Numbers are emitted bare only when they look like numbers; anything
 *    else is quoted so the server reports a proper conversion error instead
 *    of executing arbitrary text.
 */
export function editValueToSql(
  driver: Driver,
  col: ColumnInfo | undefined,
  raw: string,
  context: "update" | "insert" = "update",
): string {
  if (raw === "") {
    if (!emptyMeansNull(col)) return quoteString("", driver);
    if (
      context === "insert" &&
      col &&
      !col.nullable &&
      col.default != null &&
      col.default !== ""
    ) {
      return "DEFAULT";
    }
    return "NULL";
  }

  if (isBooleanType(driver, col?.dataType)) {
    const norm = raw.trim().toLowerCase();
    if (TRUTHY.has(norm)) return boolLiteral(driver, true);
    if (FALSY.has(norm)) return boolLiteral(driver, false);
    // Unknown token: let the server validate it rather than guessing.
    return quoteString(raw, driver);
  }

  // ENUMs are quoted strings even though the dataType starts with "enum(".
  if (parseEnumValues(col?.dataType)) return quoteString(raw, driver);

  if (isNumericType(col?.dataType) && NUMBER_LITERAL_RE.test(raw.trim())) {
    return raw.trim();
  }

  return quoteString(raw, driver);
}

/** Literal for an original (as fetched) cell value — used in WHERE by PK. */
export function cellValueToSql(
  driver: Driver,
  col: ColumnInfo | undefined,
  value: CellValue,
): string {
  if (value === null) return "NULL";
  if (typeof value === "object" && "__binary" in value) {
    throw new Error(
      `No se puede identificar la fila: la columna "${col?.name ?? "?"}" es binaria`,
    );
  }
  if (typeof value === "boolean") return boolLiteral(driver, value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return quoteString(String(value), driver);
    return String(value);
  }
  if (isNumericType(col?.dataType) && NUMBER_LITERAL_RE.test(value.trim())) {
    return value.trim();
  }
  return quoteString(value, driver);
}

function tableRef(driver: Driver, schema: string, name: string): string {
  return `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`;
}

/** `pk1 = 1 AND pk2 = 'x'` — NULL-safe (`IS NULL`) for completeness. */
export function buildPkWhere(
  driver: Driver,
  pkColumns: string[],
  pkValues: Record<string, CellValue>,
  columnsInfo: Map<string, ColumnInfo>,
): string {
  if (pkColumns.length === 0) {
    throw new Error("La tabla no tiene primary key");
  }
  return pkColumns
    .map((pk) => {
      if (!(pk in pkValues)) {
        throw new Error(`Falta el valor de la PK "${pk}"`);
      }
      const v = pkValues[pk] ?? null;
      const ident = quoteIdent(driver, pk);
      if (v === null) return `${ident} IS NULL`;
      return `${ident} = ${cellValueToSql(driver, columnsInfo.get(pk), v)}`;
    })
    .join(" AND ");
}

export function buildUpdateSql(
  driver: Driver,
  schema: string,
  name: string,
  pkColumns: string[],
  pkValues: Record<string, CellValue>,
  changes: Record<string, string>,
  columnsInfo: Map<string, ColumnInfo>,
): string {
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new Error("No hay cambios para guardar");
  const setClauses = entries
    .map(
      ([col, val]) =>
        `${quoteIdent(driver, col)} = ${editValueToSql(driver, columnsInfo.get(col), val, "update")}`,
    )
    .join(", ");
  const where = buildPkWhere(driver, pkColumns, pkValues, columnsInfo);
  return `UPDATE ${tableRef(driver, schema, name)} SET ${setClauses} WHERE ${where}`;
}

export function buildInsertSql(
  driver: Driver,
  schema: string,
  name: string,
  values: Record<string, string>,
  columnsInfo: Map<string, ColumnInfo>,
): string {
  const cols = Object.keys(values);
  const target = tableRef(driver, schema, name);
  if (cols.length === 0) {
    // MySQL has no `DEFAULT VALUES` form.
    return driver === "mysql"
      ? `INSERT INTO ${target} () VALUES ()`
      : `INSERT INTO ${target} DEFAULT VALUES`;
  }
  const colList = cols.map((c) => quoteIdent(driver, c)).join(", ");
  const valList = cols
    .map((c) =>
      editValueToSql(driver, columnsInfo.get(c), values[c] ?? "", "insert"),
    )
    .join(", ");
  return `INSERT INTO ${target} (${colList}) VALUES (${valList})`;
}

/** The SELECT shown by "Abrir en SQL editor" — mirrors the grid's filter
 * and sort. SQL Server has no LIMIT, so it gets `TOP n` instead. */
export function buildTablePreviewSql(
  driver: Driver,
  schema: string,
  name: string,
  where: string,
  sort: { column: string; direction: "asc" | "desc" } | null,
  limit = 100,
): string {
  const w = where.trim();
  const top = driver === "mssql" ? `TOP ${limit} ` : "";
  const lines = [`SELECT ${top}* FROM ${tableRef(driver, schema, name)}`];
  if (w) lines.push(`WHERE ${w}`);
  if (sort) {
    lines.push(
      `ORDER BY ${quoteIdent(driver, sort.column)} ${sort.direction.toUpperCase()}`,
    );
  }
  if (driver !== "mssql") lines.push(`LIMIT ${limit}`);
  return lines.join("\n") + ";";
}
