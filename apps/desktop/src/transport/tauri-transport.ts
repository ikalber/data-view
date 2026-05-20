import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionOverview,
  CreateSchemaOptions,
  CreateTableOptions,
  ExportDatabaseOptions,
  ExportDatabaseResult,
  ExportFormat,
  ExportTableOptions,
  ExportTableResult,
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
  Transport,
} from "@data-view/core";
import { defaultExportFileName, EXPORT_FORMATS } from "@data-view/core";

/**
 * Each method maps 1:1 to a Tauri command defined in src-tauri/src/commands.rs.
 * Errors thrown by Rust come back as plain strings; we re-wrap as Error.
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

export const tauriTransport: Transport = {
  listConnections: () => call<ConnectionConfig[]>("list_connections"),
  getConnection: (id) => call<ConnectionConfig>("get_connection", { id }),
  saveConnection: (input: ConnectionInput) => call<ConnectionConfig>("save_connection", { input }),
  deleteConnection: (id) => call<void>("delete_connection", { id }),
  testConnection: (input: ConnectionInput) =>
    call<TestConnectionResult>("test_connection", { input }),
  listFolders: () => call<Folder[]>("list_folders"),
  saveFolder: (input: FolderInput) => call<Folder>("save_folder", { input }),
  deleteFolder: (id) => call<void>("delete_folder", { id }),
  listTags: () => call<Tag[]>("list_tags"),
  saveTag: (input: TagInput) => call<Tag>("save_tag", { input }),
  deleteTag: (id) => call<void>("delete_tag", { id }),
  listSchemas: (connectionId) => call<SchemaInfo[]>("list_schemas", { connectionId }),
  listRelations: (connectionId, schema) =>
    call<RelationInfo[]>("list_relations", { connectionId, schema }),
  getConnectionOverview: (connectionId) =>
    call<ConnectionOverview>("get_connection_overview", { connectionId }),
  describeTable: (connectionId, schema, name) =>
    call<TableDetails>("describe_table", { connectionId, schema, name }),
  runQuery: (connectionId, sql, options) =>
    // The Rust side doesn't honor `schema` yet — it's ignored downstream.
    call<QueryResult>("run_query", {
      connectionId,
      sql,
      params: options?.params,
      schema: options?.schema,
    }),
  fetchTableData: (connectionId, schema, name, options?: PageOptions) =>
    call<QueryResult>("fetch_table_data", { connectionId, schema, name, options }),
  exportTable: async (connectionId, schema, name, options: ExportTableOptions) => {
    const targetPath = await pickSaveLocation(name, options.format);
    if (!targetPath) throw new ExportCancelled();
    return call<ExportTableResult>("export_table", {
      connectionId,
      schema,
      name,
      options,
      targetPath,
    });
  },
  createSchema: (connectionId, options: CreateSchemaOptions) =>
    call<void>("create_schema", { connectionId, options }),
  createTable: (connectionId, options: CreateTableOptions) =>
    call<void>("create_table", { connectionId, options }),
  exportDatabase: async (connectionId, options: ExportDatabaseOptions) => {
    const targetPath = await pickSaveLocation("database", "sql");
    if (!targetPath) throw new ExportCancelled();
    return call<ExportDatabaseResult>("export_database", {
      connectionId,
      options,
      targetPath,
    });
  },
};

/**
 * Open an OS file picker for a `.sql` file and return its filename + contents.
 * Returns `null` if the user cancels the dialog. Used by the desktop app to
 * load a script from disk into a new SQL editor tab.
 */
export async function pickAndReadSqlFile(): Promise<{
  name: string;
  sql: string;
} | null> {
  const result = await open({
    multiple: false,
    filters: [
      { name: "SQL", extensions: ["sql"] },
      { name: "Texto", extensions: ["txt"] },
      { name: "Todos", extensions: ["*"] },
    ],
  });
  if (!result || Array.isArray(result)) return null;
  const path = result as string;
  const sql = await call<string>("read_text_file", { path });
  const base = path.split(/[\\/]/).pop() ?? "abierto.sql";
  return { name: base, sql };
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelado por el usuario");
    this.name = "ExportCancelled";
  }
}

async function pickSaveLocation(
  baseName: string,
  format: ExportFormat,
): Promise<string | null> {
  const suggested = defaultExportFileName(baseName, format);
  const ext = EXPORT_FORMATS.find((f) => f.value === format)?.ext ?? format;
  const result = await save({
    defaultPath: suggested,
    filters: [
      { name: format.toUpperCase(), extensions: [ext] },
      { name: "Todos", extensions: ["*"] },
    ],
  });
  return result;
}
