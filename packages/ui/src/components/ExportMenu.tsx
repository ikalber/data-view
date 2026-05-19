"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  EXPORT_FORMATS,
  defaultExportFileName,
  type DatabaseDriver,
  type ExportFormat,
  type QueryResult,
} from "@data-view/core";
import {
  downloadString,
  exportMimeType,
  formatExport,
} from "../export-format";

interface Props {
  /** Source for in-memory export. May be null while loading. */
  result: QueryResult | null;
  /** Used to scope filenames / SQL INSERT targets. */
  baseName: string;
  driver?: DatabaseDriver | null;
  schema?: string;
  table?: string;
  /** Optional: when set, the menu offers a "full table" entry that calls back. */
  onExportFullTable?: (format: ExportFormat) => void;
  /** Label override for the trigger button. Defaults to "Export". */
  label?: string;
  /** CSS class override for the trigger button. */
  className?: string;
  /** Disables both in-memory and full-table options. */
  disabled?: boolean;
}

/**
 * Dropdown that lets the user export the currently visible result set (cheap,
 * client-side) or — when `onExportFullTable` is provided — the entire table
 * (delegated to the transport).
 */
export function ExportMenu({
  result,
  baseName,
  driver,
  schema,
  table,
  onExportFullTable,
  label = "Export",
  className,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const canExportVisible = !!result && result.columns.length > 0;
  const canExportFull = !!onExportFullTable;

  function doExportVisible(format: ExportFormat) {
    if (!result) return;
    const text = formatExport(result, {
      format,
      driver,
      schema,
      table: table ?? baseName,
      includeHeader: true,
    });
    const filename = defaultExportFileName(baseName, format, driver ?? undefined);
    downloadString(filename, exportMimeType(format), text);
    setOpen(false);
  }

  function doExportFull(format: ExportFormat) {
    onExportFullTable?.(format);
    setOpen(false);
  }

  return (
    <div className="dv-export-root" ref={rootRef}>
      <button
        type="button"
        className={clsx("dv-button", className)}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || (!canExportVisible && !canExportFull)}
        title="Exportar"
      >
        {label}
        <span className="dv-export-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="dv-export-menu" role="menu">
          <div className="dv-export-section">
            <div className="dv-export-section-title">
              {canExportFull ? "Filas visibles" : "Resultados"}
            </div>
            {EXPORT_FORMATS.map((f) => (
              <button
                key={`v-${f.value}`}
                type="button"
                role="menuitem"
                className="dv-export-item"
                onClick={() => doExportVisible(f.value)}
                disabled={!canExportVisible}
              >
                <span>{f.label}</span>
                <span className="dv-export-ext">.{f.ext}</span>
              </button>
            ))}
          </div>

          {canExportFull && (
            <div className="dv-export-section">
              <div className="dv-export-section-title">Tabla completa</div>
              {EXPORT_FORMATS.filter((f) => f.value !== "markdown").map((f) => (
                <button
                  key={`f-${f.value}`}
                  type="button"
                  role="menuitem"
                  className="dv-export-item"
                  onClick={() => doExportFull(f.value)}
                >
                  <span>{f.label}</span>
                  <span className="dv-export-ext">.{f.ext}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
