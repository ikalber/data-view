import type { CellValue, QueryResult, QueryResultColumn } from "./types";
import type { DatabaseDriver } from "./types";
import type { ExportFormat } from "./export";
import { quoteIdent, quoteString } from "./sql-utils";

export interface FormatRowsOptions {
  format: ExportFormat;
  driver?: DatabaseDriver | null;
  /** Used to build the INSERT INTO target for the SQL format. */
  schema?: string;
  table?: string;
  /** Emit a header row (CSV/TSV) or the column comment block (SQL). */
  includeHeader?: boolean;
  /** Rows per INSERT for the SQL format. Defaults to 100. */
  batchSize?: number;
}

const NUMERIC_TYPE_RE =
  /^(int|bigint|smallint|tinyint|mediumint|integer|number|numeric|decimal|float|double|real|money|smallmoney|bit\b)/i;

function looksNumeric(dataType?: string): boolean {
  return !!dataType && NUMERIC_TYPE_RE.test(dataType);
}

function looksBoolean(dataType?: string): boolean {
  return !!dataType && /^(bool|boolean|tinyint\(1\)|bit\(1\))/i.test(dataType);
}

/** Render a CellValue as a plain string (no quoting, no NULL marker). */
export function cellAsString(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "object" && "__binary" in v) return `<binary ${v.bytes}B>`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function cellAsJson(v: CellValue): unknown {
  if (v === null) return null;
  if (typeof v === "object" && "__binary" in v) return `<binary ${v.bytes}B>`;
  return v;
}

function escapeCsvField(text: string, delimiter: string): string {
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r");
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function cellAsSqlLiteral(
  v: CellValue,
  col: QueryResultColumn,
  driver: DatabaseDriver | null | undefined,
): string {
  if (v === null) return "NULL";
  if (typeof v === "object" && "__binary" in v) return "NULL";
  if (typeof v === "boolean") {
    if (driver === "mysql") return v ? "1" : "0";
    return v ? "TRUE" : "FALSE";
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : "NULL";
  }
  if (looksBoolean(col.dataType)) {
    const truthy = v === "true" || v === "1";
    if (driver === "mysql") return truthy ? "1" : "0";
    return truthy ? "TRUE" : "FALSE";
  }
  if (looksNumeric(col.dataType) && /^-?\d+(\.\d+)?$/.test(v)) {
    return v;
  }
  return quoteString(v);
}

function sqlTableRef(opts: FormatRowsOptions): string {
  const name = opts.table ?? "exported_table";
  if (opts.schema) {
    return `${quoteIdent(opts.driver, opts.schema)}.${quoteIdent(
      opts.driver,
      name,
    )}`;
  }
  return quoteIdent(opts.driver, name);
}

/** Format a complete QueryResult as a string in the requested format. */
export function formatRows(result: QueryResult, opts: FormatRowsOptions): string {
  switch (opts.format) {
    case "csv":
      return formatDelimited(result, ",", opts.includeHeader ?? true);
    case "tsv":
      return formatDelimited(result, "\t", opts.includeHeader ?? true);
    case "json":
      return formatJson(result);
    case "ndjson":
      return formatNdjson(result);
    case "sql":
      return formatSqlInserts(result, opts);
    case "markdown":
      return formatMarkdown(result);
  }
}

function formatDelimited(r: QueryResult, delimiter: string, header: boolean): string {
  const lines: string[] = [];
  if (header) {
    lines.push(
      r.columns.map((c) => escapeCsvField(c.name, delimiter)).join(delimiter),
    );
  }
  for (const row of r.rows) {
    lines.push(
      row
        .map((v) => escapeCsvField(cellAsString(v as CellValue), delimiter))
        .join(delimiter),
    );
  }
  return lines.join("\r\n");
}

function formatJson(r: QueryResult): string {
  const rows = r.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    r.columns.forEach((col, i) => {
      obj[col.name] = cellAsJson(row[i] as CellValue);
    });
    return obj;
  });
  return JSON.stringify(rows, null, 2);
}

function formatNdjson(r: QueryResult): string {
  return r.rows
    .map((row) => {
      const obj: Record<string, unknown> = {};
      r.columns.forEach((col, i) => {
        obj[col.name] = cellAsJson(row[i] as CellValue);
      });
      return JSON.stringify(obj);
    })
    .join("\n");
}

function formatSqlInserts(r: QueryResult, opts: FormatRowsOptions): string {
  if (r.columns.length === 0 || r.rows.length === 0) return "";
  const tableRef = sqlTableRef(opts);
  const colList = r.columns
    .map((c) => quoteIdent(opts.driver, c.name))
    .join(", ");
  const batchSize = Math.max(1, opts.batchSize ?? 100);
  const out: string[] = [];
  for (let i = 0; i < r.rows.length; i += batchSize) {
    const batch = r.rows.slice(i, i + batchSize);
    const valuesParts = batch.map((row) => {
      const vals = r.columns.map((col, j) =>
        cellAsSqlLiteral(row[j] as CellValue, col, opts.driver),
      );
      return `(${vals.join(", ")})`;
    });
    out.push(
      `INSERT INTO ${tableRef} (${colList}) VALUES\n  ${valuesParts.join(
        ",\n  ",
      )};`,
    );
  }
  return out.join("\n\n") + "\n";
}

function formatMarkdown(r: QueryResult): string {
  if (r.columns.length === 0) return "(sin columnas)";
  const escape = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${r.columns.map((c) => escape(c.name)).join(" | ")} |`;
  const sep = `| ${r.columns.map(() => "---").join(" | ")} |`;
  const rows = r.rows.map(
    (row) =>
      `| ${row
        .map((v) => {
          const s = cellAsString(v as CellValue);
          return s === "" && (v as CellValue) === null ? "" : escape(s);
        })
        .join(" | ")} |`,
  );
  return [header, sep, ...rows].join("\n");
}

/** Best-fit MIME type per format. */
export function exportMimeType(format: ExportFormat): string {
  switch (format) {
    case "csv":
      return "text/csv;charset=utf-8";
    case "tsv":
      return "text/tab-separated-values;charset=utf-8";
    case "json":
      return "application/json;charset=utf-8";
    case "ndjson":
      return "application/x-ndjson;charset=utf-8";
    case "sql":
      return "application/sql;charset=utf-8";
    case "markdown":
      return "text/markdown;charset=utf-8";
  }
}

/**
 * Build the row-list fragment for one batch — used by streaming exporters
 * that emit "header once, then batch by batch". For SQL this is the VALUES
 * tuples *without* leading "INSERT INTO ... VALUES" — the caller controls
 * statement boundaries.
 */
export function formatBatchBody(
  rows: ReadonlyArray<ReadonlyArray<CellValue>>,
  columns: QueryResultColumn[],
  opts: FormatRowsOptions,
): string {
  switch (opts.format) {
    case "csv":
      return rows
        .map((row) =>
          row.map((v) => escapeCsvField(cellAsString(v as CellValue), ",")).join(","),
        )
        .join("\r\n");
    case "tsv":
      return rows
        .map((row) =>
          row.map((v) => escapeCsvField(cellAsString(v as CellValue), "\t")).join("\t"),
        )
        .join("\r\n");
    case "ndjson":
      return rows
        .map((row) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, i) => {
            obj[col.name] = cellAsJson(row[i] as CellValue);
          });
          return JSON.stringify(obj);
        })
        .join("\n");
    case "json":
      // JSON arrays are stateful (need brackets/commas); the streaming
      // exporter handles the framing. Return rows as ", "-joined value blocks.
      return rows
        .map((row) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, i) => {
            obj[col.name] = cellAsJson(row[i] as CellValue);
          });
          return "  " + JSON.stringify(obj);
        })
        .join(",\n");
    case "sql": {
      const tableRef = sqlTableRef(opts);
      const colList = columns.map((c) => quoteIdent(opts.driver, c.name)).join(", ");
      const valuesParts = rows.map((row) => {
        const vals = columns.map((col, j) =>
          cellAsSqlLiteral(row[j] as CellValue, col, opts.driver),
        );
        return `(${vals.join(", ")})`;
      });
      return `INSERT INTO ${tableRef} (${colList}) VALUES\n  ${valuesParts.join(
        ",\n  ",
      )};\n`;
    }
    case "markdown":
      return rows
        .map(
          (row) =>
            `| ${row
              .map((v) => {
                const s = cellAsString(v as CellValue);
                return s === "" && (v as CellValue) === null
                  ? ""
                  : s
                      .replace(/\\/g, "\\\\")
                      .replace(/\|/g, "\\|")
                      .replace(/\n/g, " ");
              })
              .join(" | ")} |`,
        )
        .join("\n");
  }
}

/**
 * Produces the bytes that go *before* the first batch — CSV/TSV header,
 * JSON opening "[", markdown header. For SQL/NDJSON: empty.
 */
export function formatBatchPrelude(
  columns: QueryResultColumn[],
  opts: FormatRowsOptions,
): string {
  switch (opts.format) {
    case "csv":
      return opts.includeHeader === false
        ? ""
        : columns.map((c) => escapeCsvField(c.name, ",")).join(",") + "\r\n";
    case "tsv":
      return opts.includeHeader === false
        ? ""
        : columns.map((c) => escapeCsvField(c.name, "\t")).join("\t") + "\r\n";
    case "json":
      return "[\n";
    case "markdown": {
      const head = `| ${columns
        .map((c) => c.name.replace(/\|/g, "\\|"))
        .join(" | ")} |`;
      const sep = `| ${columns.map(() => "---").join(" | ")} |`;
      return `${head}\n${sep}\n`;
    }
    case "ndjson":
    case "sql":
      return "";
  }
}

/** Bytes after the last batch (close JSON array, etc). */
export function formatBatchPostlude(opts: FormatRowsOptions): string {
  switch (opts.format) {
    case "json":
      return "\n]\n";
    case "csv":
    case "tsv":
    case "markdown":
      return "\n";
    case "ndjson":
    case "sql":
      return "";
  }
}

/** Separator inserted between successive batches (handles JSON's ", "). */
export function formatBatchSeparator(opts: FormatRowsOptions): string {
  switch (opts.format) {
    case "json":
      return ",\n";
    case "csv":
    case "tsv":
    case "markdown":
      return "\r\n";
    case "ndjson":
      return "\n";
    case "sql":
      return "\n";
  }
}
