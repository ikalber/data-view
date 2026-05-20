import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionOverview,
  Folder,
  FolderInput,
  PageOptions,
  QueryResult,
  RelationInfo,
  SchemaInfo,
  TableDetails,
  Tag,
  TagInput,
  TestConnectionResult,
} from "./types";
import type {
  ExportDatabaseOptions,
  ExportDatabaseResult,
  ExportTableOptions,
  ExportTableResult,
} from "./export";

/**
 * Transport is the boundary between UI and the host environment.
 *
 *  - In the web app, it speaks fetch() against Next.js route handlers.
 *  - In the desktop app, it speaks `invoke()` against Tauri commands.
 *
 * Keep this interface narrow: every UI feature must go through it.
 */
export interface Transport {
  listConnections(): Promise<ConnectionConfig[]>;
  getConnection(id: string): Promise<ConnectionConfig>;
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  testConnection(input: ConnectionInput): Promise<TestConnectionResult>;

  listFolders(): Promise<Folder[]>;
  saveFolder(input: FolderInput): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;

  listTags(): Promise<Tag[]>;
  saveTag(input: TagInput): Promise<Tag>;
  deleteTag(id: string): Promise<void>;

  listSchemas(connectionId: string): Promise<SchemaInfo[]>;
  listRelations(connectionId: string, schema?: string): Promise<RelationInfo[]>;
  /** Server-wide snapshot for the "no schema selected" landing view. */
  getConnectionOverview(connectionId: string): Promise<ConnectionOverview>;
  describeTable(connectionId: string, schema: string, name: string): Promise<TableDetails>;

  runQuery(
    connectionId: string,
    sql: string,
    options?: RunQueryOptions,
  ): Promise<QueryResult>;
  fetchTableData(
    connectionId: string,
    schema: string,
    name: string,
    options?: PageOptions,
  ): Promise<QueryResult>;

  /**
   * Stream a whole table to disk (desktop) or to the browser as a download
   * (web). Returns stats so the UI can render "X rows · Y MB" feedback.
   */
  exportTable(
    connectionId: string,
    schema: string,
    name: string,
    options: ExportTableOptions,
  ): Promise<ExportTableResult>;

  /**
   * Dump multiple schemas to a single .sql file. Always emits SQL — other
   * formats don't roundtrip schema reliably across drivers.
   */
  exportDatabase(
    connectionId: string,
    options: ExportDatabaseOptions,
  ): Promise<ExportDatabaseResult>;

  /**
   * Create whatever the sidebar lists under "schema" for this driver:
   *  - Postgres / SQL Server → `CREATE SCHEMA …` inside the active database.
   *  - MySQL/MariaDB → `CREATE DATABASE …` (schema and database are aliases).
   * The newly created item shows up in `listSchemas` after a refresh.
   */
  createSchema(
    connectionId: string,
    options: CreateSchemaOptions,
  ): Promise<void>;

  /** Create a table inside an existing schema/database. */
  createTable(
    connectionId: string,
    options: CreateTableOptions,
  ): Promise<void>;
}

export interface CreateSchemaOptions {
  name: string;
  /** MySQL only — default character set. */
  charset?: string;
  /** MySQL / SQL Server — default collation. */
  collation?: string;
  /** Postgres only — owner role for the new schema. */
  owner?: string;
}

export interface CreateTableColumn {
  name: string;
  /** Raw SQL type expression as the user typed it (e.g. `varchar(255)`,
   * `int identity(1,1)`). Driver-specific — no validation here. */
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Raw default expression placed verbatim after `DEFAULT`. */
  default?: string | null;
}

export interface CreateTableOptions {
  schema: string;
  name: string;
  columns: CreateTableColumn[];
}

export interface RunQueryOptions {
  /** Override the active database/schema for this query. The adapter handles
   * it driver-specifically (USE in MySQL/MSSQL, search_path in Postgres). */
  schema?: string;
  params?: unknown[];
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
