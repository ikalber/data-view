"use client";

import clsx from "clsx";
import type { ConnectionConfig } from "@data-view/core";

interface Props {
  connections: ConnectionConfig[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export function ConnectionList({ connections, activeId, onSelect, onAdd }: Props) {
  return (
    <>
      <div className="dv-sidebar-header">
        <span className="dv-sidebar-title">Conexiones · {connections.length}</span>
        <button
          className="dv-icon-button"
          onClick={onAdd}
          aria-label="Nueva conexión"
          title="Nueva conexión"
        >
          +
        </button>
      </div>
      <div className="dv-sidebar-list">
        {connections.length === 0 ? (
          <div className="dv-empty" style={{ padding: 24, fontSize: 12 }}>
            Sin conexiones todavía.
          </div>
        ) : (
          connections.map((c) => (
            <div
              key={c.id}
              className={clsx("dv-conn-item", c.id === activeId && "is-active")}
              onClick={() => onSelect(c.id)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="dv-conn-name">{c.name}</div>
                <div className="dv-conn-meta">
                  {c.driver} · {c.host}:{c.port}/{c.database}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
