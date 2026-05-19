"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import clsx from "clsx";
import type {
  CellValue,
  ColumnInfo,
  DatabaseDriver,
  ExportFormat,
  ExportTableResult,
  QueryResult,
  TableDetails,
} from "@data-view/core";
import { useTransport } from "../transport-context";
import {
  EditableDataGrid,
  cellToString,
  parseEnumValues,
  rowPkKey,
  type NewRow,
  type RowEdit,
  type SortState,
} from "./EditableDataGrid";
import { StructureEditor } from "./StructureEditor";
import { ExportMenu } from "./ExportMenu";

interface Props {
  connectionId: string;
  driver: DatabaseDriver | null;
  schema: string;
  name: string;
  onOpenInSqlEditor: (sql: string) => void;
}

type Tab = "data" | "structure" | "indexes";

const TABS: { key: Tab; label: string }[] = [
  { key: "data", label: "Data" },
  { key: "structure", label: "Structure" },
  { key: "indexes", label: "Indexes" },
];

const PAGE_SIZE = 100;
const SCROLL_THRESHOLD_PX = 400;

function quoteIdent(driver: DatabaseDriver | null, s: string): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
        ? s
        : `"${s.replace(/"/g, '""')}"`;
  }
}

const NUMERIC_TYPE_RE =
  /^(int|bigint|smallint|tinyint|mediumint|integer|number|numeric|decimal|float|double|real|money|smallmoney)/i;

function isNumericType(dt: string | undefined): boolean {
  return !!dt && NUMERIC_TYPE_RE.test(dt);
}

function isBoolType(dt: string | undefined): boolean {
  return !!dt && /^(bool|boolean|bit\(1\)|tinyint\(1\))/i.test(dt);
}

/** Format a literal value for inclusion in a generated UPDATE statement. */
function quoteValue(
  driver: DatabaseDriver | null,
  col: ColumnInfo | undefined,
  raw: string,
): string {
  // Empty string means NULL (only meaningful for nullable columns; if not
  // nullable the DB will reject it which surfaces as a per-row error).
  if (raw === "") return "NULL";

  if (isBoolType(col?.dataType)) {
    const truthy = raw.toLowerCase() === "true" || raw === "1";
    if (driver === "mysql") return truthy ? "1" : "0";
    return truthy ? "TRUE" : "FALSE";
  }

  // ENUMs are quoted strings even though the dataType starts with "enum(".
  if (parseEnumValues(col?.dataType)) {
    return "'" + raw.replace(/'/g, "''") + "'";
  }

  if (isNumericType(col?.dataType)) {
    // Pass numeric literals raw — invalid input will surface as a server error.
    return raw.trim();
  }

  // Default: string literal with single-quote escaping.
  return "'" + raw.replace(/'/g, "''") + "'";
}

function buildUpdateSql(
  driver: DatabaseDriver | null,
  schema: string,
  name: string,
  pkColumns: string[],
  pkValuesByCol: Record<string, string>,
  pkColInfo: Map<string, ColumnInfo>,
  changes: Record<string, string>,
  columnsInfo: Map<string, ColumnInfo>,
): string {
  const setClauses = Object.entries(changes)
    .map(
      ([col, val]) =>
        `${quoteIdent(driver, col)} = ${quoteValue(driver, columnsInfo.get(col), val)}`,
    )
    .join(", ");
  const whereClauses = pkColumns
    .map(
      (pk) =>
        `${quoteIdent(driver, pk)} = ${quoteValue(
          driver,
          pkColInfo.get(pk),
          pkValuesByCol[pk] ?? "",
        )}`,
    )
    .join(" AND ");
  return `UPDATE ${quoteIdent(driver, schema)}.${quoteIdent(
    driver,
    name,
  )} SET ${setClauses} WHERE ${whereClauses}`;
}

function buildInsertSql(
  driver: DatabaseDriver | null,
  schema: string,
  name: string,
  values: Record<string, string>,
  columnsInfo: Map<string, ColumnInfo>,
): string {
  const cols = Object.keys(values);
  const colList = cols.map((c) => quoteIdent(driver, c)).join(", ");
  const valList = cols
    .map((c) => quoteValue(driver, columnsInfo.get(c), values[c] ?? ""))
    .join(", ");
  return `INSERT INTO ${quoteIdent(driver, schema)}.${quoteIdent(
    driver,
    name,
  )} (${colList}) VALUES (${valList})`;
}

function makeTempId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function TablePane({
  connectionId,
  driver,
  schema,
  name,
  onOpenInSqlEditor,
}: Props) {
  const transport = useTransport();
  const [tab, setTab] = useState<Tab>("data");
  const [data, setData] = useState<QueryResult | null>(null);
  const [details, setDetails] = useState<TableDetails | null>(null);
  const [detailsNonce, setDetailsNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every reset (sort/filter change, table change). Inflight requests
  // compare against this to decide whether their result is still relevant.
  const requestIdRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // WHERE-style filter (DBeaver style — just the part after WHERE).
  const [whereInput, setWhereInput] = useState("");
  const [appliedWhere, setAppliedWhere] = useState("");

  // Sort state (server-side via fetchTableData orderBy).
  const [sort, setSort] = useState<SortState>(null);

  // Dirty edits buffer: pkKey → { changes: { colName: newValueAsString } }.
  // Survives sort/refetch because keyed by PK values, not row index.
  const [edits, setEdits] = useState<Map<string, RowEdit>>(new Map());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  // Rows staged for INSERT. Identified by tempId so the buffer survives sort /
  // refetch (which only updates `data`).
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [newRowErrors, setNewRowErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirtyCount = useMemo(() => {
    let n = 0;
    edits.forEach((e) => {
      n += Object.keys(e.changes).length;
    });
    return n;
  }, [edits]);

  // Only rows with at least one user-supplied value count toward the save bar.
  const populatedNewRows = useMemo(
    () => newRows.filter((r) => Object.keys(r.values).length > 0),
    [newRows],
  );

  // Build a map name → ColumnInfo from describeTable for the grid.
  const columnsInfo = useMemo(() => {
    const map = new Map<string, ColumnInfo>();
    details?.columns.forEach((c) => map.set(c.name, c));
    return map;
  }, [details]);

  const pkColumns = useMemo(
    () =>
      details?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [],
    [details],
  );

  const colNameToIdx = useMemo(() => {
    const map = new Map<string, number>();
    data?.columns.forEach((c, i) => map.set(c.name, i));
    return map;
  }, [data]);

  const loadData = useCallback(
    (where: string, sortState: SortState) => {
      const reqId = ++requestIdRef.current;
      setLoading(true);
      setLoadingMore(false);
      setHasMore(false);
      setError(null);
      transport
        .fetchTableData(connectionId, schema, name, {
          limit: PAGE_SIZE,
          offset: 0,
          where: where.trim() || undefined,
          orderBy: sortState ? [sortState] : undefined,
        })
        .then((r) => {
          if (reqId !== requestIdRef.current) return;
          setData(r);
          setHasMore(r.rows.length >= PAGE_SIZE);
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
          }
        })
        .catch((e) => {
          if (reqId !== requestIdRef.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
          setHasMore(false);
        })
        .finally(() => {
          if (reqId !== requestIdRef.current) return;
          setLoading(false);
        });
    },
    [connectionId, schema, name, transport],
  );

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore || !data) return;
    // Capture the current request id — if loadData is called before this
    // resolves (sort/filter change), the appended rows would belong to a
    // different ordering, so discard them.
    const reqId = requestIdRef.current;
    const currentOffset = data.rows.length;
    setLoadingMore(true);
    transport
      .fetchTableData(connectionId, schema, name, {
        limit: PAGE_SIZE,
        offset: currentOffset,
        where: appliedWhere.trim() || undefined,
        orderBy: sort ? [sort] : undefined,
      })
      .then((r) => {
        if (reqId !== requestIdRef.current) return;
        setData((prev) => {
          if (!prev) return r;
          const mergedRows = [...prev.rows, ...r.rows];
          return {
            ...prev,
            rows: mergedRows,
            rowCount: mergedRows.length,
            durationMs: r.durationMs,
          };
        });
        setHasMore(r.rows.length >= PAGE_SIZE);
      })
      .catch((e) => {
        if (reqId !== requestIdRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setHasMore(false);
      })
      .finally(() => {
        if (reqId !== requestIdRef.current) return;
        setLoadingMore(false);
      });
  }, [
    loading,
    loadingMore,
    hasMore,
    data,
    transport,
    connectionId,
    schema,
    name,
    appliedWhere,
    sort,
  ]);

  const onGridScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (
        el.scrollHeight - el.scrollTop - el.clientHeight <
        SCROLL_THRESHOLD_PX
      ) {
        loadMore();
      }
    },
    [loadMore],
  );

  // Reset everything on table change.
  useEffect(() => {
    requestIdRef.current++;
    setTab("data");
    setData(null);
    setDetails(null);
    setError(null);
    setWhereInput("");
    setAppliedWhere("");
    setSort(null);
    setEdits(new Map());
    setRowErrors(new Map());
    setNewRows([]);
    setNewRowErrors(new Map());
    setSaveError(null);
    setHasMore(false);
    setLoadingMore(false);
  }, [connectionId, schema, name]);

  // describeTable runs eagerly when the data tab is open so we know PKs +
  // column types for editing. It also populates the Structure/Indexes tabs.
  // detailsNonce lets the Structure editor force a refetch after applying
  // ALTER TABLE statements.
  useEffect(() => {
    let cancel = false;
    transport
      .describeTable(connectionId, schema, name)
      .then((d) => !cancel && setDetails(d))
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancel = true;
    };
  }, [connectionId, schema, name, transport, detailsNonce]);

  function refreshDetails() {
    setDetails(null);
    setDetailsNonce((n) => n + 1);
  }

  // Initial + subsequent loads when applied WHERE or sort changes.
  useEffect(() => {
    if (tab !== "data") return;
    loadData(appliedWhere, sort);
  }, [tab, appliedWhere, sort, loadData]);

  // If the loaded page doesn't fill the visible area (tall window / few rows),
  // pull the next page so infinite scroll has something to reveal. Skips when
  // a load is already in flight.
  useEffect(() => {
    if (tab !== "data") return;
    if (loading || loadingMore || !hasMore) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 8) {
      loadMore();
    }
  }, [tab, data, hasMore, loading, loadingMore, loadMore]);

  function applyWhere() {
    setAppliedWhere(whereInput);
  }

  function clearWhere() {
    setWhereInput("");
    setAppliedWhere("");
  }

  function onWhereKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      applyWhere();
    }
    if (e.key === "Escape" && whereInput) {
      e.preventDefault();
      clearWhere();
    }
  }

  function onToggleSort(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  }

  function onChangeCell(pkKey: string, colName: string, value: string | null) {
    setEdits((prev) => {
      const next = new Map(prev);
      const existing = next.get(pkKey)?.changes ?? {};
      const updated = { ...existing };
      if (value === null) {
        delete updated[colName];
      } else {
        updated[colName] = value;
      }
      if (Object.keys(updated).length === 0) {
        next.delete(pkKey);
      } else {
        next.set(pkKey, { changes: updated });
      }
      return next;
    });
  }

  function discardAll() {
    setEdits(new Map());
    setRowErrors(new Map());
    setNewRows([]);
    setNewRowErrors(new Map());
    setSaveError(null);
  }

  function addNewRow() {
    setNewRows((prev) => [...prev, { tempId: makeTempId(), values: {} }]);
  }

  function onChangeNewRowCell(tempId: string, col: string, value: string) {
    setNewRows((prev) =>
      prev.map((r) =>
        r.tempId === tempId
          ? { ...r, values: { ...r.values, [col]: value } }
          : r,
      ),
    );
  }

  function onRemoveNewRow(tempId: string) {
    setNewRows((prev) => prev.filter((r) => r.tempId !== tempId));
    setNewRowErrors((prev) => {
      if (!prev.has(tempId)) return prev;
      const next = new Map(prev);
      next.delete(tempId);
      return next;
    });
  }

  /** Distribute a tab/newline-delimited matrix starting at (tempId, startCol),
   * appending new staged rows when the matrix is taller than what's currently
   * staged below the starting row. Extra columns past the table are ignored. */
  function onPasteMatrix(
    startTempId: string,
    startCol: string,
    matrix: string[][],
  ) {
    const cols = data?.columns.map((c) => c.name) ?? [];
    const startColIdx = cols.indexOf(startCol);
    if (startColIdx < 0) return;

    setNewRows((prev) => {
      const next = [...prev];
      const startRowIdx = next.findIndex((r) => r.tempId === startTempId);
      if (startRowIdx < 0) return prev;

      matrix.forEach((rowValues, i) => {
        const rowIdx = startRowIdx + i;
        while (rowIdx >= next.length) {
          next.push({ tempId: makeTempId(), values: {} });
        }
        const target = next[rowIdx];
        if (!target) return;
        const newValues = { ...target.values };
        rowValues.forEach((v, j) => {
          const colName = cols[startColIdx + j];
          if (colName == null) return;
          newValues[colName] = v;
        });
        next[rowIdx] = { ...target, values: newValues };
      });
      return next;
    });
  }

  // We need the original PK values for each dirty pkKey to build the WHERE.
  // Capture them from the currently-loaded rows.
  function pkValuesForKey(pkKey: string): Record<string, string> | null {
    if (!data) return null;
    for (const row of data.rows) {
      const k = rowPkKey(row, colNameToIdx, pkColumns);
      if (k === pkKey) {
        const out: Record<string, string> = {};
        for (const pk of pkColumns) {
          const idx = colNameToIdx.get(pk);
          if (idx == null) return null;
          out[pk] = cellToString(row[idx]);
        }
        return out;
      }
    }
    return null;
  }

  const saveAll = useCallback(async () => {
    if (saving) return;
    if (edits.size === 0 && populatedNewRows.length === 0) return;
    setSaving(true);
    setSaveError(null);

    const remaining = new Map(edits);
    const errs = new Map(rowErrors);

    for (const [pkKey, edit] of edits) {
      const pkValues = pkValuesForKey(pkKey);
      if (!pkValues) {
        errs.set(pkKey, "No se encontró la fila original");
        continue;
      }
      const sql = buildUpdateSql(
        driver,
        schema,
        name,
        pkColumns,
        pkValues,
        columnsInfo,
        edit.changes,
        columnsInfo,
      );
      try {
        await transport.runQuery(connectionId, sql);
        remaining.delete(pkKey);
        errs.delete(pkKey);
      } catch (e) {
        errs.set(pkKey, e instanceof Error ? e.message : String(e));
      }
    }

    const remainingNew: NewRow[] = [];
    const newErrs = new Map<string, string>();
    // Preserve rows that were created but never filled — the user might still
    // be typing into them; we don't want to silently drop their work.
    for (const nr of newRows) {
      if (Object.keys(nr.values).length === 0) {
        remainingNew.push(nr);
        continue;
      }
      const sql = buildInsertSql(driver, schema, name, nr.values, columnsInfo);
      try {
        await transport.runQuery(connectionId, sql);
        // Drop the row from the staged buffer — the refetch below will surface
        // the persisted version with server-assigned defaults / auto-increment.
      } catch (e) {
        remainingNew.push(nr);
        newErrs.set(nr.tempId, e instanceof Error ? e.message : String(e));
      }
    }

    setEdits(remaining);
    setRowErrors(errs);
    setNewRows(remainingNew);
    setNewRowErrors(newErrs);
    setSaving(false);

    const totalErrs = errs.size + newErrs.size;
    if (totalErrs > 0) {
      setSaveError(
        `${totalErrs} fila${totalErrs === 1 ? "" : "s"} con error — revisá las celdas resaltadas`,
      );
    } else {
      setSaveError(null);
      // refetch to surface server-side normalization (default values, triggers)
      loadData(appliedWhere, sort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    saving,
    edits,
    rowErrors,
    newRows,
    populatedNewRows.length,
    driver,
    schema,
    name,
    pkColumns,
    columnsInfo,
    connectionId,
    transport,
    appliedWhere,
    sort,
    loadData,
  ]);

  // Ctrl+S / ⌘S to save while the data tab is open.
  const saveAllRef = useRef(saveAll);
  saveAllRef.current = saveAll;
  useEffect(() => {
    if (tab !== "data") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (edits.size === 0 && populatedNewRows.length === 0) return;
        e.preventDefault();
        void saveAllRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, edits.size, populatedNewRows.length]);

  const sqlForTable = `SELECT * FROM ${quoteIdent(driver, schema)}.${quoteIdent(
    driver,
    name,
  )}${appliedWhere.trim() ? `\nWHERE ${appliedWhere.trim()}` : ""}${
    sort
      ? `\nORDER BY ${quoteIdent(driver, sort.column)} ${sort.direction.toUpperCase()}`
      : ""
  }\nLIMIT 100;`;

  const [exportStatus, setExportStatus] = useState<
    | { kind: "running"; format: ExportFormat }
    | { kind: "done"; result: ExportTableResult }
    | { kind: "error"; message: string }
    | null
  >(null);

  const onExportFullTable = useCallback(
    async (format: ExportFormat) => {
      setExportStatus({ kind: "running", format });
      try {
        const result = await transport.exportTable(connectionId, schema, name, {
          format,
          where: appliedWhere.trim() || undefined,
          includeHeader: true,
          batchSize: 100,
        });
        setExportStatus({ kind: "done", result });
      } catch (e) {
        setExportStatus({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [transport, connectionId, schema, name, appliedWhere],
  );

  // Auto-dismiss the success badge after a few seconds.
  useEffect(() => {
    if (exportStatus?.kind !== "done") return;
    const t = setTimeout(() => setExportStatus(null), 8000);
    return () => clearTimeout(t);
  }, [exportStatus]);

  const colCount = details?.columns.length;
  const filterDirty = whereInput.trim() !== appliedWhere.trim();

  return (
    <div className={clsx("dv-page", tab === "data" && "is-fill")}>
      <div className="dv-page-eyebrow">
        <span>Tablas</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>{schema}</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text)" }}>{name}</span>
      </div>
      <div className="dv-page-header">
        <h1 className="dv-page-title">{name}</h1>
        <div className="dv-page-subtitle">
          {data
            ? `${data.rows.length} filas${hasMore ? "+" : ""} cargadas`
            : "—"}
          {colCount != null && ` · ${colCount} columnas`}
          {appliedWhere.trim() && (
            <>
              {" · "}
              <span className="dv-tag is-info" style={{ marginLeft: 4 }}>
                filtro activo
              </span>
            </>
          )}
        </div>
        <div className="dv-page-actions">
          <ExportMenu
            result={data}
            baseName={name}
            driver={driver}
            schema={schema}
            table={name}
            onExportFullTable={onExportFullTable}
          />
          <button
            className="dv-button"
            onClick={() => onOpenInSqlEditor(sqlForTable)}
          >
            Abrir en SQL editor
          </button>
        </div>
      </div>

      {exportStatus && (
        <div
          className={clsx(
            "dv-export-status",
            exportStatus.kind === "error" && "is-error",
            exportStatus.kind === "running" && "is-busy",
          )}
        >
          {exportStatus.kind === "running" && (
            <>
              Exportando tabla a <code>{exportStatus.format}</code>… (puede tardar
              varios segundos)
            </>
          )}
          {exportStatus.kind === "done" && (
            <>
              ✓ {exportStatus.result.rowCount.toLocaleString()} filas exportadas ·{" "}
              {(exportStatus.result.bytes / 1024).toFixed(1)} KB ·{" "}
              {exportStatus.result.durationMs}ms
              {exportStatus.result.filePath && (
                <>
                  {" "}— <code>{exportStatus.result.filePath}</code>
                </>
              )}
              <button
                type="button"
                className="dv-export-status-close"
                onClick={() => setExportStatus(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </>
          )}
          {exportStatus.kind === "error" && (
            <>
              Error exportando: {exportStatus.message}
              <button
                type="button"
                className="dv-export-status-close"
                onClick={() => setExportStatus(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </>
          )}
        </div>
      )}

      <div className="dv-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={clsx("dv-tab", tab === t.key && "is-active")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "data" && (
        <div className="dv-data-tab">
          <div className="dv-table-toolbar">
            <div
              className={clsx(
                "dv-where-filter",
                error && appliedWhere.trim() && "is-error",
              )}
            >
              <span className="dv-where-prefix">WHERE</span>
              <input
                type="text"
                className="dv-where-input"
                value={whereInput}
                onChange={(e) => setWhereInput(e.target.value)}
                onKeyDown={onWhereKey}
                placeholder="id = 10 AND status = 'active'"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
              />
              {(whereInput || appliedWhere) && (
                <button
                  type="button"
                  className="dv-where-clear"
                  onClick={clearWhere}
                  title="Limpiar filtro (Esc)"
                  aria-label="Limpiar filtro"
                >
                  ×
                </button>
              )}
              <button
                type="button"
                className="dv-where-apply"
                onClick={applyWhere}
                disabled={!filterDirty || loading}
                title="Aplicar filtro (Enter)"
              >
                {loading && filterDirty ? "…" : "Aplicar"}
                {filterDirty && (
                  <span className="dv-kbd" style={{ marginLeft: 2 }}>↵</span>
                )}
              </button>
            </div>
            <button
              type="button"
              className="dv-button is-sm"
              onClick={addNewRow}
              disabled={!details}
              title={
                details
                  ? "Agregar una fila en blanco al final"
                  : "Esperando metadata de la tabla…"
              }
            >
              + Agregar fila
            </button>
            <span className="dv-table-toolbar-meta">
              {data
                ? `${data.rows.length} filas${hasMore ? "+" : ""} · ${data.durationMs}ms`
                : loading
                ? "cargando…"
                : ""}
            </span>
          </div>

          <div className="dv-where-hint">
            Escribí solo la expresión SQL después de <code>WHERE</code>. Doble
            click en una celda para editar · <code>Ctrl+S</code> para guardar
            cambios · "+ Agregar fila" para insertar nuevas (podés pegar varias
            filas separadas por tabs / saltos de línea).
          </div>

          {error && <div className="dv-error">{error}</div>}

          {pkColumns.length === 0 && details && (
            <div className="dv-readonly-banner">
              ▦ Esta tabla no tiene primary key — la edición está deshabilitada.
            </div>
          )}

          {(edits.size > 0 || populatedNewRows.length > 0) && (
            <div className="dv-save-bar">
              <span style={{ fontWeight: 500 }}>
                {edits.size > 0 && (
                  <>
                    {dirtyCount} celda{dirtyCount === 1 ? "" : "s"} modificada
                    {dirtyCount === 1 ? "" : "s"} en {edits.size} fila
                    {edits.size === 1 ? "" : "s"}
                  </>
                )}
                {edits.size > 0 && populatedNewRows.length > 0 && " · "}
                {populatedNewRows.length > 0 && (
                  <>
                    {populatedNewRows.length} fila
                    {populatedNewRows.length === 1 ? "" : "s"} nueva
                    {populatedNewRows.length === 1 ? "" : "s"}
                  </>
                )}
              </span>
              <span style={{ fontSize: 12 }}>
                <span className="dv-kbd">⌘S</span> /{" "}
                <span className="dv-kbd">Ctrl+S</span> para guardar
              </span>
              <div className="dv-save-bar-actions">
                <button
                  className="dv-button"
                  onClick={discardAll}
                  disabled={saving}
                >
                  Descartar
                </button>
                <button
                  className="dv-button is-primary"
                  onClick={() => void saveAll()}
                  disabled={saving}
                >
                  {saving ? "Guardando…" : "Guardar cambios"}
                </button>
              </div>
            </div>
          )}

          {saveError && <div className="dv-save-bar-error">{saveError}</div>}

          <div className="dv-card dv-data-grid-card">
            <div
              className="dv-card-body is-tight dv-data-grid-scroll"
              ref={scrollContainerRef}
              onScroll={onGridScroll}
            >
              <EditableDataGrid
                result={data}
                columnsInfo={columnsInfo}
                pkColumns={pkColumns}
                edits={edits}
                rowErrors={rowErrors}
                sort={sort}
                loading={loading}
                onToggleSort={onToggleSort}
                onChangeCell={onChangeCell}
                newRows={newRows}
                newRowErrors={newRowErrors}
                onChangeNewRowCell={onChangeNewRowCell}
                onRemoveNewRow={onRemoveNewRow}
                onPasteMatrix={onPasteMatrix}
              />
              {data && data.rows.length > 0 && loadingMore && (
                <div className="dv-load-indicator">Cargando más…</div>
              )}
              {data && data.rows.length > 0 && !hasMore && !loadingMore && (
                <div className="dv-load-indicator is-end">
                  Fin de los resultados ({data.rows.length} filas)
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab !== "data" && error && <div className="dv-error">{error}</div>}

      {tab === "structure" && (
        <StructureEditor
          connectionId={connectionId}
          driver={driver}
          schema={schema}
          name={name}
          details={details}
          loading={!details && !error}
          onAfterSave={refreshDetails}
          onOpenInSqlEditor={onOpenInSqlEditor}
        />
      )}

      {tab === "indexes" && (
        <IndexesTab details={details} loading={loading && !details} />
      )}
    </div>
  );
}

function IndexesTab({
  details,
  loading,
}: {
  details: TableDetails | null;
  loading: boolean;
}) {
  if (loading && !details) return <div className="dv-empty" style={{ marginTop: 20 }}>Cargando índices…</div>;
  if (!details) return null;
  if (details.indexes.length === 0) {
    return <div className="dv-empty" style={{ marginTop: 20 }}>Sin índices.</div>;
  }
  return (
    <div className="dv-card" style={{ marginTop: 16, overflow: "hidden" }}>
      <div className="dv-card-body is-tight">
        <table className="dv-deflist">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Columnas</th>
              <th>Tipo</th>
            </tr>
          </thead>
          <tbody>
            {details.indexes.map((idx) => (
              <tr key={idx.name}>
                <td style={{ fontWeight: 500 }}>{idx.name}</td>
                <td className="is-mono is-dim">{idx.columns.join(", ")}</td>
                <td>
                  {idx.primary ? (
                    <span className="dv-tag is-accent">PRIMARY</span>
                  ) : idx.unique ? (
                    <span className="dv-tag is-info">UNIQUE</span>
                  ) : (
                    <span className="dv-tag">INDEX</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

