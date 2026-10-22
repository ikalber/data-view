import type { DatabaseDriver, TableDetails } from "./types";

/**
 * Postgres keywords that can't be used as bare identifiers (reserved, plus the
 * "non-reserved (cannot be function or type)" ones that break in column
 * position). Over-quoting is harmless, so the list errs on the inclusive side.
 */
const PG_RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization between bigint binary bit " +
    "boolean both case cast char character check coalesce collate collation column concurrently " +
    "constraint create cross current_catalog current_date current_role current_schema current_time " +
    "current_timestamp current_user dec decimal default deferrable desc distinct do else end except " +
    "exists extract false fetch float for foreign freeze from full grant greatest group grouping having " +
    "ilike in initially inner inout int integer intersect interval into is isnull join lateral leading " +
    "least left like limit localtime localtimestamp national natural nchar none normalize not notnull " +
    "null nullif numeric offset on only or order out outer overlaps overlay placing position precision " +
    "primary real references returning right row select session_user setof similar smallint some " +
    "substring symmetric system_user table tablesample then time timestamp to trailing treat trim true " +
    "union unique user using values varchar variadic verbose when where window with"
  ).split(" "),
);

/** Quote an identifier per the active driver's rules. */
export function quoteIdent(
  driver: DatabaseDriver | null | undefined,
  s: string,
): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      // Unquoted identifiers fold to lowercase in Postgres, so only plain
      // lowercase non-keywords can be left bare.
      return /^[a-z_][a-z0-9_$]*$/.test(s) && !PG_RESERVED.has(s)
        ? s
        : `"${s.replace(/"/g, '""')}"`;
  }
}

/** Always-quoted variant — used when ambiguity matters (e.g. in dumps). */
export function quoteIdentStrict(
  driver: DatabaseDriver | null | undefined,
  s: string,
): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      return `"${s.replace(/"/g, '""')}"`;
  }
}

/**
 * Single-quote a string literal with proper escaping for the driver:
 *  - MySQL treats backslash as an escape char (default sql_mode), so it gets
 *    doubled too — otherwise `C:\temp` turns into a TAB and `abc\` breaks.
 *  - SQL Server gets an `N'…'` literal so non-Latin text isn't mangled by the
 *    database code page.
 */
export function quoteString(
  text: string,
  driver?: DatabaseDriver | null,
): string {
  if (driver === "mysql") {
    return "'" + text.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  }
  const lit = "'" + text.replace(/'/g, "''") + "'";
  return driver === "mssql" ? "N" + lit : lit;
}

/** Build the column-level CONSTRAINT clause for a CREATE TABLE foreign key.
 * Driver-portable — only the identifier quoting style differs. */
export function renderForeignKeyClause(
  driver: DatabaseDriver,
  fk: {
    name?: string;
    columns: string[];
    referencedSchema: string;
    referencedTable: string;
    referencedColumns: string[];
    onUpdate?: string;
    onDelete?: string;
  },
): string {
  if (fk.columns.length === 0) throw new Error("FK sin columnas locales");
  if (fk.referencedColumns.length !== fk.columns.length) {
    throw new Error(
      `FK: cantidad de columnas (${fk.columns.length}) ≠ referencedColumns (${fk.referencedColumns.length})`,
    );
  }
  const cols = fk.columns.map((c) => quoteIdent(driver, c)).join(", ");
  const refCols = fk.referencedColumns
    .map((c) => quoteIdent(driver, c))
    .join(", ");
  const refTable = `${quoteIdent(driver, fk.referencedSchema)}.${quoteIdent(
    driver,
    fk.referencedTable,
  )}`;
  const prefix = fk.name ? `CONSTRAINT ${quoteIdent(driver, fk.name)} ` : "";
  const tail: string[] = [];
  if (fk.onUpdate) tail.push(`ON UPDATE ${fk.onUpdate}`);
  if (fk.onDelete) tail.push(`ON DELETE ${fk.onDelete}`);
  const tailStr = tail.length ? " " + tail.join(" ") : "";
  return `${prefix}FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})${tailStr}`;
}

/** Suggest an auto index name from table + columns, capped at 60 chars
 * (Postgres' default identifier limit is 63). */
export function autoIndexName(table: string, columns: string[]): string {
  return `idx_${table}_${columns.join("_")}`.slice(0, 60);
}

/** Render the column-level part of a CREATE TABLE clause for one column.
 * The MSSQL dialect is explicit about NULL/NOT NULL on every column; PG and
 * MySQL only emit NOT NULL (NULL is the default). */
function renderColumnDef(
  driver: DatabaseDriver,
  col: {
    name: string;
    dataType: string;
    nullable: boolean;
    default?: string | null;
  },
): string {
  const parts = [quoteIdent(driver, col.name), col.dataType];
  if (driver === "mssql") {
    parts.push(col.nullable ? "NULL" : "NOT NULL");
  } else if (!col.nullable) {
    parts.push("NOT NULL");
  }
  if (col.default != null && col.default !== "") {
    parts.push(`DEFAULT ${col.default}`);
  }
  return "  " + parts.join(" ");
}

/**
 * Build a complete DDL script for an existing table — CREATE TABLE with
 * columns + PRIMARY KEY, then CREATE INDEX for each non-primary index, then
 * ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY for each FK. Sections are
 * omitted gracefully when the corresponding arrays are empty.
 *
 * This is the same shape pg_dump / mysqldump / SQL Server's "Script as
 * CREATE" produce, but condensed into a single script the user can paste
 * elsewhere as-is.
 */
export function generateFullTableDDL(
  driver: DatabaseDriver,
  details: TableDetails,
): string {
  const { schema, name, columns, indexes, foreignKeys } = details;
  const fqn = `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`;

  // ── CREATE TABLE ──────────────────────────────────────────────────────
  const colLines = columns.map((c) =>
    renderColumnDef(driver, {
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      default: c.default,
    }),
  );
  const pkCols = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pkCols.length > 0) {
    colLines.push(
      `  PRIMARY KEY (${pkCols.map((c) => quoteIdent(driver, c)).join(", ")})`,
    );
  }
  const sections: string[] = [];
  sections.push(`CREATE TABLE ${fqn} (\n${colLines.join(",\n")}\n);`);

  // ── INDEXES (skip the implicit one backing the PK) ────────────────────
  const secondaryIndexes = indexes.filter((idx) => !idx.primary);
  if (secondaryIndexes.length > 0) {
    const block: string[] = ["-- Indexes"];
    for (const idx of secondaryIndexes) {
      const unique = idx.unique ? "UNIQUE " : "";
      const idxName = quoteIdent(driver, idx.name);
      const cols = idx.columns.map((c) => quoteIdent(driver, c)).join(", ");
      block.push(`CREATE ${unique}INDEX ${idxName} ON ${fqn} (${cols});`);
    }
    sections.push(block.join("\n"));
  }

  // ── FOREIGN KEYS ──────────────────────────────────────────────────────
  if (foreignKeys.length > 0) {
    const block: string[] = ["-- Foreign keys"];
    for (const fk of foreignKeys) {
      // We emit FKs as ALTER TABLE statements (rather than inline in CREATE
      // TABLE) so the script also works when the referenced tables haven't
      // been created yet — the user can reorder if needed.
      const refTable = `${quoteIdent(driver, fk.referencedSchema)}.${quoteIdent(
        driver,
        fk.referencedTable,
      )}`;
      const localCols = fk.columns.map((c) => quoteIdent(driver, c)).join(", ");
      const refCols = fk.referencedColumns
        .map((c) => quoteIdent(driver, c))
        .join(", ");
      const tail: string[] = [];
      if (fk.onUpdate) tail.push(`ON UPDATE ${fk.onUpdate}`);
      if (fk.onDelete) tail.push(`ON DELETE ${fk.onDelete}`);
      const tailStr = tail.length ? " " + tail.join(" ") : "";
      const constraintName = fk.name
        ? `CONSTRAINT ${quoteIdent(driver, fk.name)} `
        : "";
      block.push(
        `ALTER TABLE ${fqn}\n  ADD ${constraintName}FOREIGN KEY (${localCols}) REFERENCES ${refTable} (${refCols})${tailStr};`,
      );
    }
    sections.push(block.join("\n"));
  }

  return sections.join("\n\n") + "\n";
}

/** Minimal column descriptor used by the generate-SQL helpers below. We don't
 * take the full `ColumnInfo` since callers (UI dropdown, tests) typically
 * only have name + nullability handy. */
export interface GenColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
}

function quoteFQN(
  driver: DatabaseDriver | null | undefined,
  schema: string,
  name: string,
): string {
  return `${quoteIdentStrict(driver, schema)}.${quoteIdentStrict(driver, name)}`;
}

/** `SELECT col1, col2, … FROM "schema"."name" LIMIT 100`. */
export function generateSelectSql(
  driver: DatabaseDriver | null | undefined,
  schema: string,
  name: string,
  columns: GenColumn[],
): string {
  const cols = columns.length
    ? columns.map((c) => quoteIdentStrict(driver, c.name)).join(", ")
    : "*";
  // SQL Server uses TOP instead of LIMIT.
  if (driver === "mssql") {
    return `SELECT TOP 100 ${cols}\nFROM ${quoteFQN(driver, schema, name)};`;
  }
  return `SELECT ${cols}\nFROM ${quoteFQN(driver, schema, name)}\nLIMIT 100;`;
}

/** `INSERT INTO "schema"."name" (cols…) VALUES (…);` skeleton. NULL goes
 * where the column accepts it; otherwise we emit a typed placeholder
 * (`''` for text-like, `0` for numeric-like, `NULL` everywhere else) so the
 * user can fill in without thinking about types. PK columns are skipped
 * when the data type looks auto-incremental (serial/identity/auto_increment). */
export function generateInsertSql(
  driver: DatabaseDriver | null | undefined,
  schema: string,
  name: string,
  columns: GenColumn[],
): string {
  const writable = columns.filter((c) => !looksAutoIncrement(c));
  if (writable.length === 0) {
    // MySQL has no `DEFAULT VALUES` form.
    return driver === "mysql"
      ? `INSERT INTO ${quoteFQN(driver, schema, name)} () VALUES ();`
      : `INSERT INTO ${quoteFQN(driver, schema, name)} DEFAULT VALUES;`;
  }
  const colList = writable.map((c) => quoteIdentStrict(driver, c.name)).join(", ");
  const valueList = writable.map((c) => placeholderFor(driver, c)).join(", ");
  return `INSERT INTO ${quoteFQN(driver, schema, name)}\n  (${colList})\nVALUES\n  (${valueList});`;
}

/** `UPDATE "schema"."name" SET col = …, col = … WHERE <pk>;` */
export function generateUpdateSql(
  driver: DatabaseDriver | null | undefined,
  schema: string,
  name: string,
  columns: GenColumn[],
): string {
  const nonPk = columns.filter((c) => !c.isPrimaryKey);
  if (nonPk.length === 0) {
    return `UPDATE ${quoteFQN(driver, schema, name)}\nSET <columna> = ${placeholderFor(driver)}\nWHERE 1 = 1;`;
  }
  const sets = nonPk
    .map((c) => `  ${quoteIdentStrict(driver, c.name)} = ${placeholderFor(driver, c)}`)
    .join(",\n");
  const where = buildWhereClause(driver, columns);
  return `UPDATE ${quoteFQN(driver, schema, name)}\nSET\n${sets}\n${where};`;
}

/** `DELETE FROM "schema"."name" WHERE <pk>;` */
export function generateDeleteSql(
  driver: DatabaseDriver | null | undefined,
  schema: string,
  name: string,
  columns: GenColumn[],
): string {
  const where = buildWhereClause(driver, columns);
  return `DELETE FROM ${quoteFQN(driver, schema, name)}\n${where};`;
}

function buildWhereClause(
  driver: DatabaseDriver | null | undefined,
  columns: GenColumn[],
): string {
  const pks = columns.filter((c) => c.isPrimaryKey);
  if (pks.length > 0) {
    const parts = pks
      .map((c) => `${quoteIdentStrict(driver, c.name)} = ${placeholderFor(driver, c)}`)
      .join("\n  AND ");
    return `WHERE ${parts}`;
  }
  return "WHERE 1 = 1 /* TODO: filtrar — la tabla no tiene primary key */";
}

function placeholderFor(
  driver: DatabaseDriver | null | undefined,
  col?: GenColumn,
): string {
  if (!col) return "''";
  if (looksTextual(col.dataType)) return "''";
  if (looksNumeric(col.dataType)) return "0";
  // SQL Server has no boolean literals; bit columns take 0/1.
  if (looksBoolean(col.dataType)) return driver === "mssql" ? "0" : "false";
  if (col.nullable) return "NULL";
  return "''";
}

function looksAutoIncrement(col: GenColumn): boolean {
  if (!col.isPrimaryKey) return false;
  const dt = (col.dataType ?? "").toLowerCase();
  return (
    dt.includes("serial") ||
    dt.includes("identity") ||
    dt.includes("auto_increment")
  );
}

function looksTextual(dt: string | undefined): boolean {
  if (!dt) return false;
  return /char|text|clob|uuid|json|enum/i.test(dt);
}

function looksNumeric(dt: string | undefined): boolean {
  if (!dt) return false;
  return /int|numeric|decimal|float|double|real|number|money|serial/i.test(dt);
}

function looksBoolean(dt: string | undefined): boolean {
  if (!dt) return false;
  return /^bool|^bit\b/i.test(dt);
}
