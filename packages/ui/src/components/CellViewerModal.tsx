"use client";

import { useEffect, useMemo, useState } from "react";
import type { CellValue } from "@data-view/core";

interface Props {
  /** Column name shown in the header. */
  columnName: string;
  /** Column SQL type, when available. */
  dataType?: string;
  /** Raw value from the result row. */
  value: CellValue;
  onClose: () => void;
}

type Mode = "auto" | "json" | "text";

interface DetectedShape {
  /** Best guess at how to render the value by default. */
  default: Mode;
  /** Pretty-printed JSON if the string parses as JSON; otherwise null. */
  prettyJson: string | null;
  /** The textual form we use for the "text" view. */
  text: string;
  /** True for the binary placeholder `{ __binary: true, bytes: N }`. */
  isBinary: boolean;
  /** Binary length in bytes when applicable. */
  binaryBytes?: number;
  /** True when the value is SQL NULL. */
  isNull: boolean;
  /** Approximate character count of the text representation. */
  length: number;
}

function detect(value: CellValue): DetectedShape {
  if (value === null) {
    return {
      default: "text",
      prettyJson: null,
      text: "NULL",
      isBinary: false,
      isNull: true,
      length: 0,
    };
  }
  if (typeof value === "object" && "__binary" in value) {
    return {
      default: "text",
      prettyJson: null,
      text: `<binary ${value.bytes} bytes>`,
      isBinary: true,
      binaryBytes: value.bytes,
      isNull: false,
      length: 0,
    };
  }
  if (typeof value === "boolean") {
    return {
      default: "text",
      prettyJson: null,
      text: value ? "true" : "false",
      isBinary: false,
      isNull: false,
      length: 5,
    };
  }
  if (typeof value === "number") {
    return {
      default: "text",
      prettyJson: null,
      text: String(value),
      isBinary: false,
      isNull: false,
      length: String(value).length,
    };
  }
  // String — try parsing as JSON first.
  const text = value;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        default: "json",
        prettyJson: JSON.stringify(parsed, null, 2),
        text,
        isBinary: false,
        isNull: false,
        length: text.length,
      };
    } catch {
      /* not valid JSON — fall through to plain text */
    }
  }
  return {
    default: "text",
    prettyJson: null,
    text,
    isBinary: false,
    isNull: false,
    length: text.length,
  };
}

export function CellViewerModal({ columnName, dataType, value, onClose }: Props) {
  const shape = useMemo(() => detect(value), [value]);
  const [mode, setMode] = useState<Mode>(shape.default);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const displayed =
    mode === "json" && shape.prettyJson != null ? shape.prettyJson : shape.text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(displayed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* user dismissed the permission prompt — silently ignore */
    }
  }

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dv-modal"
        style={{
          width: 720,
          maxWidth: "92vw",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>{columnName}</h2>
        <div
          style={{
            fontSize: 12,
            color: "var(--dv-text-dim)",
            marginTop: 2,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {dataType && (
            <span style={{ fontFamily: "var(--dv-mono)" }}>{dataType}</span>
          )}
          {shape.isNull ? (
            <span>· valor NULL</span>
          ) : shape.isBinary ? (
            <span>· binario · {shape.binaryBytes?.toLocaleString()} bytes</span>
          ) : (
            <span>· {shape.length.toLocaleString()} caracteres</span>
          )}
        </div>

        {shape.prettyJson != null && (
          <div
            role="tablist"
            style={{ display: "flex", gap: 4, marginBottom: 8 }}
          >
            <button
              type="button"
              role="tab"
              className="dv-button is-sm"
              aria-pressed={mode === "json"}
              onClick={() => setMode("json")}
              style={mode === "json" ? activeTabStyle : undefined}
            >
              JSON
            </button>
            <button
              type="button"
              role="tab"
              className="dv-button is-sm"
              aria-pressed={mode === "text"}
              onClick={() => setMode("text")}
              style={mode === "text" ? activeTabStyle : undefined}
            >
              Texto crudo
            </button>
          </div>
        )}

        <pre
          style={{
            margin: 0,
            flex: 1,
            minHeight: 200,
            maxHeight: "60vh",
            overflow: "auto",
            background: "var(--dv-surface)",
            border: "1px solid var(--dv-border)",
            borderRadius: 6,
            padding: 12,
            fontFamily: "var(--dv-mono)",
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: shape.isNull ? "var(--dv-text-mute)" : "var(--dv-text)",
            fontStyle: shape.isNull || shape.isBinary ? "italic" : "normal",
          }}
        >
          {displayed}
        </pre>

        <div className="dv-modal-actions">
          <button
            type="button"
            className="dv-button"
            onClick={copy}
            disabled={shape.isNull || shape.isBinary}
            title={
              shape.isBinary
                ? "El valor es binario — no podemos copiar los bytes"
                : "Copiar al clipboard"
            }
          >
            {copied ? "Copiado ✓" : "Copiar"}
          </button>
          <button
            type="button"
            className="dv-button is-primary"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

const activeTabStyle: React.CSSProperties = {
  background: "var(--dv-panel-2)",
  borderColor: "var(--dv-accent)",
};
