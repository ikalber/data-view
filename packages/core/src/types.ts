export type DatabaseDriver = "postgres" | "mysql" | "mssql";

/** Restricted palette so tag/folder colors map to design tokens (--dv-tone-*). */
export type TagColor = "neutral" | "success" | "warn" | "danger" | "info" | "accent";

export const TAG_COLORS: TagColor[] = [
  "neutral",
  "success",
  "warn",
  "danger",
  "info",
  "accent",
];

export interface Folder {
  id: string;
  name: string;
  color: TagColor;
  createdAt: string;
  updatedAt: string;
}

export type FolderInput = Omit<Folder, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  /** "system" tags (Test/Producción) are seeded automatically and can be edited
   * but not deleted, so the env classification stays predictable. */
  kind: "system" | "user";
  createdAt: string;
}

export type TagInput = Omit<Tag, "id" | "createdAt" | "kind"> & {
  id?: string;
};

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DatabaseDriver;
  host: string;
  port: number;
  database: string;
  username: string;
  /**
   * On the wire we never round-trip the password to the UI; the server/desktop
   * holds it. The UI sends it once on save and clears it afterwards.
   */
  password?: string;
  ssl?: boolean;
  /** Driver-specific extras (schema search path, sslmode, encrypt, etc). */
  options?: Record<string, string>;
  /** Folder this connection lives in. `null` means "Sin carpeta". */
  folderId: string | null;
  /** IDs of tags applied to this connection. */
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type ConnectionInput = Omit<
  ConnectionConfig,
  "id" | "createdAt" | "updatedAt" | "folderId" | "tagIds"
> & {
  id?: string;
  folderId?: string | null;
  tagIds?: string[];
};

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface SchemaInfo {
  name: string;
  isSystem: boolean;
}

export type RelationKind = "table" | "view" | "materialized_view";

export interface RelationInfo {
  schema: string;
  name: string;
  kind: RelationKind;
  approxRowCount?: number;
  /** Total on-disk size in bytes (heap + indexes + toast where applicable). */
  totalBytes?: number;
  /** Heap/data-only size in bytes (excludes indexes). */
  dataBytes?: number;
  /** Sum of index sizes in bytes. */
  indexBytes?: number;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  default?: string | null;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface TableDetails {
  schema: string;
  name: string;
  kind: RelationKind;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface QueryResultColumn {
  name: string;
  dataType: string;
}

export type CellValue = string | number | boolean | null | { __binary: true; bytes: number };

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: CellValue[][];
  rowCount: number;
  /** Number of rows affected for DML; null for SELECT-style queries. */
  affectedRows: number | null;
  durationMs: number;
  /** When true, the result was truncated server-side and more rows exist. */
  truncated: boolean;
}

/**
 * Snapshot of a single database/schema as seen from the server-level overview
 * — what the user sees before they pick anything to drill into.
 */
export interface DatabaseSummary {
  name: string;
  isSystem: boolean;
  /** Total on-disk size in bytes if the driver could compute it. */
  sizeBytes?: number;
  /** Number of user tables/views — present when cheap to compute. */
  relationCount?: number;
  /** Default character-set / collation / owner — driver-specific. */
  details?: string;
}

/**
 * Server-wide snapshot rendered when no schema/database is picked yet. Fields
 * are all optional because driver support varies and we want to render
 * partials gracefully.
 */
export interface ConnectionOverview {
  driver: DatabaseDriver;
  /** Full version string from the server, e.g. "PostgreSQL 16.2 on …". */
  serverVersion?: string;
  /** Currently-selected default database/catalog. */
  currentDatabase?: string;
  /** Logged-in user as reported by the server. */
  currentUser?: string;
  /** ISO timestamp of the server's now() — useful for clock-drift hints. */
  serverTime?: string;
  /** Seconds the server has been up. */
  uptimeSeconds?: number;
  /** Total bytes across all listed databases (sum of sizeBytes). */
  totalSizeBytes?: number;
  /** Active client connections right now. */
  activeConnections?: number;
  /** Server-configured cap, when discoverable. */
  maxConnections?: number;
  /** Databases visible to the current user. */
  databases: DatabaseSummary[];
}

export interface PageOptions {
  schema?: string;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: "asc" | "desc" }[];
  /**
   * Raw SQL WHERE expression (the part after `WHERE`, e.g. `id = 10 AND
   * status = 'active'`). Concatenated verbatim into the generated query —
   * the user already has full SQL access via the editor, so this is treated
   * as trusted input from the operator. Drivers configure the underlying
   * client to disallow multiple statements.
   */
  where?: string;
}
