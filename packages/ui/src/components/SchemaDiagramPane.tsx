"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  ColumnInfo,
  ConnectionConfig,
  ForeignKeyInfo,
  RelationInfo,
  TableDetails,
} from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  connection: ConnectionConfig;
  activeSchema: string | null;
  onOpenTable: (schema: string, name: string) => void;
}

interface NodeData {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  inboundCount: number;
}

interface NodePosition {
  x: number;
  y: number;
}

interface EdgeData {
  id: string;
  fromKey: string;
  toKey: string;
  fromColumns: string[];
  toColumns: string[];
  label: string;
}

const NODE_WIDTH = 240;
const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 22;
const COLUMN_GAP = 90;
const ROW_GAP = 36;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const FETCH_CONCURRENCY = 8;

function nodeKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function nodeHeight(node: NodeData): number {
  const visible = Math.min(node.columns.length, 18);
  return HEADER_HEIGHT + visible * ROW_HEIGHT + 8;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Assign a column index per node by longest-FK-chain depth. Tables that
 * reference others sit to the right of what they reference, so arrows
 * flow left → right whenever possible. Cycles fall back to depth 0. */
function computeLayers(
  nodes: NodeData[],
  schema: string,
): Map<string, number> {
  const byKey = new Map<string, NodeData>();
  for (const n of nodes) byKey.set(nodeKey(n.schema, n.name), n);

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(key: string): number {
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const node = byKey.get(key);
    let d = 0;
    if (node) {
      for (const fk of node.foreignKeys) {
        // Only follow FKs that point inside this schema and to a known node.
        if (fk.referencedSchema && fk.referencedSchema !== schema) continue;
        const refKey = nodeKey(
          fk.referencedSchema || schema,
          fk.referencedTable,
        );
        if (!byKey.has(refKey) || refKey === key) continue;
        d = Math.max(d, depth(refKey) + 1);
      }
    }
    visiting.delete(key);
    memo.set(key, d);
    return d;
  }

  for (const n of nodes) depth(nodeKey(n.schema, n.name));
  return memo;
}

function autoLayout(
  nodes: NodeData[],
  schema: string,
): Map<string, NodePosition> {
  const layers = computeLayers(nodes, schema);
  const byLayer = new Map<number, NodeData[]>();
  for (const n of nodes) {
    const l = layers.get(nodeKey(n.schema, n.name)) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n);
  }
  // Within a layer, more-referenced tables float to the top.
  for (const list of byLayer.values()) {
    list.sort(
      (a, b) =>
        b.inboundCount - a.inboundCount || a.name.localeCompare(b.name),
    );
  }

  const pos = new Map<string, NodePosition>();
  const layerIdx = [...byLayer.keys()].sort((a, b) => a - b);
  let x = 0;
  for (const l of layerIdx) {
    const list = byLayer.get(l)!;
    let y = 0;
    for (const n of list) {
      pos.set(nodeKey(n.schema, n.name), { x, y });
      y += nodeHeight(n) + ROW_GAP;
    }
    x += NODE_WIDTH + COLUMN_GAP;
  }
  return pos;
}

interface PortMeta {
  /** y-offset (within node) of a column row's vertical center. */
  yByColumn: Map<string, number>;
}

function buildPorts(node: NodeData): PortMeta {
  const yByColumn = new Map<string, number>();
  node.columns.forEach((col, i) => {
    yByColumn.set(col.name, HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2);
  });
  return { yByColumn };
}

export function SchemaDiagramPane({
  connection,
  activeSchema,
  onOpenTable,
}: Props) {
  const transport = useTransport();
  const [relations, setRelations] = useState<RelationInfo[]>([]);
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [positions, setPositions] = useState<Map<string, NodePosition>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [zoom, setZoom] = useState(1);
  const [highlight, setHighlight] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { kind: "pan"; startX: number; startY: number; baseX: number; baseY: number }
    | { kind: "node"; key: string; offsetX: number; offsetY: number }
    | null
  >(null);

  // Reset diagram state when the source schema changes.
  useEffect(() => {
    setRelations([]);
    setNodes([]);
    setPositions(new Map());
    setError(null);
    setProgress({ done: 0, total: 0 });
    setHighlight(null);
    setPan({ x: 24, y: 24 });
    setZoom(1);
  }, [connection.id, activeSchema]);

  // Load relations + describeTable for each.
  useEffect(() => {
    if (!activeSchema) return;
    let cancel = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const rels = await transport.listRelations(connection.id, activeSchema);
        if (cancel) return;
        // Materialized views and views often don't carry FKs, but we still want
        // to render their column shape.
        setRelations(rels);
        setProgress({ done: 0, total: rels.length });

        const details = await mapWithConcurrency(
          rels,
          FETCH_CONCURRENCY,
          async (r) => {
            try {
              const d = await transport.describeTable(
                connection.id,
                r.schema,
                r.name,
              );
              if (!cancel) setProgress((p) => ({ ...p, done: p.done + 1 }));
              return d;
            } catch (e) {
              if (!cancel) setProgress((p) => ({ ...p, done: p.done + 1 }));
              // Fall back to an empty shell so the table still appears.
              return {
                schema: r.schema,
                name: r.name,
                kind: r.kind,
                columns: [],
                indexes: [],
                foreignKeys: [],
              } satisfies TableDetails;
            }
          },
        );
        if (cancel) return;

        const inbound = new Map<string, number>();
        for (const d of details) {
          for (const fk of d.foreignKeys) {
            const refKey = nodeKey(
              fk.referencedSchema || d.schema,
              fk.referencedTable,
            );
            inbound.set(refKey, (inbound.get(refKey) ?? 0) + 1);
          }
        }

        const built: NodeData[] = details.map((d) => ({
          schema: d.schema,
          name: d.name,
          columns: d.columns,
          foreignKeys: d.foreignKeys,
          inboundCount: inbound.get(nodeKey(d.schema, d.name)) ?? 0,
        }));

        setNodes(built);
        setPositions(autoLayout(built, activeSchema));
      } catch (e) {
        if (!cancel)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();

    return () => {
      cancel = true;
    };
  }, [connection.id, activeSchema, transport]);

  const ports = useMemo(() => {
    const m = new Map<string, PortMeta>();
    for (const n of nodes) m.set(nodeKey(n.schema, n.name), buildPorts(n));
    return m;
  }, [nodes]);

  const edges = useMemo<EdgeData[]>(() => {
    const list: EdgeData[] = [];
    for (const n of nodes) {
      const fromKey = nodeKey(n.schema, n.name);
      for (const fk of n.foreignKeys) {
        const refSchema = fk.referencedSchema || n.schema;
        const toKey = nodeKey(refSchema, fk.referencedTable);
        if (!positions.has(toKey)) continue;
        list.push({
          id: `${fromKey}::${fk.name}`,
          fromKey,
          toKey,
          fromColumns: fk.columns,
          toColumns: fk.referencedColumns,
          label: fk.name,
        });
      }
    }
    return list;
  }, [nodes, positions]);

  // ── Interactions ─────────────────────────────────────────────────────────
  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-node]")) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        baseX: pan.x,
        baseY: pan.y,
      };
    },
    [pan],
  );

  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent, key: string) => {
      if (e.button !== 0) return;
      // Don't start a drag if the user is clicking the title link.
      if ((e.target as HTMLElement).closest("[data-node-action]")) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = positions.get(key);
      if (!cur) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: "node",
        key,
        offsetX: e.clientX / zoom - cur.x,
        offsetY: e.clientY / zoom - cur.y,
      };
    },
    [positions, zoom],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        setPan({
          x: drag.baseX + (e.clientX - drag.startX),
          y: drag.baseY + (e.clientY - drag.startY),
        });
      } else {
        const x = e.clientX / zoom - drag.offsetX;
        const y = e.clientY / zoom - drag.offsetY;
        setPositions((prev) => {
          const next = new Map(prev);
          next.set(drag.key, { x, y });
          return next;
        });
      }
    },
    [zoom],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    if (dragRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      dragRef.current = null;
    }
  }, []);

  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      // Zoom around the cursor: keep the world point under the cursor fixed.
      const worldX = (px - pan.x) / zoom;
      const worldY = (py - pan.y) / zoom;
      setZoom(next);
      setPan({ x: px - worldX * next, y: py - worldY * next });
    },
    [pan, zoom],
  );

  function fitToView() {
    if (positions.size === 0) {
      setPan({ x: 24, y: 24 });
      setZoom(1);
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      const p = positions.get(nodeKey(n.schema, n.name));
      if (!p) continue;
      const h = nodeHeight(n);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_WIDTH);
      maxY = Math.max(maxY, p.y + h);
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 40;
    const sx = (rect.width - padding * 2) / (maxX - minX);
    const sy = (rect.height - padding * 2) / (maxY - minY);
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(sx, sy, 1)));
    setZoom(next);
    setPan({
      x: padding - minX * next,
      y: padding - minY * next,
    });
  }

  function relayout() {
    if (!activeSchema) return;
    setPositions(autoLayout(nodes, activeSchema));
    setHighlight(null);
  }

  // ── Render helpers ───────────────────────────────────────────────────────

  // SVG canvas extent: derive from current node positions so paths stay
  // visible when nodes are dragged outward.
  const canvasExtent = useMemo(() => {
    let maxX = 800,
      maxY = 600;
    for (const n of nodes) {
      const p = positions.get(nodeKey(n.schema, n.name));
      if (!p) continue;
      maxX = Math.max(maxX, p.x + NODE_WIDTH + 200);
      maxY = Math.max(maxY, p.y + nodeHeight(n) + 200);
    }
    return { width: maxX, height: maxY };
  }, [nodes, positions]);

  const highlightedKeys = useMemo(() => {
    if (!highlight) return null;
    const set = new Set<string>([highlight]);
    for (const e of edges) {
      if (e.fromKey === highlight) set.add(e.toKey);
      if (e.toKey === highlight) set.add(e.fromKey);
    }
    return set;
  }, [highlight, edges]);

  const highlightedEdges = useMemo(() => {
    if (!highlight) return null;
    return new Set(
      edges
        .filter((e) => e.fromKey === highlight || e.toKey === highlight)
        .map((e) => e.id),
    );
  }, [highlight, edges]);

  // Empty / loading states.
  if (!activeSchema) {
    return (
      <div className="dv-page">
        <div className="dv-page-eyebrow">Workspace · Schema</div>
        <h1 className="dv-page-title">Schema</h1>
        <p className="dv-page-subtitle" style={{ marginTop: 12 }}>
          Elegí un schema en el panel izquierdo para ver su diagrama ER.
        </p>
      </div>
    );
  }

  const tableCount = nodes.filter((n) =>
    relations.find((r) => r.schema === n.schema && r.name === n.name && r.kind === "table"),
  ).length;
  const fkCount = edges.length;

  const transformStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: "0 0",
  };

  return (
    <div className="dv-page is-fill">
      <div className="dv-page-eyebrow">
        <span>Workspace</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>{connection.driver}</span>
        <span className="sep">/</span>
        <span style={{ color: "var(--dv-text-dim)" }}>{activeSchema}</span>
      </div>
      <div className="dv-page-header">
        <div>
          <h1 className="dv-page-title">Schema · {activeSchema}</h1>
          <div className="dv-page-subtitle" style={{ marginTop: 6 }}>
            {loading
              ? progress.total > 0
                ? `Analizando estructura · ${progress.done}/${progress.total} tablas`
                : "Cargando…"
              : `${tableCount} tablas · ${fkCount} relaciones`}
          </div>
        </div>
        <div className="dv-page-actions">
          <div className="dv-segmented">
            <button className="dv-segmented-option" onClick={relayout}>
              Auto-layout
            </button>
            <button className="dv-segmented-option" onClick={fitToView}>
              Ajustar
            </button>
          </div>
          <div className="dv-segmented">
            <button
              className="dv-segmented-option"
              onClick={() => {
                const rect = viewportRef.current?.getBoundingClientRect();
                if (!rect) return;
                const cx = rect.width / 2;
                const cy = rect.height / 2;
                const next = Math.max(MIN_ZOOM, zoom / 1.2);
                const wx = (cx - pan.x) / zoom;
                const wy = (cy - pan.y) / zoom;
                setZoom(next);
                setPan({ x: cx - wx * next, y: cy - wy * next });
              }}
              title="Alejar"
            >
              −
            </button>
            <span
              className="dv-segmented-option"
              style={{ pointerEvents: "none", minWidth: 56, textAlign: "center" }}
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="dv-segmented-option"
              onClick={() => {
                const rect = viewportRef.current?.getBoundingClientRect();
                if (!rect) return;
                const cx = rect.width / 2;
                const cy = rect.height / 2;
                const next = Math.min(MAX_ZOOM, zoom * 1.2);
                const wx = (cx - pan.x) / zoom;
                const wy = (cy - pan.y) / zoom;
                setZoom(next);
                setPan({ x: cx - wx * next, y: cy - wy * next });
              }}
              title="Acercar"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {error && <div className="dv-error" style={{ marginTop: 12 }}>{error}</div>}

      <div
        ref={viewportRef}
        className="dv-erd-viewport"
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {!loading && nodes.length === 0 && !error && (
          <div className="dv-empty">Sin tablas en {activeSchema}.</div>
        )}

        <div className="dv-erd-canvas" style={transformStyle}>
          <svg
            className="dv-erd-svg"
            width={canvasExtent.width}
            height={canvasExtent.height}
            style={{ width: canvasExtent.width, height: canvasExtent.height }}
          >
            <defs>
              <marker
                id="dv-erd-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
              <marker
                id="dv-erd-arrow-active"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((e) => {
              const fromPos = positions.get(e.fromKey);
              const toPos = positions.get(e.toKey);
              if (!fromPos || !toPos) return null;
              const fromPort = ports.get(e.fromKey);
              const toPort = ports.get(e.toKey);
              const fromColY =
                fromPort?.yByColumn.get(e.fromColumns[0] ?? "") ??
                HEADER_HEIGHT;
              const toColY =
                toPort?.yByColumn.get(e.toColumns[0] ?? "") ?? HEADER_HEIGHT;

              const fromCenterX = fromPos.x + NODE_WIDTH / 2;
              const toCenterX = toPos.x + NODE_WIDTH / 2;
              const fromRight = toCenterX >= fromCenterX;
              const x1 = fromRight ? fromPos.x + NODE_WIDTH : fromPos.x;
              const x2 = fromRight ? toPos.x : toPos.x + NODE_WIDTH;
              const y1 = fromPos.y + fromColY;
              const y2 = toPos.y + toColY;
              const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
              const cx1 = x1 + (fromRight ? dx : -dx);
              const cx2 = x2 + (fromRight ? -dx : dx);
              const isActive = highlightedEdges?.has(e.id) ?? false;
              const dim = highlightedEdges != null && !isActive;
              return (
                <path
                  key={e.id}
                  d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
                  className={`dv-erd-edge${isActive ? " is-active" : ""}${
                    dim ? " is-dim" : ""
                  }`}
                  markerEnd={`url(#${isActive ? "dv-erd-arrow-active" : "dv-erd-arrow"})`}
                >
                  <title>{e.label}</title>
                </path>
              );
            })}
          </svg>

          {nodes.map((n) => {
            const key = nodeKey(n.schema, n.name);
            const pos = positions.get(key);
            if (!pos) return null;
            const fkColumns = new Set(
              n.foreignKeys.flatMap((fk) => fk.columns),
            );
            const dim = highlightedKeys != null && !highlightedKeys.has(key);
            const active = highlight === key;
            return (
              <div
                key={key}
                data-node
                className={`dv-erd-node${active ? " is-active" : ""}${
                  dim ? " is-dim" : ""
                }`}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: NODE_WIDTH,
                }}
                onPointerDown={(e) => onNodePointerDown(e, key)}
                onClick={() => setHighlight((h) => (h === key ? null : key))}
                onDoubleClick={() => onOpenTable(n.schema, n.name)}
                title={`${n.schema}.${n.name} — doble click para abrir`}
              >
                <div className="dv-erd-node-header">
                  <span className="dv-erd-node-icon">▦</span>
                  <span className="dv-erd-node-name">{n.name}</span>
                  <button
                    type="button"
                    className="dv-erd-node-open"
                    data-node-action
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTable(n.schema, n.name);
                    }}
                    title="Abrir tabla"
                  >
                    ↗
                  </button>
                </div>
                <div className="dv-erd-node-body">
                  {n.columns.length === 0 && (
                    <div className="dv-erd-node-empty">sin columnas</div>
                  )}
                  {n.columns.slice(0, 18).map((col) => {
                    const isPk = col.isPrimaryKey;
                    const isFk = fkColumns.has(col.name);
                    return (
                      <div key={col.name} className="dv-erd-col">
                        <span
                          className={`dv-erd-col-marker${isPk ? " is-pk" : ""}${
                            isFk ? " is-fk" : ""
                          }`}
                          title={
                            isPk
                              ? "Primary key"
                              : isFk
                              ? "Foreign key"
                              : col.nullable
                              ? "Nullable"
                              : "Not null"
                          }
                        >
                          {isPk ? "PK" : isFk ? "FK" : "·"}
                        </span>
                        <span className="dv-erd-col-name">{col.name}</span>
                        <span className="dv-erd-col-type">{col.dataType}</span>
                      </div>
                    );
                  })}
                  {n.columns.length > 18 && (
                    <div className="dv-erd-node-more">
                      + {n.columns.length - 18} columnas
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
