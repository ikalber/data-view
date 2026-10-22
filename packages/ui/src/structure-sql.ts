/**
 * Pure logic behind the Structure tab (StructureEditor): the per-driver type
 * catalog, column drafts and the ALTER TABLE builder. No React here so the
 * generated SQL can be unit-tested (and run against real servers).
 */
import type {
  CellValue,
  ColumnInfo,
  DatabaseDriver,
  QueryResult,
} from "@data-view/core";
import { quoteIdentStrict, quoteString } from "@data-view/core";

type Driver = DatabaseDriver | null;

export interface ColumnDraft {
  /** Stable id: original name for existing rows, "new:n" for added rows. */
  id: string;
  isNew: boolean;
  isDropped: boolean;
  original?: ColumnInfo;
  /** The original default as an SQL expression (see `draftFromColumn`) —
   *  what `defaultExpr` is compared against to detect a change. */
  originalDefault: string;
  /** MySQL only: information_schema `extra` (auto_increment, on update …),
   *  re-emitted by CHANGE COLUMN so a redefinition doesn't drop it. */
  extra?: string;
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

/** Per-driver catalog of base data types. The base goes in the <select>; if
 *  the type accepts parameters (length / precision / enum values), an adjacent
 *  input collects them. The combined `base(params)` becomes the dataType. */
export type ParamSpec = "none" | "length" | "precision-scale" | "enum";

export interface TypeOption {
  base: string;
  params: ParamSpec;
}

export const TYPE_CATALOG: Record<DatabaseDriver, TypeOption[]> = {
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
export function splitDataType(dt: string): { base: string; params: string } {
  const trimmed = dt.trim();
  if (!trimmed) return { base: "", params: "" };
  const open = trimmed.indexOf("(");
  if (open < 0) return { base: trimmed, params: "" };
  return {
    base: trimmed.slice(0, open).trim(),
    params: trimmed.slice(open).trim(),
  };
}

export function findTypeSpec(
  driver: Driver,
  base: string,
): TypeOption | undefined {
  const list = TYPE_CATALOG[driver ?? "postgres"] ?? [];
  const lower = base.toLowerCase();
  return list.find((t) => t.base.toLowerCase() === lower);
}

export function joinDataType(base: string, params: string): string {
  const b = base.trim();
  const p = params.trim();
  if (!b) return p;
  if (!p) return b;
  return `${b}${p.startsWith("(") ? p : `(${p})`}`;
}

export function paramsPlaceholder(spec: ParamSpec): string {
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
export function normalizeDataType(driver: Driver, dt: string): string {
  const { base, params } = splitDataType(dt);
  const spec = findTypeSpec(driver, base);
  return joinDataType(spec ? spec.base : base, params.replace(/\s*,\s*/g, ","));
}

// ── Column metadata describeTable doesn't carry ──────────────────────────

/** Extra per-column metadata fetched with `columnExtrasQuery`. */
export interface ColumnExtras {
  comment?: string | null;
  /** SQL Server: full type with length/precision (`nvarchar(50)`), which
   *  information_schema's `data_type` drops. */
  fullType?: string;
  /** MySQL: information_schema.columns.extra. */
  extra?: string;
}

/**
 * Query for the metadata the Structure editor needs beyond describeTable:
 * comments everywhere, MySQL's `extra` (AUTO_INCREMENT / ON UPDATE, which a
 * CHANGE COLUMN would otherwise silently drop) and SQL Server's full types
 * (ALTER COLUMN with a bare `nvarchar` means nvarchar(1)). Literals are
 * inlined because the desktop transport ignores query params.
 */
export function columnExtrasQuery(
  driver: Driver,
  schema: string,
  table: string,
): string | null {
  switch (driver) {
    case "postgres":
      return `SELECT a.attname, col_description(a.attrelid, a.attnum)
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${quoteString(schema, driver)} AND c.relname = ${quoteString(table, driver)}
  AND a.attnum > 0 AND NOT a.attisdropped`;
    case "mysql":
      return `SELECT column_name, extra, column_comment
FROM information_schema.columns
WHERE table_schema = ${quoteString(schema, driver)} AND table_name = ${quoteString(table, driver)}`;
    case "mssql":
      return `SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.precision, c.scale,
  CAST(ep.value AS nvarchar(4000))
FROM sys.columns c
LEFT JOIN sys.extended_properties ep
  ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
 AND ep.name = N'MS_Description'
WHERE c.object_id = OBJECT_ID(${quoteString(mssqlTableRef(schema, table), driver)})`;
    default:
      return null;
  }
}

function asText(v: CellValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return null;
  return String(v);
}

function asNumber(v: CellValue | undefined): number | null {
  if (v === null || v === undefined || typeof v === "object") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Rebuild `nvarchar(50)` / `decimal(10,2)` / `varchar(max)` from sys.columns. */
export function mssqlFullType(
  typeName: string,
  maxLength: number | null,
  precision: number | null,
  scale: number | null,
): string {
  const t = typeName.toLowerCase();
  const len = (n: number | null) => (n === -1 ? "max" : String(n));
  if (["varchar", "char", "varbinary", "binary"].includes(t) && maxLength != null) {
    return `${t}(${len(maxLength)})`;
  }
  if (["nvarchar", "nchar"].includes(t) && maxLength != null) {
    return `${t}(${maxLength === -1 ? "max" : maxLength / 2})`;
  }
  if (["decimal", "numeric"].includes(t) && precision != null && scale != null) {
    return `${t}(${precision},${scale})`;
  }
  if (["datetime2", "time", "datetimeoffset"].includes(t) && scale != null) {
    return `${t}(${scale})`;
  }
  return t;
}

export function parseColumnExtras(
  driver: Driver,
  result: QueryResult,
): Map<string, ColumnExtras> {
  const out = new Map<string, ColumnExtras>();
  for (const row of result.rows) {
    const name = asText(row[0]);
    if (name == null) continue;
    if (driver === "postgres") {
      out.set(name, { comment: asText(row[1]) });
    } else if (driver === "mysql") {
      const comment = asText(row[2]);
      out.set(name, {
        extra: asText(row[1]) ?? "",
        comment: comment === "" ? null : comment,
      });
    } else if (driver === "mssql") {
      const typeName = asText(row[1]);
      out.set(name, {
        fullType: typeName
          ? mssqlFullType(
              typeName,
              asNumber(row[2]),
              asNumber(row[3]),
              asNumber(row[4]),
            )
          : undefined,
        comment: asText(row[5]),
      });
    }
  }
  return out;
}

const MYSQL_NOW_RE =
  /^(current_timestamp|now|localtime|localtimestamp|current_date|curdate|current_time|curtime|utc_timestamp)(\(\d*\))?$/i;

/**
 * information_schema.columns.column_default on MySQL 8 holds the *value* of a
 * literal default (`active`, not `'active'`), so it can't be pasted back after
 * DEFAULT. Turn it into an SQL expression: literals get quoted, expression
 * defaults (`extra` contains DEFAULT_GENERATED) get the parentheses MySQL
 * requires, and MariaDB's already-quoted form passes through.
 */
export function mysqlDefaultToExpr(
  raw: string | null | undefined,
  extra?: string,
): string {
  if (raw == null) return "";
  const v = raw.trim();
  if (v === "") return quoteString("", "mysql");
  if (/^null$/i.test(v)) return "NULL";
  if (MYSQL_NOW_RE.test(v)) return v;
  if (/DEFAULT_GENERATED/i.test(extra ?? "")) return `(${v})`;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) return v;
  if (/^[bx]'[0-9a-f]*'$/i.test(v)) return v; // bit / hex literal
  if (/^'.*'$/s.test(v)) return v; // MariaDB already quotes literals
  // Without `extra` (metadata query failed) a function call is still most
  // likely an expression default.
  if (extra === undefined && /^[a-z_][\w.]*\(.*\)$/is.test(v)) return `(${v})`;
  return quoteString(raw, "mysql");
}

export function draftFromColumn(
  driver: Driver,
  c: ColumnInfo,
  extras?: ColumnExtras,
): ColumnDraft {
  const original: ColumnInfo = {
    ...c,
    dataType: extras?.fullType || c.dataType,
    comment: extras?.comment ?? c.comment ?? null,
  };
  const originalDefault =
    driver === "mysql"
      ? mysqlDefaultToExpr(c.default, extras?.extra)
      : (c.default ?? "").trim();
  return {
    id: c.name,
    isNew: false,
    isDropped: false,
    original,
    originalDefault,
    extra: extras?.extra,
    name: c.name,
    dataType: original.dataType,
    nullable: c.nullable,
    defaultExpr: originalDefault,
    comment: original.comment ?? "",
    isPrimaryKey: c.isPrimaryKey,
    isUnique: c.isUnique,
  };
}

export function emptyDraft(seq: number): ColumnDraft {
  return {
    id: `new:${seq}`,
    isNew: true,
    isDropped: false,
    originalDefault: "",
    name: "",
    dataType: "",
    nullable: true,
    defaultExpr: "",
    comment: "",
    isPrimaryKey: false,
    isUnique: false,
  };
}

interface ColumnChanges {
  renamed: boolean;
  typeChanged: boolean;
  nullChanged: boolean;
  defaultChanged: boolean;
  commentChanged: boolean;
}

function diffColumn(driver: Driver, d: ColumnDraft): ColumnChanges | null {
  if (!d.original) return null;
  const newName = d.name.trim() || d.original.name;
  return {
    renamed: newName !== d.original.name,
    typeChanged:
      d.dataType.trim() !== "" &&
      normalizeDataType(driver, d.dataType) !==
        normalizeDataType(driver, d.original.dataType),
    nullChanged: d.nullable !== d.original.nullable,
    defaultChanged: d.defaultExpr.trim() !== d.originalDefault.trim(),
    commentChanged: d.comment.trim() !== (d.original.comment ?? "").trim(),
  };
}

export function isExistingDirty(driver: Driver, d: ColumnDraft): boolean {
  if (!d.original) return false;
  if (d.isDropped) return true;
  const c = diffColumn(driver, d);
  return (
    !!c &&
    (c.renamed || c.typeChanged || c.nullChanged || c.defaultChanged || c.commentChanged)
  );
}

function qi(driver: Driver, s: string): string {
  return quoteIdentStrict(driver, s);
}

function mssqlTableRef(schema: string, table: string): string {
  return `${quoteIdentStrict("mssql", schema)}.${quoteIdentStrict("mssql", table)}`;
}

/** Build the column-definition fragment used in ADD/CHANGE COLUMN. */
function colDefFragment(
  driver: Driver,
  d: ColumnDraft,
  mode: "add" | "change",
): string {
  const parts: string[] = [d.dataType.trim() || "TEXT"];
  parts.push(d.nullable ? "NULL" : "NOT NULL");
  if (d.defaultExpr.trim() !== "") {
    parts.push(`DEFAULT ${d.defaultExpr.trim()}`);
  }
  if (driver === "mysql" && mode === "change" && d.extra) {
    // CHANGE COLUMN is a full redefinition: carry over what describeTable
    // doesn't expose or the column silently loses it.
    const onUpdate = /on update ([\w()]+)/i.exec(d.extra);
    if (onUpdate?.[1]) parts.push(`ON UPDATE ${onUpdate[1]}`);
    if (/auto_increment/i.test(d.extra)) parts.push("AUTO_INCREMENT");
  }
  // Inline PK/UNIQUE only on ADD COLUMN — drivers accept it inline for new
  // columns, while toggling on existing requires constraint statements which
  // we don't generate from this editor (that's the Indexes tab's job).
  if (mode === "add") {
    if (d.isPrimaryKey) parts.push("PRIMARY KEY");
    else if (d.isUnique) parts.push("UNIQUE");
  }
  if (driver === "mysql" && d.comment.trim() !== "") {
    parts.push(`COMMENT ${quoteString(d.comment.trim(), driver)}`);
  }
  return parts.join(" ");
}

/** SQL Server keeps column defaults as (usually auto-named) constraints; they
 *  must be dropped before DROP COLUMN, a type change or a new default. */
function mssqlDropDefaultSql(schema: string, table: string, column: string): string {
  const tref = mssqlTableRef(schema, table);
  return (
    `DECLARE @df sysname = (SELECT dc.name FROM sys.default_constraints dc ` +
    `JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id ` +
    `WHERE dc.parent_object_id = OBJECT_ID(${quoteString(tref, "mssql")}) ` +
    `AND c.name = ${quoteString(column, "mssql")}); ` +
    // EXEC(...) only concatenates literals/variables, so build the text first.
    `IF @df IS NOT NULL BEGIN DECLARE @dropdf nvarchar(max) = ` +
    `N'ALTER TABLE ${tref.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df); ` +
    `EXEC sp_executesql @dropdf; END`
  );
}

/** Upsert / remove the MS_Description extended property (SSMS's comments). */
function mssqlCommentSql(
  schema: string,
  table: string,
  column: string,
  comment: string,
): string {
  const lit = (s: string) => quoteString(s, "mssql");
  const tref = lit(mssqlTableRef(schema, table));
  const target =
    `@level0type = N'SCHEMA', @level0name = ${lit(schema)}, ` +
    `@level1type = N'TABLE', @level1name = ${lit(table)}, ` +
    `@level2type = N'COLUMN', @level2name = ${lit(column)}`;
  const exists =
    `EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 1 ` +
    `AND name = N'MS_Description' AND major_id = OBJECT_ID(${tref}) ` +
    `AND minor_id = COLUMNPROPERTY(OBJECT_ID(${tref}), ${lit(column)}, 'ColumnId'))`;
  if (comment === "") {
    return `IF ${exists} EXEC sys.sp_dropextendedproperty @name = N'MS_Description', ${target}`;
  }
  const value = `@value = ${lit(comment)}`;
  return (
    `IF ${exists} EXEC sys.sp_updateextendedproperty @name = N'MS_Description', ${value}, ${target} ` +
    `ELSE EXEC sys.sp_addextendedproperty @name = N'MS_Description', ${value}, ${target}`
  );
}

/** SQL Server types where a bare name silently means length 1 / (18,0). */
const MSSQL_NEEDS_PARAMS = new Set([
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "binary",
  "varbinary",
  "decimal",
  "numeric",
]);

/**
 * Problems that would make the generated statements wrong rather than merely
 * fail. Today: SQL Server `ALTER COLUMN x nvarchar` (= nvarchar(1)) truncates
 * data, so length-bearing types must say their length explicitly.
 */
export function validateDrafts(driver: Driver, drafts: ColumnDraft[]): string[] {
  const errors: string[] = [];
  if (driver !== "mssql") return errors;
  for (const d of drafts) {
    if (d.isDropped) continue;
    let emitsType = false;
    if (d.isNew) {
      emitsType = d.name.trim() !== "";
    } else {
      const c = diffColumn(driver, d);
      emitsType = !!c && (c.typeChanged || c.nullChanged);
    }
    if (!emitsType) continue;
    const { base, params } = splitDataType(d.dataType || "");
    if (MSSQL_NEEDS_PARAMS.has(base.toLowerCase()) && !params) {
      errors.push(
        `"${d.name.trim() || d.original?.name}": indicá la longitud/precisión del tipo (ej. ${base.toUpperCase()}(100)) — en SQL Server ${base.toUpperCase()} sin parámetros equivale a longitud 1 y trunca los datos.`,
      );
    }
  }
  return errors;
}

/** Produce the ordered list of SQL statements that turn `originals` into the
 *  current `drafts`. Statements are run sequentially; first failure halts. */
export function buildAlterStatements(
  driver: Driver,
  schema: string,
  table: string,
  drafts: ColumnDraft[],
): string[] {
  const out: string[] = [];
  const tableRef = `${qi(driver, schema)}.${qi(driver, table)}`;

  // Drops first: avoids name conflicts when renaming or re-adding.
  for (const d of drafts) {
    if (!d.original || !d.isDropped) continue;
    if (driver === "mssql" && d.originalDefault !== "") {
      out.push(mssqlDropDefaultSql(schema, table, d.original.name));
    }
    out.push(
      `ALTER TABLE ${tableRef} DROP COLUMN ${qi(driver, d.original.name)}`,
    );
  }

  // Modifications.
  for (const d of drafts) {
    if (!d.original || d.isDropped) continue;
    const c = diffColumn(driver, d);
    if (!c) continue;
    if (!(c.renamed || c.typeChanged || c.nullChanged || c.defaultChanged || c.commentChanged)) {
      continue;
    }
    const oldName = d.original.name;
    const newName = d.name.trim() || oldName;
    const newDefault = d.defaultExpr.trim();
    const newType = d.dataType.trim() || d.original.dataType;

    if (driver === "mysql") {
      if (c.renamed && !c.typeChanged && !c.nullChanged && !c.defaultChanged && !c.commentChanged) {
        // A pure rename keeps every other attribute untouched.
        out.push(
          `ALTER TABLE ${tableRef} RENAME COLUMN ${qi(driver, oldName)} TO ${qi(driver, newName)}`,
        );
      } else {
        // CHANGE COLUMN handles rename + full redefinition in one shot.
        out.push(
          `ALTER TABLE ${tableRef} CHANGE COLUMN ${qi(driver, oldName)} ${qi(
            driver,
            newName,
          )} ${colDefFragment(driver, d, "change")}`,
        );
      }
    } else if (driver === "mssql") {
      if (c.renamed) {
        out.push(
          `EXEC sp_rename ${quoteString(`${mssqlTableRef(schema, table)}.${qi(driver, oldName)}`, driver)}, ${quoteString(newName, driver)}, 'COLUMN'`,
        );
      }
      const colRef = qi(driver, newName);
      // A bound default blocks a type change and has to go before a new one.
      const dropsDefault =
        d.originalDefault !== "" && (c.typeChanged || c.defaultChanged);
      if (dropsDefault) out.push(mssqlDropDefaultSql(schema, table, newName));
      if (c.typeChanged || c.nullChanged) {
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} ${newType} ${d.nullable ? "NULL" : "NOT NULL"}`,
        );
      }
      if (newDefault !== "" && (c.defaultChanged || dropsDefault)) {
        out.push(`ALTER TABLE ${tableRef} ADD DEFAULT ${newDefault} FOR ${colRef}`);
      }
      if (c.commentChanged) {
        out.push(mssqlCommentSql(schema, table, newName, d.comment.trim()));
      }
    } else {
      // postgres
      if (c.renamed) {
        out.push(
          `ALTER TABLE ${tableRef} RENAME COLUMN ${qi(driver, oldName)} TO ${qi(driver, newName)}`,
        );
      }
      const colRef = qi(driver, newName);
      // An old default that can't be cast to the new type would make ALTER
      // TYPE fail, so drop it first when it's being replaced anyway.
      const dropDefaultFirst =
        c.typeChanged && c.defaultChanged && d.originalDefault !== "";
      if (dropDefaultFirst) {
        out.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} DROP DEFAULT`);
      }
      if (c.typeChanged) {
        // USING makes conversions without an implicit cast (text → integer)
        // work; for castable types it's a no-op.
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} TYPE ${newType} USING ${colRef}::${newType}`,
        );
      }
      if (c.nullChanged) {
        out.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} ${d.nullable ? "DROP" : "SET"} NOT NULL`,
        );
      }
      if (c.defaultChanged) {
        if (newDefault !== "") {
          out.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} SET DEFAULT ${newDefault}`);
        } else if (!dropDefaultFirst) {
          out.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${colRef} DROP DEFAULT`);
        }
      }
      if (c.commentChanged) {
        const comment = d.comment.trim();
        out.push(
          `COMMENT ON COLUMN ${tableRef}.${colRef} IS ${comment === "" ? "NULL" : quoteString(comment, driver)}`,
        );
      }
    }
  }

  // Adds last so renames clear the old names.
  for (const d of drafts) {
    if (!d.isNew || d.isDropped) continue;
    const colName = d.name.trim();
    if (!colName) continue;
    // T-SQL's ALTER TABLE has no COLUMN keyword after ADD.
    const add = driver === "mssql" ? "ADD" : "ADD COLUMN";
    out.push(
      `ALTER TABLE ${tableRef} ${add} ${qi(driver, colName)} ${colDefFragment(driver, d, "add")}`,
    );
    const comment = d.comment.trim();
    if (comment !== "") {
      if (driver === "postgres") {
        out.push(
          `COMMENT ON COLUMN ${tableRef}.${qi(driver, colName)} IS ${quoteString(comment, driver)}`,
        );
      } else if (driver === "mssql") {
        out.push(mssqlCommentSql(schema, table, colName, comment));
      }
    }
  }

  return out;
}
