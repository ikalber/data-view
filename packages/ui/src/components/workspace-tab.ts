type WorkspaceTabBody =
  | { kind: "connection-overview" }
  | { kind: "database-overview"; schema: string }
  | { kind: "table"; schema: string; name: string }
  | { kind: "schema"; schema: string | null }
  | { kind: "history" }
  | {
      kind: "sql";
      title: string;
      sql: string;
      fileId: string | null;
      /** Database/schema this script targets. Null = the connection's default.
       * Adapters handle it driver-specifically (USE for MySQL/MSSQL,
       * search_path for Postgres). */
      database: string | null;
    };

export type WorkspaceTab = WorkspaceTabBody & {
  id: string;
  /** Optional tab-group id. Tabs sharing a groupId render together inside the
   * group's collapsible chip in the tab bar. */
  groupId?: string | null;
  /** Preview tab (VS Code-style). Single-click in the sidebar opens an item
   * here; opening another preview replaces this one. Becomes pinned (false)
   * on edit, double-click, drag, or any explicit "keep open" interaction.
   * At most one tab should have isPreview=true at any time. */
  isPreview?: boolean;
};

export type WorkspaceTabKind = WorkspaceTabBody["kind"];

export interface TabGroup {
  id: string;
  name: string;
  collapsed: boolean;
  /** Tailwind-ish color token used to tint the group chip; falls back to accent. */
  color?: string;
}

/** Stable identity for tabs that should de-duplicate across reopens.
 * SQL tabs are intentionally unique per click. */
export function tabIdentityKey(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "connection-overview":
      return "co";
    case "database-overview":
      return `db:${tab.schema}`;
    case "table":
      return `t:${tab.schema}.${tab.name}`;
    case "schema":
      return `s:${tab.schema ?? ""}`;
    case "history":
      return "h";
    case "sql":
      return `sql:${tab.id}`;
  }
}

export function tabTitle(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "connection-overview":
      return "Overview";
    case "database-overview":
      return tab.schema;
    case "table":
      return tab.name;
    case "schema":
      return tab.schema ? `Schema · ${tab.schema}` : "Schema";
    case "history":
      return "History";
    case "sql":
      return tab.title;
  }
}

export function tabIcon(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "connection-overview":
      return "▤";
    case "database-overview":
      return "⛁";
    case "table":
      return "▦";
    case "schema":
      return "◇";
    case "history":
      return "↻";
    case "sql":
      return tab.fileId ? "▤" : "›_";
  }
}

export function tabTooltip(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "connection-overview":
      return "Overview de la conexión";
    case "database-overview":
      return tab.schema;
    case "table":
      return `${tab.schema}.${tab.name}`;
    case "schema":
      return tab.schema ? `Schema · ${tab.schema}` : "Schema";
    case "history":
      return "Historial de queries";
    case "sql":
      return tab.fileId ? `Archivo: ${tab.title}` : tab.title;
  }
}
