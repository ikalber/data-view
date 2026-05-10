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

  runQuery(connectionId: string, sql: string, params?: unknown[]): Promise<QueryResult>;
  fetchTableData(
    connectionId: string,
    schema: string,
    name: string,
    options?: PageOptions,
  ): Promise<QueryResult>;
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
