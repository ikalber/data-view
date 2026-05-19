import {
  exportMimeType,
  formatRows,
  type FormatRowsOptions,
} from "@data-view/core";
import type { QueryResult } from "@data-view/core";

/** Re-export so the UI keeps a single import surface. */
export { exportMimeType };
export type FormatOptions = FormatRowsOptions;
export const formatExport = (
  result: QueryResult,
  opts: FormatRowsOptions,
): string => formatRows(result, opts);

/**
 * Trigger a browser download for a string payload. No-op outside the
 * browser environment; the desktop transport writes to disk instead.
 */
export function downloadString(filename: string, mime: string, data: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
