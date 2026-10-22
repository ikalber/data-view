"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useIsomorphicLayoutEffect } from "./use-isomorphic-layout-effect";

export type Theme = "minimal" | "hacker";

export type MinimalVariant = "light" | "dark" | "sepia";
export type HackerVariant = "magenta" | "matrix" | "cyan" | "amber";
export type ThemeVariant = MinimalVariant | HackerVariant;

export const THEME_VARIANTS: Record<Theme, readonly ThemeVariant[]> = {
  minimal: ["light", "dark", "sepia"] as const,
  hacker: ["magenta", "matrix", "cyan", "amber"] as const,
};

export const DEFAULT_VARIANT: Record<Theme, ThemeVariant> = {
  minimal: "light",
  hacker: "magenta",
};

const STORAGE_KEY = "dbview.theme";
const VARIANT_KEY_PREFIX = "dbview.themeVariant.";

interface ThemeCtx {
  theme: Theme;
  variant: ThemeVariant;
  variantsForTheme: readonly ThemeVariant[];
  setTheme: (t: Theme) => void;
  setVariant: (v: ThemeVariant) => void;
  toggleTheme: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function isVariantFor(theme: Theme, value: string): value is ThemeVariant {
  return (THEME_VARIANTS[theme] as readonly string[]).includes(value);
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "minimal";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "minimal" || stored === "hacker") return stored;
  } catch {
    /* localStorage may be unavailable (private mode, SSR, etc) */
  }
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "hacker";
  }
  return "minimal";
}

function readInitialVariant(theme: Theme): ThemeVariant {
  if (typeof window === "undefined") return DEFAULT_VARIANT[theme];
  try {
    const stored = window.localStorage.getItem(VARIANT_KEY_PREFIX + theme);
    if (stored && isVariantFor(theme, stored)) return stored;
  } catch {
    /* ignore */
  }
  return DEFAULT_VARIANT[theme];
}

export function ThemeProvider({
  children,
  defaultTheme,
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  // The first render uses fixed defaults so the web's server HTML and the
  // client's hydration render match (reading localStorage here produced
  // hydration errors and a stale active swatch in ThemeSwitcher). The
  // persisted choice is applied right after mount, before paint; the inline
  // themeInitScript has already set the right [data-theme] on <html>.
  const [state, setState] = useState<{
    theme: Theme;
    variant: ThemeVariant;
    /** False until the persisted preference has been read. */
    loaded: boolean;
  }>(() => {
    const theme = defaultTheme ?? "minimal";
    return { theme, variant: DEFAULT_VARIANT[theme], loaded: false };
  });
  const { theme, variant } = state;

  useIsomorphicLayoutEffect(() => {
    const t = defaultTheme ?? readInitialTheme();
    setState({ theme: t, variant: readInitialVariant(t), loaded: true });
    // Mount-only: later changes go through setTheme/setVariant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIsomorphicLayoutEffect(() => {
    // Don't apply/persist the placeholder defaults of the first render.
    if (!state.loaded) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeVariant = variant;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
      window.localStorage.setItem(VARIANT_KEY_PREFIX + theme, variant);
    } catch {
      /* ignore */
    }
  }, [state.loaded, theme, variant]);

  const setTheme = (next: Theme) => {
    setState({ theme: next, variant: readInitialVariant(next), loaded: true });
  };

  const setVariant = (next: ThemeVariant) => {
    setState((s) =>
      isVariantFor(s.theme, next) ? { ...s, variant: next, loaded: true } : s,
    );
  };

  const value: ThemeCtx = {
    theme,
    variant,
    variantsForTheme: THEME_VARIANTS[theme],
    setTheme,
    setVariant,
    toggleTheme: () => setTheme(theme === "hacker" ? "minimal" : "hacker"),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}

/** Inline script that runs before React mounts to set [data-theme] and
 * [data-theme-variant] on <html>, avoiding a flash of the wrong theme.
 * Mirrors readInitialTheme/readInitialVariant so the two stay in sync. */
export const themeInitScript = `
(function(){try{var k='${STORAGE_KEY}';var s=localStorage.getItem(k);
var t=(s==='minimal'||s==='hacker')?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'hacker':'minimal');
document.documentElement.dataset.theme=t;
var vs={minimal:['light','dark','sepia'],hacker:['magenta','matrix','cyan','amber']};
var dv={minimal:'light',hacker:'magenta'};
var vk='${VARIANT_KEY_PREFIX}'+t;var v=localStorage.getItem(vk);
if(!v||vs[t].indexOf(v)===-1)v=dv[t];
document.documentElement.dataset.themeVariant=v;}catch(_){document.documentElement.dataset.theme='minimal';document.documentElement.dataset.themeVariant='light';}})();
`.trim();
