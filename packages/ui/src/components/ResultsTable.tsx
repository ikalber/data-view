"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import type { CellValue, QueryResult } from "@data-view/core";
import { CellViewerModal } from "./CellViewerModal";

function renderCell(value: CellValue): { text: string; isNull: boolean } {
  if (value === null) return { text: "NULL", isNull: true };
  if (typeof value === "object" && "__binary" in value) {
    return { text: `<binary ${value.bytes}B>`, isNull: false };
  }
  if (typeof value === "boolean") return { text: value ? "true" : "false", isNull: false };
  return { text: String(value), isNull: false };
}

interface InspectingCell {
  columnName: string;
  dataType?: string;
  value: CellValue;
}

export function ResultsTable({ result }: { result: QueryResult | null }) {
  const [filter, setFilter] = useState("");
  const [inspecting, setInspecting] = useState<InspectingCell | null>(null);

  // Filter rows client-side: a row matches when any cell's rendered text
  // contains the (case-insensitive) query.
  const filteredRows = useMemo(() => {
    if (!result) return [] as typeof result extends null ? never : QueryResult["rows"];
    const q = filter.trim().toLowerCase();
    if (!q) return result.rows;
    return result.rows.filter((row) =>
      row.some((cell) => renderCell(cell).text.toLowerCase().includes(q)),
    );
  }, [result, filter]);

  if (!result) return <div className="dv-empty">Ejecutá una query para ver resultados.</div>;
  if (result.columns.length === 0) {
    return (
      <div className="dv-empty">
        Sin filas {result.affectedRows != null && `(${result.affectedRows} afectadas)`}
      </div>
    );
  }
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px 8px",
          borderBottom: "1px solid var(--dv-border)",
          background: "var(--dv-bg-soft)",
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <input
          type="search"
          className="dv-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar filas… (búsqueda local)"
          autoComplete="off"
          spellCheck={false}
          style={{ flex: 1, maxWidth: 360, fontSize: 12, padding: "4px 8px" }}
        />
        <span style={{ fontSize: 11, color: "var(--dv-text-dim)" }}>
          {filter
            ? `${filteredRows.length} de ${result.rows.length} filas`
            : `${result.rows.length} filas`}
          {" · doble click en una celda para ver detalle"}
        </span>
      </div>
      <table className="dv-table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} title={c.dataType}>
                {c.name}
                <span style={{ color: "var(--dv-text-muted)", fontWeight: 400, marginLeft: 6 }}>
                  {c.dataType}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filteredRows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => {
                const r = renderCell(cell);
                const col = result.columns[j]!;
                return (
                  <td
                    key={j}
                    className={clsx(r.isNull && "is-null")}
                    title={r.text}
                    onDoubleClick={() =>
                      setInspecting({
                        columnName: col.name,
                        dataType: col.dataType,
                        value: cell,
                      })
                    }
                    style={{ cursor: "default" }}
                  >
                    {r.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {inspecting && (
        <CellViewerModal
          columnName={inspecting.columnName}
          dataType={inspecting.dataType}
          value={inspecting.value}
          onClose={() => setInspecting(null)}
        />
      )}
    </>
  );
}
