import { invoke } from "@tauri-apps/api/core";
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
  Transport,
} from "@data-view/core";

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
  runQuery: (connectionId, sql, params) =>
    call<QueryResult>("run_query", { connectionId, sql, params }),
  fetchTableData: (connectionId, schema, name, options?: PageOptions) =>
    call<QueryResult>("fetch_table_data", { connectionId, schema, name, options }),
};
