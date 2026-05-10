"use client";

import clsx from "clsx";
import type { CellValue, QueryResult } from "@data-view/core";

function renderCell(value: CellValue): { text: string; isNull: boolean } {
  if (value === null) return { text: "NULL", isNull: true };
  if (typeof value === "object" && "__binary" in value) {
    return { text: `<binary ${value.bytes}B>`, isNull: false };
  }
  if (typeof value === "boolean") return { text: value ? "true" : "false", isNull: false };
  return { text: String(value), isNull: false };
}

export function ResultsTable({ result }: { result: QueryResult | null }) {
  if (!result) return <div className="dv-empty">Ejecutá una query para ver resultados.</div>;
  if (result.columns.length === 0) {
    return (
      <div className="dv-empty">
        Sin filas {result.affectedRows != null && `(${result.affectedRows} afectadas)`}
      </div>
    );
  }
  return (
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
        {result.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => {
              const r = renderCell(cell);
              return (
                <td key={j} className={clsx(r.isNull && "is-null")} title={r.text}>
                  {r.text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
