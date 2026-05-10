"use client";

import clsx from "clsx";
import { useTheme, type Theme, type ThemeVariant } from "../theme-context";

const THEME_OPTIONS: { value: Theme; label: string; hackerLabel: string }[] = [
  { value: "minimal", label: "Minimal", hackerLabel: "MIN" },
  { value: "hacker", label: "Hacker", hackerLabel: "HACK" },
];

const VARIANT_META: Record<ThemeVariant, { label: string; color: string }> = {
  light: { label: "Light", color: "#ffffff" },
  dark: { label: "Dark", color: "#18181b" },
  sepia: { label: "Sepia", color: "#8a5a1a" },
  magenta: { label: "Magenta", color: "#ff2bd6" },
  matrix: { label: "Matrix", color: "#00ff9c" },
  cyan: { label: "Cyan", color: "#00f0ff" },
  amber: { label: "Amber", color: "#ffb627" },
};

interface Props {
  /** Compact form shows abbreviated labels — useful in tight topbars. */
  compact?: boolean;
  /** Hide the variant swatches (e.g. on cramped surfaces). */
  hideVariants?: boolean;
}

export function ThemeSwitcher({ compact, hideVariants }: Props) {
  const { theme, setTheme, variant, variantsForTheme, setVariant } = useTheme();
  return (
    <div className="dv-theme-switcher-row">
      <div
        className="dv-theme-switcher"
        role="radiogroup"
        aria-label="Tema de la interfaz"
      >
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={theme === opt.value}
            className={clsx(theme === opt.value && "is-active")}
            onClick={() => setTheme(opt.value)}
            title={`Cambiar a tema ${opt.label}`}
          >
            {compact ? opt.hackerLabel : opt.label}
          </button>
        ))}
      </div>
      {!hideVariants && variantsForTheme.length > 1 && (
        <div
          className="dv-theme-variants"
          role="radiogroup"
          aria-label="Variante de color"
        >
          {variantsForTheme.map((v) => {
            const meta = VARIANT_META[v];
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={variant === v}
                aria-label={meta.label}
                title={meta.label}
                className={clsx("dv-theme-variant", variant === v && "is-active")}
                style={{ ["--variant-color" as string]: meta.color }}
                onClick={() => setVariant(v)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
