import { useEffect, useRef, useState } from "react";
import { useDesktopZoom } from "./useDesktopZoom";

const BADGE_VISIBLE_MS = 1200;

/**
 * Monta los listeners globales de zoom y muestra un badge efímero abajo a la
 * derecha con el porcentaje actual cuando cambia el factor. Debe montarse una
 * sola vez, lo más cerca posible de la raíz de la app.
 */
export function ZoomController() {
  const { zoom } = useDesktopZoom();
  const [badgeVisible, setBadgeVisible] = useState(false);
  const firstRender = useRef(true);

  useEffect(() => {
    // No mostrar el badge en el mount inicial: sería ruido visual al abrir la app.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setBadgeVisible(true);
    const id = window.setTimeout(() => setBadgeVisible(false), BADGE_VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [zoom]);

  if (!badgeVisible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        // El badge vive fuera del flujo y queremos que NO escale con el zoom
        // del root para que el indicador se mantenga estable en tamaño visual.
        // `zoom: 1` neutraliza la herencia del root.
        zoom: 1,
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        fontFamily: "var(--dv-mono, monospace)",
        background: "var(--dv-surface-2, rgba(20, 20, 24, 0.9))",
        color: "var(--dv-text, #f5f5f5)",
        border: "1px solid var(--dv-border, rgba(255, 255, 255, 0.12))",
        boxShadow: "0 2px 12px rgba(0, 0, 0, 0.25)",
        pointerEvents: "none",
        zIndex: 9999,
        letterSpacing: "0.04em",
      }}
    >
      {Math.round(zoom * 100)}%
    </div>
  );
}
