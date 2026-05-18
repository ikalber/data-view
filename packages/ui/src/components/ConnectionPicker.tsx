"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { ConnectionConfig, Folder, Tag } from "@data-view/core";

export type Env = "prod" | "staging" | "dev" | "local" | null;

interface Props {
  connections: ConnectionConfig[];
  folders: Folder[];
  tags: Tag[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onManage: () => void;
}

export function ConnectionPicker({
  connections,
  folders,
  tags,
  activeId,
  onSelect,
  onAdd,
  onManage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const active = connections.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const grouped = useMemo(() => {
    const map = new Map<string | null, ConnectionConfig[]>();
    map.set(null, []);
    for (const f of folders) map.set(f.id, []);
    for (const c of connections) {
      const key = c.folderId && map.has(c.folderId) ? c.folderId : null;
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [connections, folders]);

  const orderedFolderIds = useMemo(
    () => folders.map((f) => f.id),
    [folders],
  );
  const noFolderConns = grouped.get(null) ?? [];

  function toggle(folderId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  return (
    <div className="dv-conn-picker" ref={ref}>
      <button
        type="button"
        className="dv-conn-pill"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active ? (
          <>
            <ConnectionTagChips
              connection={active}
              tagsById={tagsById}
              limit={2}
            />
            <span className="dv-conn-pill-meta">
              <span className="dv-conn-pill-db">
                {active.database || active.name}
              </span>
              <span className="dv-conn-pill-sub">
                {active.username}@{active.host}:{active.port}
              </span>
            </span>
          </>
        ) : (
          <span className="dv-conn-pill-empty">Sin conexión</span>
        )}
        <span className="dv-conn-pill-caret">▾</span>
      </button>

      {open && (
        <div className="dv-popover dv-popover-grouped" role="listbox">
          <div className="dv-popover-header">
            <span style={{ flex: 1 }}>Conexiones · {connections.length}</span>
            <button
              type="button"
              className="dv-popover-header-action"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              title="Gestionar carpetas y etiquetas"
            >
              Gestionar
            </button>
          </div>
          {connections.length === 0 ? (
            <div className="dv-empty" style={{ padding: 24 }}>
              Sin conexiones todavía.
            </div>
          ) : (
            <>
              {orderedFolderIds.map((fid) => {
                const folder = folders.find((f) => f.id === fid)!;
                const list = grouped.get(fid) ?? [];
                if (list.length === 0) return null;
                const isCollapsed = collapsed.has(fid);
                return (
                  <FolderGroup
                    key={fid}
                    folder={folder}
                    connections={list}
                    activeId={activeId}
                    tagsById={tagsById}
                    collapsed={isCollapsed}
                    onToggle={() => toggle(fid)}
                    onSelect={(id) => {
                      onSelect(id);
                      setOpen(false);
                    }}
                  />
                );
              })}
              {noFolderConns.length > 0 && (
                <FolderGroup
                  folder={null}
                  connections={noFolderConns}
                  activeId={activeId}
                  tagsById={tagsById}
                  collapsed={collapsed.has("__none__")}
                  onToggle={() => toggle("__none__")}
                  onSelect={(id) => {
                    onSelect(id);
                    setOpen(false);
                  }}
                />
              )}
            </>
          )}
          <div
            className="dv-popover-footer"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            <span style={{ fontWeight: 600 }}>+</span>
            <span>Nueva conexión</span>
            <span style={{ marginLeft: "auto" }} className="dv-kbd">↵</span>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderGroup({
  folder,
  connections,
  activeId,
  tagsById,
  collapsed,
  onToggle,
  onSelect,
}: {
  folder: Folder | null;
  connections: ConnectionConfig[];
  activeId: string | null;
  tagsById: Map<string, Tag>;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
}) {
  const containsActive =
    !!activeId && connections.some((c) => c.id === activeId);
  // Auto-expand groups with the active connection regardless of stored state.
  const effectivelyCollapsed = collapsed && !containsActive;

  const label = folder ? folder.name : "Sin carpeta";
  const color = folder?.color ?? "neutral";

  return (
    <div className="dv-popover-folder">
      <button
        type="button"
        className="dv-popover-folder-head"
        onClick={onToggle}
        aria-expanded={!effectivelyCollapsed}
      >
        <span className="dv-popover-folder-caret">
          {effectivelyCollapsed ? "▸" : "▾"}
        </span>
        <span className={clsx("dv-tone-dot", `is-${color}`)} aria-hidden />
        <span className="dv-popover-folder-name">{label}</span>
        <span className="dv-popover-folder-count">{connections.length}</span>
      </button>
      {!effectivelyCollapsed &&
        connections.map((c) => (
          <div
            key={c.id}
            role="option"
            aria-selected={c.id === activeId}
            className={clsx(
              "dv-popover-row",
              c.id === activeId && "is-active",
            )}
            onClick={() => onSelect(c.id)}
          >
            <div className="dv-popover-row-title">
              <ConnectionTagChips
                connection={c}
                tagsById={tagsById}
                limit={3}
              />
              <span>{c.name}</span>
              {c.id === activeId && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 12,
                    color: "var(--dv-text-dim)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span className="dv-topbar-status-dot" /> activa
                </span>
              )}
            </div>
            <div className="dv-popover-row-sub">
              {c.driver} · {c.host}:{c.port}/{c.database}
            </div>
          </div>
        ))}
    </div>
  );
}

function ConnectionTagChips({
  connection,
  tagsById,
  limit,
}: {
  connection: ConnectionConfig;
  tagsById: Map<string, Tag>;
  limit: number;
}) {
  if (!connection.tagIds || connection.tagIds.length === 0) return null;
  const visible = connection.tagIds
    .map((id) => tagsById.get(id))
    .filter((t): t is Tag => !!t)
    .slice(0, limit);
  const hidden = (connection.tagIds.length ?? 0) - visible.length;
  return (
    <span className="dv-conn-tags">
      {visible.map((t) => (
        <span key={t.id} className={clsx("dv-tag", `is-${t.color}`)}>
          {t.name}
        </span>
      ))}
      {hidden > 0 && <span className="dv-tag is-neutral">+{hidden}</span>}
    </span>
  );
}
