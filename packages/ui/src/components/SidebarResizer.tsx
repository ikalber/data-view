"use client";

import { useCallback, useEffect, useRef } from "react";

interface Props {
  /** Ancho actual en px. */
  width: number;
  /** Callback de cambio mientras se arrastra y al soltar. */
  onChange: (next: number) => void;
  /** Doble-click resetea al default. */
  defaultWidth: number;
  /** Mínimo en px. */
  min: number;
  /** Máximo en px. */
  max: number;
}

/** Handle vertical que se arrastra para redimensionar el sidebar. Está
 * absolutamente posicionado sobre el borde derecho del sidebar y comunica el
 * nuevo ancho hacia AppShell, que lo persiste y lo aplica como variable CSS. */
export function SidebarResizer({
  width,
  onChange,
  defaultWidth,
  min,
  max,
}: Props) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove("is-resizing-sidebar");
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      const next = clamp(startWidthRef.current + (e.clientX - startXRef.current));
      onChange(next);
    }
    function onUp() {
      endDrag();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clamp, onChange, endDrag]);

  // Limpieza si el componente se desmonta a mitad de un arrastre.
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        document.body.classList.remove("is-resizing-sidebar");
      }
    };
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    document.body.classList.add("is-resizing-sidebar");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onChange(clamp(width - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onChange(clamp(width + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(clamp(defaultWidth));
    }
  }

  return (
    <div
      className="dv-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar barra lateral"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(clamp(defaultWidth))}
      onKeyDown={onKeyDown}
    />
  );
}
