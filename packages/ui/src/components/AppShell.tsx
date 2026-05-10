"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ConnectionConfig,
  Folder,
  SchemaInfo,
  Tag,
} from "@data-view/core";
import { useTransport } from "../transport-context";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionOverviewPane } from "./ConnectionOverviewPane";
import { HistoryPane } from "./HistoryPane";
import { ManageConnectionsModal } from "./ManageConnectionsModal";
import { OverviewPane } from "./OverviewPane";
import { QueryEditor } from "./QueryEditor";
import { SchemaDiagramPane } from "./SchemaDiagramPane";
import { Sidebar } from "./Sidebar";
import { TablePane } from "./TablePane";
import { Topbar } from "./Topbar";
import type { ViewKey } from "./view";

interface Props {
  /** Right-side slot in the topbar (user menu, sign-out link, etc). */
  userArea?: ReactNode;
}

export function AppShell({ userArea }: Props) {
  const transport = useTransport();
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("overview");
  const [activeTable, setActiveTable] = useState<{ schema: string; name: string } | null>(null);
  const [activeSchema, setActiveSchema] = useState<string | null>(null);
  const [sqlSeed, setSqlSeed] = useState<{ sql: string; nonce: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, fs, ts] = await Promise.all([
        transport.listConnections(),
        transport.listFolders(),
        transport.listTags(),
      ]);
      setConnections(list);
      setFolders(fs);
      setTags(ts);
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

  // When the sidebar finishes loading the schema list, auto-pick a sensible
  // default so the user lands on tables right away.
  const handleSchemasLoaded = useCallback(
    (schemas: SchemaInfo[]) => {
      setActiveSchema((current) => {
        if (current && schemas.some((s) => s.name === current)) return current;
        const userSchemas = schemas.filter((s) => !s.isSystem);
        // Prefer the connection's configured database if it shows up in the list
        // (relevant for MySQL where listSchemas == SHOW DATABASES).
        const preferred = active?.database
          ? userSchemas.find((s) => s.name === active.database)
          : null;
        if (preferred) return preferred.name;
        return userSchemas[0]?.name ?? null;
      });
    },
    [active?.database],
  );

  function changeView(v: ViewKey) {
    setView(v);
    setActiveTable(null);
  }

  function changeSchema(schema: string) {
    setActiveSchema(schema);
    // Clear any open table that belongs to a different schema
    setActiveTable((prev) => (prev && prev.schema !== schema ? null : prev));
  }

  function openTable(schema: string, name: string) {
    setActiveTable({ schema, name });
    setActiveSchema(schema); // keep sidebar in sync
    setView("table");
  }

  function openInSqlEditor(sql: string) {
    setSqlSeed({ sql, nonce: Date.now() });
    setView("sql");
    setActiveTable(null);
  }

  function selectConnection(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setView("overview");
    setActiveTable(null);
    setActiveSchema(null);
    setSqlSeed(null);
  }

  return (
    <div className="dv-app">
      <Topbar
        connections={connections}
        folders={folders}
        tags={tags}
        activeId={activeId}
        onSelectConnection={selectConnection}
        onAddConnection={() => {
          setEditingConnectionId(null);
          setShowForm(true);
        }}
        onManageConnections={() => setShowManage(true)}
        rightSlot={userArea}
      />
      <div className="dv-app-body">
        <Sidebar
          connectionId={activeId}
          driver={active?.driver ?? null}
          view={view}
          activeTable={activeTable}
          activeSchema={activeSchema}
          onChangeView={changeView}
          onChangeSchema={changeSchema}
          onSchemasLoaded={handleSchemasLoaded}
          onOpenTable={openTable}
        />
        <main className="dv-main">
          {error && <div className="dv-error">{error}</div>}
          {!active && (
            <div className="dv-empty">
              Creá una conexión para empezar.
              <div style={{ marginTop: 16 }}>
                <button
                  className="dv-button is-primary"
                  onClick={() => setShowForm(true)}
                >
                  Nueva conexión
                </button>
              </div>
            </div>
          )}
          {active && view === "overview" && !activeSchema && (
            <ConnectionOverviewPane
              connection={active}
              onSelectDatabase={changeSchema}
            />
          )}
          {active && view === "overview" && activeSchema && (
            <OverviewPane
              connection={active}
              activeSchema={activeSchema}
              onOpenSqlEditor={() => openInSqlEditor(`-- ${active.database}\n`)}
              onOpenTable={openTable}
            />
          )}
          {active && view === "sql" && (
            <QueryEditor connectionId={active.id} seed={sqlSeed} />
          )}
          {active && view === "table" && activeTable && (
            <TablePane
              connectionId={active.id}
              driver={active.driver}
              schema={activeTable.schema}
              name={activeTable.name}
              onOpenInSqlEditor={(sql) => {
                setSqlSeed({ sql, nonce: Date.now() });
                setView("sql");
                setActiveTable(null);
              }}
            />
          )}
          {active && view === "schema" && (
            <SchemaDiagramPane
              connection={active}
              activeSchema={activeSchema}
              onOpenTable={openTable}
            />
          )}
          {active && view === "history" && (
            <HistoryPane
              connection={active}
              connections={connections}
              onOpenInSqlEditor={openInSqlEditor}
            />
          )}
        </main>
      </div>
      {showForm && (
        <ConnectionForm
          folders={folders}
          tags={tags}
          initial={
            editingConnectionId
              ? connections.find((c) => c.id === editingConnectionId) ?? undefined
              : undefined
          }
          onCancel={() => {
            setShowForm(false);
            setEditingConnectionId(null);
          }}
          onSaved={async (id) => {
            setShowForm(false);
            setEditingConnectionId(null);
            await refresh();
            setActiveId(id);
            setView("overview");
            setActiveTable(null);
            setActiveSchema(null);
          }}
        />
      )}
      {showManage && (
        <ManageConnectionsModal
          onClose={() => setShowManage(false)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
