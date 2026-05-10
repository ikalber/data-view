"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type {
  CellValue,
  ColumnInfo,
  QueryResult,
} from "@data-view/core";

export type SortState = {
  column: string;
  direction: "asc" | "desc";
} | null;

export interface RowEdit {
  /** column name → new value as a string ("" means empty/NULL) */
  changes: Record<string, string>;
}

interface Props {
  result: QueryResult | null;
  /** Column metadata from describeTable, indexed by name. */
  columnsInfo: Map<string, ColumnInfo>;
  /** PK column names, in order. Empty if the table has no primary key. */
  pkColumns: string[];
  /** pkKey → RowEdit. Owned by the parent so it survives refetches. */
  edits: Map<string, RowEdit>;
  /** pkKey → error from last save attempt (sticks until the row saves OK). */
  rowErrors: Map<string, string>;
  sort: SortState;
  loading: boolean;
  onToggleSort: (column: string) => void;
  /** Commits a cell change to the dirty buffer (or removes it). */
  onChangeCell: (pkKey: string, colName: string, value: string | null) => void;
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
    .join("");
}

/** Render a CellValue as a plain string for display / editing. */
export function cellToString(v: CellValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object" && "__binary" in v) return `<binary ${v.bytes}B>`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Detect MySQL-style enum types from the dataType string. */
export function parseEnumValues(dataType: string | undefined): string[] | null {
  if (!dataType) return null;
  const m = /^enum\((.+)\)$/i.exec(dataType);
  if (!m || !m[1]) return null;
  const matches = m[1].match(/'((?:[^']|'')*)'/g);
  if (!matches) return null;
  return matches.map((s) => s.slice(1, -1).replace(/''/g, "'"));
}

function isReadOnly(col: ColumnInfo | undefined): boolean {
  if (!col) return false;
  if (col.isPrimaryKey) return true;
  return false;
}

function isBoolType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  return /^(bool|boolean|bit\(1\)|tinyint\(1\))/i.test(dataType);
}

export function EditableDataGrid({
  result,
  columnsInfo,
  pkColumns,
  edits,
  rowErrors,
  sort,
  loading,
  onToggleSort,
  onChangeCell,
}: Props) {
  const [editing, setEditing] = useState<{ pkKey: string; col: string } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  // Focus & select the input when entering edit mode.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    if (inputRef.current && "select" in inputRef.current) {
      (inputRef.current as HTMLInputElement).select?.();
    }
  }, [editing]);

  const colNameToIdx = useMemo(() => {
    const map = new Map<string, number>();
    if (!result) return map;
    result.columns.forEach((c, i) => map.set(c.name, i));
    return map;
  }, [result]);

  if (!result) {
    return (
      <div className="dv-empty">
        {loading ? "Cargando…" : "Sin resultados."}
      </div>
    );
  }

  if (result.columns.length === 0) {
    return <div className="dv-empty">Sin columnas.</div>;
  }

  function commit(pkKey: string, col: string, original: string, value: string) {
    setEditing(null);
    if (value === original) {
      // No change — clear any prior edit for this cell.
      onChangeCell(pkKey, col, null);
    } else {
      onChangeCell(pkKey, col, value);
    }
  }

  function cancel() {
    setEditing(null);
  }

  function startEdit(pkKey: string, col: string, currentDisplay: string) {
    setDraft(currentDisplay);
    setEditing({ pkKey, col });
  }

  function onKeyDown(
    e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    pkKey: string,
    col: string,
    original: string,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(pkKey, col, original, draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      // Commit on Tab so users can move to next cell quickly. We don't
      // jump focus to neighbour cells (skip for now) but at least the value
      // is preserved.
      commit(pkKey, col, original, draft);
    }
  }

  return (
    <table className="dv-table" role="grid">
      <thead>
        <tr>
          {pkColumns.length > 0 && <th style={{ width: 40 }}>#</th>}
          {result.columns.map((c) => {
            const isSorted = sort?.column === c.name;
            const isPk = pkColumns.includes(c.name);
            return (
              <th
                key={c.name}
                className={clsx(
                  "is-sortable",
                  isSorted && "is-sorted",
                  isPk && "is-pk",
                )}
                onClick={() => onToggleSort(c.name)}
                title={`Ordenar por ${c.name}`}
              >
                {c.name}
                <span className="dv-sort-caret">
                  {isSorted ? (sort!.direction === "asc" ? "▲" : "▼") : "▴▾"}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, rowIdx) => {
          const pkKey = rowPkKey(row, colNameToIdx, pkColumns);
          const rowEdits = pkKey ? edits.get(pkKey)?.changes : undefined;
          const rowError = pkKey ? rowErrors.get(pkKey) : undefined;
          return (
            <tr key={pkKey ?? rowIdx}>
              {pkColumns.length > 0 && (
                <td className="is-pk" style={{ textAlign: "right" }}>
                  {rowIdx + 1}
                </td>
              )}
              {result.columns.map((c) => {
                const colInfo = columnsInfo.get(c.name);
                const original = cellToString(row[colNameToIdx.get(c.name) ?? -1]);
                const editedVal = rowEdits?.[c.name];
                const display = editedVal ?? original;
                const dirty =
                  editedVal !== undefined && editedVal !== original;
                const readonly = !pkKey || isReadOnly(colInfo);
                const isEditing =
                  editing != null &&
                  editing.pkKey === pkKey &&
                  editing.col === c.name;

                return (
                  <td
                    key={c.name}
                    className={clsx(
                      !isEditing && !readonly && "is-editable",
                      isEditing && "is-editing",
                      dirty && "is-dirty",
                      rowError && "is-row-error",
                      colInfo?.isPrimaryKey && "is-pk",
                    )}
                    onDoubleClick={() => {
                      if (readonly || !pkKey) return;
                      startEdit(pkKey, c.name, display);
                    }}
                    title={
                      readonly
                        ? colInfo?.isPrimaryKey
                          ? "PK — no editable"
                          : !pkKey
                          ? "Tabla sin PK — no editable"
                          : "No editable"
                        : `${c.name}${colInfo ? ` · ${colInfo.dataType}` : ""}`
                    }
                  >
                    {isEditing && pkKey ? (
                      renderEditor(
                        c.name,
                        colInfo,
                        draft,
                        setDraft,
                        (e) => onKeyDown(e, pkKey, c.name, original),
                        () => commit(pkKey, c.name, original, draft),
                        inputRef,
                      )
                    ) : (
                      <span
                        style={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontStyle:
                            display === "" && !dirty ? "italic" : "normal",
                          color:
                            display === "" && !dirty
                              ? "var(--dv-text-mute)"
                              : undefined,
                        }}
                      >
                        {display === "" ? "NULL" : display}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function renderEditor(
  colName: string,
  colInfo: ColumnInfo | undefined,
  draft: string,
  setDraft: (v: string) => void,
  onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void,
  onCommit: () => void,
  ref: React.MutableRefObject<HTMLInputElement | HTMLSelectElement | null>,
) {
  const enumValues = parseEnumValues(colInfo?.dataType);
  if (enumValues) {
    return (
      <select
        ref={(el) => {
          ref.current = el;
        }}
        className="dv-cell-select"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCommit}
      >
        {colInfo?.nullable && <option value="">(NULL)</option>}
        {enumValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  if (isBoolType(colInfo?.dataType)) {
    return (
      <select
        ref={(el) => {
          ref.current = el;
        }}
        className="dv-cell-select"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCommit}
      >
        {colInfo?.nullable && <option value="">(NULL)</option>}
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  return (
    <input
      ref={(el) => {
        ref.current = el;
      }}
      className="dv-cell-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCommit}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      aria-label={`Editar ${colName}`}
    />
  );
}
