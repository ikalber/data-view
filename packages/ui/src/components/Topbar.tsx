"use client";

import type { ReactNode } from "react";
import clsx from "clsx";
import type { ConnectionConfig, Folder, Tag } from "@data-view/core";
import { ConnectionPicker } from "./ConnectionPicker";
import { ThemeSwitcher } from "./ThemeSwitcher";

interface Props {
  connections: ConnectionConfig[];
  folders: Folder[];
  tags: Tag[];
  activeId: string | null;
  onSelectConnection: (id: string) => void;
  onAddConnection: () => void;
  onManageConnections: () => void;
  /** Whether the sidebar is showing the cross-connection tree view. */
  globalTreeView?: boolean;
  /** Toggle the cross-connection tree view in the sidebar. */
  onToggleGlobalTreeView?: () => void;
  /** Right-side slot for app-specific chrome (user menu, sign out, etc). */
  rightSlot?: ReactNode;
}

export function Topbar({
  connections,
  folders,
  tags,
  activeId,
  onSelectConnection,
  onAddConnection,
  onManageConnections,
  globalTreeView = false,
  onToggleGlobalTreeView,
  rightSlot,
}: Props) {
  return (
    <header className="dv-topbar">
      <div className="dv-brand">
        <span className="dv-brand-mark" aria-hidden />
        <span>Data View</span>
      </div>
      <span className="dv-topbar-divider" aria-hidden />

      <ConnectionPicker
        connections={connections}
        folders={folders}
        tags={tags}
        activeId={activeId}
        onSelect={onSelectConnection}
        onAdd={onAddConnection}
        onManage={onManageConnections}
      />

      {onToggleGlobalTreeView && (
        <button
          type="button"
          className={clsx(
            "dv-topbar-tree-toggle",
            globalTreeView && "is-active",
          )}
          title="Modo árbol — explorar todas las conexiones desde el sidebar"
          aria-label="Alternar modo árbol global"
          aria-pressed={globalTreeView}
          onClick={onToggleGlobalTreeView}
        >
          <span aria-hidden>⊟</span>
        </button>
      )}

      <div className="dv-topbar-spacer" />

      <div className="dv-topbar-right">
        <span className="dv-topbar-status">
          <span className="dv-topbar-status-dot" />
          {activeId ? "Conectado" : "Sin conexión"}
        </span>
        <ThemeSwitcher />
        {rightSlot}
      </div>
    </header>
  );
}
