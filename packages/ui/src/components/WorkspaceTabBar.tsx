"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import {
  tabIcon,
  tabTitle,
  tabTooltip,
  type TabGroup,
  type WorkspaceTab,
} from "./workspace-tab";

interface Props {
  tabs: WorkspaceTab[];
  groups: TabGroup[];
  activeTabId: string | null;
  dirtyTabIds: Set<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Pin a preview tab — called on double-click. */
  onPinTab: (id: string) => void;
  onNewSql: () => void;
  // grouping
  onCreateGroupFromTab: (tabId: string, name: string) => void;
  onAddTabToGroup: (tabId: string, groupId: string) => void;
  onRemoveTabFromGroup: (tabId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onToggleGroupCollapsed: (groupId: string) => void;
  onDissolveGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
}

type ContextMenu =
  | { kind: "tab"; tabId: string; x: number; y: number }
  | { kind: "group"; groupId: string; x: number; y: number };

export function WorkspaceTabBar({
  tabs,
  groups,
  activeTabId,
  dirtyTabIds,
  onActivate,
  onClose,
  onPinTab,
  onNewSql,
  onCreateGroupFromTab,
  onAddTabToGroup,
  onRemoveTabFromGroup,
  onRenameGroup,
  onToggleGroupCollapsed,
  onDissolveGroup,
  onCloseGroup,
}: Props) {
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const groupById = useMemo(() => {
    const m = new Map<string, TabGroup>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // Close menu on click-outside / Esc.
  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function onTabMouseDown(e: ReactMouseEvent<HTMLDivElement>, id: string) {
    if (e.button === 1) {
      e.preventDefault();
      onClose(id);
    }
  }

  function onTabContextMenu(e: ReactMouseEvent<HTMLDivElement>, id: string) {
    e.preventDefault();
    setMenu({ kind: "tab", tabId: id, x: e.clientX, y: e.clientY });
  }

  function onGroupContextMenu(
    e: ReactMouseEvent<HTMLDivElement>,
    groupId: string,
  ) {
    e.preventDefault();
    setMenu({ kind: "group", groupId, x: e.clientX, y: e.clientY });
  }

  // Build ordered render items: group headers interleaved with their tabs.
  interface HeaderItem {
    kind: "group-header";
    group: TabGroup;
    tabCount: number;
  }
  interface TabItem {
    kind: "tab";
    tab: WorkspaceTab;
  }
  type Item = HeaderItem | TabItem;

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let lastGroupId: string | null | undefined = undefined;
    for (const t of tabs) {
      const gid = t.groupId ?? null;
      if (gid !== lastGroupId) {
        if (gid != null) {
          const g = groupById.get(gid);
          if (g) {
            const tabCount = tabs.filter((x) => x.groupId === gid).length;
            out.push({ kind: "group-header", group: g, tabCount });
          }
        }
        lastGroupId = gid;
      }
      if (gid != null) {
        const g = groupById.get(gid);
        if (g?.collapsed) continue;
      }
      out.push({ kind: "tab", tab: t });
    }
    return out;
  }, [tabs, groupById]);

  // Menu actions
  function handleCreateGroup() {
    if (menu?.kind !== "tab") return;
    const name = window.prompt("Nombre del grupo:", "Grupo");
    setMenu(null);
    if (!name || !name.trim()) return;
    onCreateGroupFromTab(menu.tabId, name.trim());
  }

  function handleAddToGroup(groupId: string) {
    if (menu?.kind !== "tab") return;
    onAddTabToGroup(menu.tabId, groupId);
    setMenu(null);
  }

  function handleRemoveFromGroup() {
    if (menu?.kind !== "tab") return;
    onRemoveTabFromGroup(menu.tabId);
    setMenu(null);
  }

  function handleRenameGroup() {
    if (menu?.kind !== "group") return;
    const current = groupById.get(menu.groupId);
    const name = window.prompt("Renombrar grupo:", current?.name ?? "");
    setMenu(null);
    if (!name || !name.trim()) return;
    onRenameGroup(menu.groupId, name.trim());
  }

  function handleDissolveGroup() {
    if (menu?.kind !== "group") return;
    onDissolveGroup(menu.groupId);
    setMenu(null);
  }

  function handleCloseGroup() {
    if (menu?.kind !== "group") return;
    onCloseGroup(menu.groupId);
    setMenu(null);
  }

  const tabForMenu =
    menu?.kind === "tab"
      ? tabs.find((t) => t.id === menu.tabId) ?? null
      : null;
  const availableGroupsForMenu = useMemo(() => {
    if (!tabForMenu) return [];
    return groups.filter((g) => g.id !== tabForMenu.groupId);
  }, [groups, tabForMenu]);

  return (
    <>
      <div className="dv-ws-tabs" role="tablist">
        <div className="dv-ws-tab-list">
          {items.map((item, idx) => {
            if (item.kind === "group-header") {
              const g = item.group;
              return (
                <div
                  key={`g-${g.id}`}
                  className={clsx(
                    "dv-ws-group-head",
                    g.collapsed && "is-collapsed",
                  )}
                  onClick={() => onToggleGroupCollapsed(g.id)}
                  onContextMenu={(e) => onGroupContextMenu(e, g.id)}
                  title={`${g.name} — clic para ${
                    g.collapsed ? "expandir" : "contraer"
                  }, click derecho para más opciones`}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dv-ws-group-caret">
                    {g.collapsed ? "▸" : "▾"}
                  </span>
                  <span className="dv-ws-group-name">{g.name}</span>
                  <span className="dv-ws-group-count">{item.tabCount}</span>
                </div>
              );
            }
            const t = item.tab;
            const isActive = t.id === activeTabId;
            const dirty = dirtyTabIds.has(t.id);
            const inGroup = !!t.groupId;
            const isPreview = !!t.isPreview;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={clsx(
                  "dv-ws-tab",
                  isActive && "is-active",
                  inGroup && "is-grouped",
                  isPreview && "is-preview",
                )}
                onClick={() => onActivate(t.id)}
                onDoubleClick={() => onPinTab(t.id)}
                onMouseDown={(e) => onTabMouseDown(e, t.id)}
                onContextMenu={(e) => onTabContextMenu(e, t.id)}
                title={
                  isPreview
                    ? `${tabTooltip(t)} — Preview (doble clic para fijar)`
                    : tabTooltip(t)
                }
                data-item-idx={idx}
              >
                <span
                  className={clsx("dv-ws-tab-icon", `is-kind-${t.kind}`)}
                  aria-hidden
                >
                  {tabIcon(t)}
                </span>
                <span className="dv-ws-tab-title">{tabTitle(t)}</span>
                {dirty && (
                  <span className="dv-ws-tab-dot" aria-label="sin guardar">
                    •
                  </span>
                )}
                <button
                  type="button"
                  className="dv-ws-tab-close"
                  aria-label="Cerrar pestaña"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="dv-ws-tab-new"
            onClick={onNewSql}
            title="Nuevo SQL editor"
            aria-label="Nuevo SQL editor"
          >
            +
          </button>
        </div>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="dv-ws-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
        >
          {menu.kind === "tab" && tabForMenu && (
            <>
              <button
                type="button"
                className="dv-ws-menu-item"
                onClick={handleCreateGroup}
              >
                Crear grupo nuevo…
              </button>
              {availableGroupsForMenu.length > 0 && (
                <>
                  <div className="dv-ws-menu-label">Agregar a grupo</div>
                  {availableGroupsForMenu.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="dv-ws-menu-item"
                      onClick={() => handleAddToGroup(g.id)}
                    >
                      {g.name}
                    </button>
                  ))}
                </>
              )}
              {tabForMenu.groupId && (
                <button
                  type="button"
                  className="dv-ws-menu-item"
                  onClick={handleRemoveFromGroup}
                >
                  Quitar del grupo
                </button>
              )}
              <div className="dv-ws-menu-sep" />
              <button
                type="button"
                className="dv-ws-menu-item"
                onClick={() => {
                  onClose(tabForMenu.id);
                  setMenu(null);
                }}
              >
                Cerrar pestaña
              </button>
            </>
          )}
          {menu.kind === "group" && (
            <>
              <button
                type="button"
                className="dv-ws-menu-item"
                onClick={handleRenameGroup}
              >
                Renombrar grupo…
              </button>
              <button
                type="button"
                className="dv-ws-menu-item"
                onClick={() => {
                  onToggleGroupCollapsed(menu.groupId);
                  setMenu(null);
                }}
              >
                {groupById.get(menu.groupId)?.collapsed
                  ? "Expandir"
                  : "Contraer"}
              </button>
              <button
                type="button"
                className="dv-ws-menu-item"
                onClick={handleDissolveGroup}
              >
                Disolver grupo
              </button>
              <div className="dv-ws-menu-sep" />
              <button
                type="button"
                className="dv-ws-menu-item is-danger"
                onClick={handleCloseGroup}
              >
                Cerrar todas las pestañas
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
