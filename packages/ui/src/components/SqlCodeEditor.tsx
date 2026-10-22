"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DatabaseDriver, RelationInfo, SchemaInfo } from "@data-view/core";
import CodeMirror from "@uiw/react-codemirror";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  MSSQL,
  MySQL,
  PostgreSQL,
  StandardSQL,
  sql as sqlLang,
  type SQLDialect,
} from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { useTheme } from "../theme-context";
import { useTransport } from "../transport-context";

interface Props {
  /** Current SQL text. */
  value: string;
  /** Updates the parent's SQL. Called for every keystroke. */
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter — run the active query. */
  onSubmit: () => void;
  /** Ctrl/Cmd+S — save the active SQL file. */
  onSave: () => void;
  /** Focus the editor after mount/when the parent flips this. */
  autoFocus?: boolean;
  driver: DatabaseDriver | null;
  /** Active database/schema (used as `defaultSchema` for the completer). */
  database: string | null;
  /** Connection id — used to fetch relations for autocomplete. */
  connectionId: string;
  /** Known schemas/databases for the connection. Used as completer keys when
   * tables haven't been fetched yet. */
  schemas: SchemaInfo[];
}

function dialectFor(driver: DatabaseDriver | null): SQLDialect {
  switch (driver) {
    case "postgres":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "mssql":
      return MSSQL;
    default:
      return StandardSQL;
  }
}

/** Variants in `theme-context.tsx` that should use a dark CodeMirror theme.
 * The minimal/light and minimal/sepia variants stay on the light theme. */
const DARK_VARIANTS = new Set([
  "dark",
  "magenta",
  "matrix",
  "cyan",
  "amber",
]);

/** Hoisted so the prop is referentially stable: @uiw/react-codemirror
 * reconfigures the whole editor whenever `basicSetup` changes identity. */
const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  autocompletion: true,
  bracketMatching: true,
  closeBrackets: true,
  history: true,
  drawSelection: true,
  dropCursor: true,
  indentOnInput: true,
  highlightSpecialChars: true,
  highlightSelectionMatches: true,
  searchKeymap: true,
};

/** Imperative handle exposed to parents (QueryEditor) so they can read the
 * current text selection — used to implement "Run selection". */
export interface SqlEditorHandle {
  /** Returns the currently selected text, or null when nothing is selected. */
  getSelection: () => string | null;
  focus: () => void;
}

export const SqlCodeEditor = forwardRef<SqlEditorHandle, Props>(function SqlCodeEditor({
  value,
  onChange,
  onSubmit,
  onSave,
  autoFocus,
  driver,
  database,
  connectionId,
  schemas,
}, forwardedRef) {
  const { variant } = useTheme();
  const transport = useTransport();
  const isDark = DARK_VARIANTS.has(variant);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  // Parents pass fresh closures on every render. Route them through refs so
  // the extensions (incl. the schema completion built from every table name)
  // and the editor config aren't rebuilt on each keystroke.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onSaveRef.current = onSave;
  const handleChange = useCallback((v: string) => onChangeRef.current(v), []);

  // CodeMirror is a client-only library: it injects its own DOM tree on mount
  // which Next.js's SSR can't reproduce, causing a hydration mismatch. Render
  // a matching placeholder on the server and the real editor only after the
  // component has mounted on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // ── Schema-aware completion ────────────────────────────────────────────────
  // lang-sql accepts a `schema` map of `{ tableName: ColumnSpec[] }` (or
  // `schema.table` for fully-qualified names). We populate it lazily from the
  // active database's relations. Columns aren't fetched here (would require
  // a describeTable per table) — keywords + table names is already a huge
  // upgrade over the textarea.
  const [relations, setRelations] = useState<RelationInfo[]>([]);
  useEffect(() => {
    if (!database) {
      setRelations([]);
      return;
    }
    let cancel = false;
    transport
      .listRelations(connectionId, database)
      .then((rs) => {
        if (!cancel) setRelations(rs);
      })
      .catch(() => {
        if (!cancel) setRelations([]);
      });
    return () => {
      cancel = true;
    };
  }, [transport, connectionId, database]);

  const schemaMap = useMemo(() => {
    const m: Record<string, string[]> = {};
    // Top-level: schemas/databases as bare names (no columns).
    for (const s of schemas) m[s.name] = [];
    // Relations under the active database. Both bare and fully-qualified
    // keys so completion works whether the user typed `schema.table` or just
    // `table`.
    for (const r of relations) {
      m[r.name] = [];
      m[`${r.schema}.${r.name}`] = [];
    }
    return m;
  }, [schemas, relations]);

  const extensions = useMemo(
    () => [
      sqlLang({
        dialect: dialectFor(driver),
        schema: schemaMap,
        defaultSchema: database ?? undefined,
        upperCaseKeywords: false,
      }),
      EditorView.lineWrapping,
      // Highest precedence: basicSetup's default keymap also binds Mod-Enter
      // (insertBlankLine) and, being registered first, would win — so
      // Ctrl/Cmd+Enter inserted a blank line instead of running the query.
      Prec.highest(
        keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            onSubmitRef.current();
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            onSaveRef.current();
            return true;
          },
          preventDefault: true,
        },
        ]),
      ),
    ],
    [driver, schemaMap, database],
  );

  // Focus once the editor is ready when `autoFocus` flips on. CodeMirror
  // exposes `.view.focus()` on the ref.
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => cmRef.current?.view?.focus(), 0);
    return () => clearTimeout(t);
  }, [autoFocus]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getSelection: () => {
        const view = cmRef.current?.view;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        return view.state.sliceDoc(from, to);
      },
      focus: () => {
        cmRef.current?.view?.focus();
      },
    }),
    [],
  );

  if (!mounted) {
    // Same outer wrapper as the live editor — keeps layout stable so the
    // flash of placeholder doesn't shift the SQL pane on hydration.
    return <div className="dv-sql-codemirror" aria-hidden />;
  }

  return (
    <div className="dv-sql-codemirror">
      <CodeMirror
        ref={cmRef}
        value={value}
        onChange={handleChange}
        extensions={extensions}
        theme={isDark ? "dark" : "light"}
        height="100%"
        placeholder="-- Escribí tu SQL acá. Ctrl+Enter para ejecutar, Ctrl+S para guardar."
        basicSetup={BASIC_SETUP}
      />
    </div>
  );
});
