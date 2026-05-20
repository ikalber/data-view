"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  /** Optional human-readable description shown above the confirm input. */
  message?: React.ReactNode;
  /** When set, the user has to type this exact text to enable the confirm
   * button — used for destructive actions (DROP, TRUNCATE). */
  confirmText?: string;
  /** Optional toggle (e.g. CASCADE) rendered above the confirm input. */
  toggle?: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    hint?: string;
  };
  /** Label for the confirm button. Defaults to "Confirmar". */
  confirmLabel?: string;
  /** When true, the confirm button is rendered with the destructive style. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmText,
  toggle,
  confirmLabel = "Confirmar",
  destructive,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, running]);

  const canConfirm = !running && (!confirmText || typed === confirmText);

  async function confirm() {
    if (!canConfirm) return;
    setRunning(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onCancel();
      }}
    >
      <div
        className="dv-modal"
        style={{ width: 460 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {message && (
          <div style={{ marginTop: -6, marginBottom: 14, fontSize: 13 }}>
            {message}
          </div>
        )}

        {toggle && (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginBottom: 14,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              checked={toggle.checked}
              onChange={(e) => toggle.onChange(e.target.checked)}
              disabled={running}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontWeight: 500 }}>{toggle.label}</span>
              {toggle.hint && (
                <div style={{ color: "var(--dv-text-dim)", marginTop: 2 }}>
                  {toggle.hint}
                </div>
              )}
            </span>
          </label>
        )}

        {confirmText && (
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            <span>
              Para confirmar, escribí{" "}
              <code
                style={{
                  fontFamily: "var(--dv-mono)",
                  padding: "1px 4px",
                  background: "var(--dv-panel-2)",
                  borderRadius: 3,
                }}
              >
                {confirmText}
              </code>
            </span>
            <input
              ref={inputRef}
              type="text"
              className="dv-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  e.preventDefault();
                  void confirm();
                }
              }}
              placeholder={confirmText}
              disabled={running}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {error && (
          <div className="dv-error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="dv-modal-actions">
          <button
            type="button"
            className="dv-button"
            onClick={onCancel}
            disabled={running}
          >
            Cancelar
          </button>
          <button
            type="button"
            className={destructive ? "dv-button is-danger" : "dv-button is-primary"}
            onClick={confirm}
            disabled={!canConfirm}
          >
            {running ? "Ejecutando…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
