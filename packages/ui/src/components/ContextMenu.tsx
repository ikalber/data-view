"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  /** Label shown for the item. Ignored when `separator` is true. */
  label?: string;
  /** Optional short label rendered to the right of the main label (typically
   * a keyboard hint like `⌘⏎` or a sub-text). */
  hint?: string;
  /** Action invoked on click. The menu closes automatically before firing. */
  onClick?: () => void;
  /** When true, render in danger color (DROP, TRUNCATE…). */
  destructive?: boolean;
  /** When true, render as a horizontal divider instead of an item. */
  separator?: boolean;
  /** When true, render greyed-out and ignore clicks. */
  disabled?: boolean;
}

interface Props {
  /** Anchor position in viewport coordinates (clientX/clientY of the
   * triggering pointer event). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_MARGIN = 6;

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Start offscreen so we can measure without flashing at the bad position.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Position the menu after first render. If it overflows the viewport, flip
  // it to the opposite side (right-edge → align right of cursor; bottom-edge
  // → align above cursor). This is the standard context-menu behaviour.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width + MENU_MARGIN > window.innerWidth) {
      nx = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN);
    }
    if (ny + rect.height + MENU_MARGIN > window.innerHeight) {
      ny = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN);
    }
    setPos({ x: nx, y: ny });
  }, [x, y, items]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    // mousedown fires before click so we don't accidentally swallow the click
    // event that opened the menu.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("contextmenu", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("contextmenu", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        // Render offscreen on the first frame; useLayoutEffect repositions
        // before paint, so the user never sees this initial offscreen state.
        left: pos ? pos.x : -9999,
        top: pos ? pos.y : -9999,
        zIndex: 1000,
        minWidth: 200,
        maxWidth: 320,
        background: "var(--dv-panel)",
        border: "1px solid var(--dv-border)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        padding: 4,
        fontSize: 13,
      }}
      // Prevent the browser's native menu from also opening if the user
      // right-clicks on a menu item by mistake.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                background: "var(--dv-border)",
                margin: "4px 0",
              }}
            />
          );
        }
        const destructive = item.destructive && !item.disabled;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              width: "100%",
              padding: "6px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 4,
              cursor: item.disabled ? "default" : "pointer",
              color: item.disabled
                ? "var(--dv-text-mute)"
                : destructive
                ? "var(--dv-tone-danger-fg)"
                : "var(--dv-text)",
              fontSize: 13,
              fontFamily: "inherit",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              if (item.disabled) return;
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--dv-panel-2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "transparent";
            }}
          >
            <span>{item.label}</span>
            {item.hint && (
              <span
                style={{
                  fontSize: 11,
                  color: "var(--dv-text-mute)",
                  fontFamily: "var(--dv-mono)",
                }}
              >
                {item.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
