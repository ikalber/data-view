"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
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

/** A row staged for INSERT. `values` only contains columns the user touched —
 * missing columns fall back to the column's DB default. */
export interface NewRow {
  tempId: string;
  values: Record<string, string>;
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

  /** Rows staged for INSERT. Rendered below the regular rows. */
  newRows?: NewRow[];
  /** tempId → error from last save attempt. */
  newRowErrors?: Map<string, string>;
  /** Update a single cell on a staged row. */
  onChangeNewRowCell?: (tempId: string, colName: string, value: string) => void;
  /** Remove a staged row from the buffer. */
  onRemoveNewRow?: (tempId: string) => void;
  /** Distribute a tab/newline-delimited paste across cells, creating new
   * staged rows if the paste has more rows than currently exist below the
   * starting row. */
  onPasteMatrix?: (
    startTempId: string,
    startCol: string,
    matrix: string[][],
  ) => void;
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

type EditingCell =
  | { kind: "edit"; pkKey: string; col: string }
  | { kind: "new"; tempId: string; col: string };

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
  newRows,
  newRowErrors,
  onChangeNewRowCell,
  onRemoveNewRow,
  onPasteMatrix,
}: Props) {
  const [editing, setEditing] = useState<EditingCell | null>(null);
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

  function commitExisting(
    pkKey: string,
    col: string,
    original: string,
    value: string,
  ) {
    setEditing(null);
    if (value === original) {
      // No change — clear any prior edit for this cell.
      onChangeCell(pkKey, col, null);
    } else {
      onChangeCell(pkKey, col, value);
    }
  }

  function commitNew(tempId: string, col: string, value: string) {
    setEditing(null);
    onChangeNewRowCell?.(tempId, col, value);
  }

  function cancel() {
    setEditing(null);
  }

  function startEdit(pkKey: string, col: string, currentDisplay: string) {
    setDraft(currentDisplay);
    setEditing({ kind: "edit", pkKey, col });
  }

  function startEditNew(tempId: string, col: string, currentDisplay: string) {
    setDraft(currentDisplay);
    setEditing({ kind: "new", tempId, col });
  }

  type NavTarget =
    | { kind: "edit"; pkKey: string; col: string; display: string }
    | { kind: "new"; tempId: string; col: string; display: string };

  /** Find the next editable cell from (fromKind, fromIdx, colName) walking by
   * (dr, dc). Skips read-only cells (PKs on existing rows) and rows without a
   * PK. Returns null when the edge is reached. */
  function getNavTarget(
    fromKind: "existing" | "new",
    fromIdx: number,
    colName: string,
    dr: number,
    dc: number,
  ): NavTarget | null {
    if (!result) return null;
    const colIdx = result.columns.findIndex((c) => c.name === colName);
    if (colIdx === -1) return null;

    const existingCount = result.rows.length;
    const newCount = newRows?.length ?? 0;
    const totalRows = existingCount + newCount;

    let curGlobal =
      fromKind === "existing" ? fromIdx : existingCount + fromIdx;
    let curCol = colIdx;

    while (true) {
      curGlobal += dr;
      curCol += dc;
      if (curGlobal < 0 || curGlobal >= totalRows) return null;
      if (curCol < 0 || curCol >= result.columns.length) return null;

      const targetColName = result.columns[curCol]!.name;
      const colInfo = columnsInfo.get(targetColName);

      if (curGlobal < existingCount) {
        const targetRow = result.rows[curGlobal]!;
        const pkKey = rowPkKey(targetRow, colNameToIdx, pkColumns);
        if (!pkKey || isReadOnly(colInfo)) continue;
        const editedVal = edits.get(pkKey)?.changes?.[targetColName];
        const original = cellToString(
          targetRow[colNameToIdx.get(targetColName) ?? -1],
        );
        return {
          kind: "edit",
          pkKey,
          col: targetColName,
          display: editedVal ?? original,
        };
      } else {
        const nrIdx = curGlobal - existingCount;
        const nr = newRows![nrIdx]!;
        const cellVal = nr.values[targetColName];
        return {
          kind: "new",
          tempId: nr.tempId,
          col: targetColName,
          display: cellVal ?? "",
        };
      }
    }
  }

  /** Map a Ctrl+Arrow keydown to a (dr, dc) direction; null otherwise. */
  function ctrlArrowDir(
    e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
  ): { dr: number; dc: number } | null {
    if (!e.ctrlKey && !e.metaKey) return null;
    switch (e.key) {
      case "ArrowRight":
        return { dr: 0, dc: 1 };
      case "ArrowLeft":
        return { dr: 0, dc: -1 };
      case "ArrowDown":
        return { dr: 1, dc: 0 };
      case "ArrowUp":
        return { dr: -1, dc: 0 };
      default:
        return null;
    }
  }

  function jumpToTarget(target: NavTarget | null) {
    if (target?.kind === "edit") {
      startEdit(target.pkKey, target.col, target.display);
    } else if (target?.kind === "new") {
      startEditNew(target.tempId, target.col, target.display);
    } else {
      setEditing(null);
    }
  }

  function onKeyDownExisting(
    e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    pkKey: string,
    col: string,
    original: string,
    rowIdx: number,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitExisting(pkKey, col, original, draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      // Commit on Tab so users can move to next cell quickly. We don't
      // jump focus to neighbour cells (skip for now) but at least the value
      // is preserved.
      commitExisting(pkKey, col, original, draft);
    } else {
      const dir = ctrlArrowDir(e);
      if (dir) {
        e.preventDefault();
        const target = getNavTarget("existing", rowIdx, col, dir.dr, dir.dc);
        // Commit the current cell into the edits buffer without leaving edit
        // mode — jumpToTarget will set the next editing cell (or clear it).
        if (draft === original) {
          onChangeCell(pkKey, col, null);
        } else {
          onChangeCell(pkKey, col, draft);
        }
        jumpToTarget(target);
      }
    }
  }

  function onKeyDownNew(
    e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    tempId: string,
    col: string,
    nrIdx: number,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitNew(tempId, col, draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      commitNew(tempId, col, draft);
    } else {
      const dir = ctrlArrowDir(e);
      if (dir) {
        e.preventDefault();
        const target = getNavTarget("new", nrIdx, col, dir.dr, dir.dc);
        onChangeNewRowCell?.(tempId, col, draft);
        jumpToTarget(target);
      }
    }
  }

  /** Parse a clipboard string into a row × col matrix. Returns null if the
   * paste is a single cell — caller should let the default paste happen. */
  function parsePasteMatrix(text: string): string[][] | null {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let lines = normalized.split("\n");
    // Strip a single trailing empty line (common when copying from Excel/Sheets).
    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    const matrix = lines.map((l) => l.split("\t"));
    if (matrix.length <= 1 && (matrix[0]?.length ?? 0) <= 1) return null;
    return matrix;
  }

  function onPasteNewCell(
    e: ClipboardEvent<HTMLInputElement | HTMLSelectElement>,
    tempId: string,
    col: string,
  ) {
    if (!onPasteMatrix) return;
    const text = e.clipboardData.getData("text");
    const matrix = parsePasteMatrix(text);
    if (!matrix) return; // single cell — let default paste fill the input
    e.preventDefault();
    setEditing(null);
    onPasteMatrix(tempId, col, matrix);
  }

  const showRowNumberCol = pkColumns.length > 0 || (newRows && newRows.length > 0);

  return (
    <table className="dv-table" role="grid">
      <thead>
        <tr>
          {showRowNumberCol && <th style={{ width: 40 }}>#</th>}
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
              {showRowNumberCol && (
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
                  editing?.kind === "edit" &&
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
                        (e) =>
                          onKeyDownExisting(e, pkKey, c.name, original, rowIdx),
                        () => commitExisting(pkKey, c.name, original, draft),
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
        {newRows?.map((nr, nrIdx) => {
          const nrError = newRowErrors?.get(nr.tempId);
          return (
            <tr key={`new:${nr.tempId}`} className="is-new-row">
              {showRowNumberCol && (
                <td
                  className="is-pk is-new-row-marker"
                  style={{ textAlign: "right" }}
                  title="Fila nueva"
                >
                  <button
                    type="button"
                    className="dv-new-row-remove"
                    onClick={() => onRemoveNewRow?.(nr.tempId)}
                    aria-label="Eliminar fila nueva"
                    title="Eliminar fila"
                  >
                    ×
                  </button>
                </td>
              )}
              {result.columns.map((c) => {
                const colInfo = columnsInfo.get(c.name);
                const cellVal = nr.values[c.name];
                const touched = cellVal !== undefined;
                const display = cellVal ?? "";
                const isEditing =
                  editing?.kind === "new" &&
                  editing.tempId === nr.tempId &&
                  editing.col === c.name;
                const placeholderText = colInfo?.default
                  ? `(default: ${colInfo.default})`
                  : colInfo?.nullable
                  ? "NULL"
                  : "—";
                return (
                  <td
                    key={c.name}
                    className={clsx(
                      "is-new-cell",
                      !isEditing && "is-editable",
                      isEditing && "is-editing",
                      touched && "is-new-touched",
                      nrError && "is-row-error",
                      colInfo?.isPrimaryKey && "is-pk",
                    )}
                    onDoubleClick={() =>
                      startEditNew(nr.tempId, c.name, display)
                    }
                    title={`${c.name}${colInfo ? ` · ${colInfo.dataType}` : ""}${
                      colInfo?.nullable ? "" : " · NOT NULL"
                    }`}
                  >
                    {isEditing ? (
                      renderEditor(
                        c.name,
                        colInfo,
                        draft,
                        setDraft,
                        (e) => onKeyDownNew(e, nr.tempId, c.name, nrIdx),
                        () => commitNew(nr.tempId, c.name, draft),
                        inputRef,
                        (e) => onPasteNewCell(e, nr.tempId, c.name),
                      )
                    ) : (
                      <span
                        style={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontStyle: !touched ? "italic" : "normal",
                          color: !touched
                            ? "var(--dv-text-mute)"
                            : undefined,
                        }}
                      >
                        {!touched
                          ? placeholderText
                          : display === ""
                          ? "NULL"
                          : display}
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
  onPaste?: (e: ClipboardEvent<HTMLInputElement | HTMLSelectElement>) => void,
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
      onPaste={onPaste}
      onBlur={onCommit}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      aria-label={`Editar ${colName}`}
    />
  );
}
