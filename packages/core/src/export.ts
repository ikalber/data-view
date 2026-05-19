import type { DatabaseDriver } from "./types";

/** Formats supported when exporting query results or table data. */
export type ExportFormat = "csv" | "tsv" | "json" | "ndjson" | "sql" | "markdown";

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "tsv", label: "TSV", ext: "tsv" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "ndjson", label: "NDJSON", ext: "ndjson" },
  { value: "sql", label: "SQL inserts", ext: "sql" },
  { value: "markdown", label: "Markdown", ext: "md" },
];

export interface ExportTableOptions {
  format: ExportFormat;
  /** WHERE expression appended to the SELECT — same shape as PageOptions.where. */
  where?: string;
  /** Include a header row (CSV/TSV) or column comments (SQL). */
  includeHeader?: boolean;
  /** For SQL: number of rows per INSERT statement (defaults to 100). */
  batchSize?: number;
}

export interface ExportTableResult {
  rowCount: number;
  bytes: number;
  durationMs: number;
  format: ExportFormat;
  /** Desktop only — absolute file path where the export was written. */
  filePath?: string;
  /** Web only — suggested filename for the download. */
  fileName?: string;
}

export interface ExportDatabaseOptions {
  /** Schemas to dump. Empty/undefined ⇒ all non-system schemas. */
  schemas?: string[];
  /** Include CREATE TABLE / CREATE VIEW DDL. */
  includeSchema?: boolean;
  /** Include INSERT statements with the data. */
  includeData?: boolean;
  /** When dumping data: rows per INSERT statement. Default 100. */
  batchSize?: number;
  /** Prefix every CREATE TABLE with DROP TABLE IF EXISTS. */
  dropIfExists?: boolean;
}

export interface ExportDatabaseResult {
  bytes: number;
  durationMs: number;
  tableCount: number;
  rowCount: number;
  filePath?: string;
  fileName?: string;
}

/** Convenience: build a filename like `users-2026-05-18.csv`. */
export function defaultExportFileName(
  baseName: string,
  format: ExportFormat,
  driver?: DatabaseDriver,
): string {
  const ext = EXPORT_FORMATS.find((f) => f.value === format)?.ext ?? format;
  const date = new Date().toISOString().slice(0, 10);
  const safe = baseName.replace(/[^A-Za-z0-9._-]+/g, "_");
  const prefix = driver ? `${driver}-` : "";
  return `${prefix}${safe}-${date}.${ext}`;
}
