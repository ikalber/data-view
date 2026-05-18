import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Niveles de zoom soportados. Mantener ordenados de menor a mayor.
 * El 1.0 es el nivel "neutro" y debe estar presente.
 */
export const ZOOM_LEVELS: readonly number[] = [
  0.75, 0.85, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0,
];

const STORAGE_KEY = "dbview.desktopZoom";
const DEFAULT_ZOOM = 1.0;
const WHEEL_THRESHOLD = 20; // pixeles acumulados antes de cambiar de step

function clampToLevel(value: number): number {
  // Snap al nivel más cercano para evitar valores arbitrarios desde storage.
  let closest = ZOOM_LEVELS[0]!;
  let minDiff = Math.abs(value - closest);
  for (const level of ZOOM_LEVELS) {
    const diff = Math.abs(value - level);
    if (diff < minDiff) {
      minDiff = diff;
      closest = level;
    }
  }
  return closest;
}

function readStoredZoom(): number {
  if (typeof window === "undefined") return DEFAULT_ZOOM;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ZOOM;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ZOOM;
    return clampToLevel(parsed);
  } catch {
    return DEFAULT_ZOOM;
  }
}

function applyZoom(factor: number) {
  if (typeof document === "undefined") return;
  // La propiedad `zoom` está soportada en Chromium/WebKit (el webview de Tauri en
  // todas las plataformas relevantes) y reflowea el layout, a diferencia de
  // `transform: scale` que mantiene el tamaño original del box.
  const style = document.documentElement.style as CSSStyleDeclaration & {
    zoom?: string;
  };
  style.zoom = String(factor);
  // Las unidades vh/vw se calculan sobre el viewport real e ignoran `zoom`.
  // Exponemos el factor para que .dv-app pueda compensarlo (height: 100vh / zoom)
  // y así el shell siempre encaje exactamente con el viewport visible.
  style.setProperty("--dv-zoom", String(factor));
}

function indexOfLevel(factor: number): number {
  const snapped = clampToLevel(factor);
  return ZOOM_LEVELS.indexOf(snapped);
}

export interface DesktopZoomApi {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setZoom: (factor: number) => void;
}

export function useDesktopZoom(): DesktopZoomApi {
  const [zoom, setZoomState] = useState<number>(() => readStoredZoom());
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Aplicar el zoom inicial lo antes posible (en el efecto de mount).
  useEffect(() => {
    applyZoom(zoomRef.current);
  }, []);

  const commit = useCallback((next: number) => {
    const snapped = clampToLevel(next);
    if (snapped === zoomRef.current) {
      // Reaplicar igual por si algo lo pisó.
      applyZoom(snapped);
      return;
    }
    zoomRef.current = snapped;
    setZoomState(snapped);
    applyZoom(snapped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(snapped));
    } catch {
      /* storage podría estar deshabilitado, no es crítico */
    }
  }, []);

  const zoomIn = useCallback(() => {
    const idx = indexOfLevel(zoomRef.current);
    const nextIdx = Math.min(ZOOM_LEVELS.length - 1, idx + 1);
    commit(ZOOM_LEVELS[nextIdx]!);
  }, [commit]);

  const zoomOut = useCallback(() => {
    const idx = indexOfLevel(zoomRef.current);
    const nextIdx = Math.max(0, idx - 1);
    commit(ZOOM_LEVELS[nextIdx]!);
  }, [commit]);

  const resetZoom = useCallback(() => {
    commit(DEFAULT_ZOOM);
  }, [commit]);

  // Atajos de teclado: Ctrl/Cmd + (+ / - / 0).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // No interferir con otros modificadores poco comunes.
      if (e.altKey) return;

      const key = e.key;
      // Ctrl + "+"  → key puede ser "+", "=" (sin Shift en teclados US) o "Add" (numpad)
      if (key === "+" || key === "=" || key === "Add") {
        e.preventDefault();
        zoomIn();
        return;
      }
      // Ctrl + "-"  → key puede ser "-", "_" o "Subtract"
      if (key === "-" || key === "_" || key === "Subtract") {
        e.preventDefault();
        zoomOut();
        return;
      }
      // Ctrl + 0 (reset). También soportar el "0" del numpad.
      if (key === "0" || key === "Numpad0") {
        e.preventDefault();
        resetZoom();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, resetZoom]);

  // Ctrl + wheel: acumular delta para evitar saltos bruscos en trackpads.
  useEffect(() => {
    let accum = 0;
    let rafId: number | null = null;

    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      accum += e.deltaY;

      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (accum <= -WHEEL_THRESHOLD) {
          accum = 0;
          zoomIn();
        } else if (accum >= WHEEL_THRESHOLD) {
          accum = 0;
          zoomOut();
        }
      });
    };

    // passive:false es obligatorio para que preventDefault() funcione en wheel.
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [zoomIn, zoomOut]);

  return { zoom, zoomIn, zoomOut, resetZoom, setZoom: commit };
}
