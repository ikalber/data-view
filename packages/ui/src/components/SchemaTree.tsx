"use client";

import { useEffect, useMemo, useState } from "react";
import type { RelationInfo, SchemaInfo } from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  connectionId: string;
  onOpenTable: (schema: string, name: string) => void;
}

export function SchemaTree({ connectionId, onOpenTable }: Props) {
  const transport = useTransport();
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [relations, setRelations] = useState<Record<string, RelationInfo[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    transport
      .listSchemas(connectionId)
      .then((s) => {
        if (cancel) return;
        setSchemas(s);
        const userSchemas = s.filter((x) => !x.isSystem).map((x) => x.name);
        if (userSchemas.length === 1) setExpanded(new Set(userSchemas));
      })
      .catch((e) => !cancel && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [connectionId, transport]);

  async function toggle(schema: string) {
    const next = new Set(expanded);
    if (next.has(schema)) {
      next.delete(schema);
      setExpanded(next);
      return;
    }
    next.add(schema);
    setExpanded(next);
    if (!relations[schema]) {
      try {
        const rels = await transport.listRelations(connectionId, schema);
        setRelations((r) => ({ ...r, [schema]: rels }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  const sorted = useMemo(
    () => [...schemas].sort((a, b) => Number(a.isSystem) - Number(b.isSystem) || a.name.localeCompare(b.name)),
    [schemas],
  );

  if (loading) return <div className="dv-tree-section-label">Cargando…</div>;
  if (error) return <div className="dv-error">{error}</div>;

  return (
    <div className="dv-tree-section">
      <div className="dv-tree-section-label">Tablas</div>
      {sorted.map((schema) => (
        <div key={schema.name}>
          <div className="dv-tree-row is-schema" onClick={() => toggle(schema.name)}>
            <span className="dv-tree-row-icon">{expanded.has(schema.name) ? "▾" : "▸"}</span>
            <span>{schema.name}</span>
          </div>
          {expanded.has(schema.name) &&
            (relations[schema.name] ?? []).map((r) => (
              <div
                key={`${r.schema}.${r.name}`}
                className="dv-tree-row"
                onDoubleClick={() => onOpenTable(r.schema, r.name)}
                onClick={() => onOpenTable(r.schema, r.name)}
                title={`${r.schema}.${r.name}`}
              >
                <span className="dv-tree-row-icon">
                  {r.kind === "view" ? "◇" : r.kind === "materialized_view" ? "◈" : "▦"}
                </span>
                <span>{r.name}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
