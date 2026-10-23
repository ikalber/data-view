import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FileDropListener } from "@data-view/ui";
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionOverview,
  CreateIndexOptions,
  CreateSchemaOptions,
  CreateTableOptions,
  DropIndexOptions,
  DropOptions,
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
    // `schema` → search_path (Postgres) / USE (MySQL); ignored on SQL Server,
    // whose "schemas" live inside the connection's database. Bound `params`
    // aren't supported by the Rust drivers (the UI doesn't send any).
    call<QueryResult>("run_query", {
      connectionId,
      sql,
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
  dropTable: (connectionId, schema, name, options?: DropOptions) =>
    call<void>("drop_table", { connectionId, schema, name, options }),
  dropSchema: (connectionId, name, options?: DropOptions) =>
    call<void>("drop_schema", { connectionId, name, options }),
  truncateTable: (connectionId, schema, name, options?: DropOptions) =>
    call<void>("truncate_table", { connectionId, schema, name, options }),
  createIndex: (connectionId, options: CreateIndexOptions) =>
    call<void>("create_index", { connectionId, options }),
  dropIndex: (connectionId, options: DropIndexOptions) =>
    call<void>("drop_index", { connectionId, options }),
  saveTextFile: (suggestedName, contents) => saveTextFile(suggestedName, contents),
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
  return { name: baseName(path), sql: await readTextFile(path) };
}

/**
 * Subscribe to files dragged from the OS onto the window. Tauri intercepts
 * those drops before the page sees them (so HTML5 `drop` events never fire for
 * files) and hands us their paths, which we read from Rust on demand.
 * Returns the unsubscribe function.
 */
export function subscribeFileDrop(listener: FileDropListener): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      switch (payload.type) {
        case "enter":
          // Text or links dragged from another app arrive without paths.
          listener.onDragActive(payload.paths.length > 0);
          break;
        case "leave":
          listener.onDragActive(false);
          break;
        case "drop":
          listener.onDragActive(false);
          if (payload.paths.length === 0) break;
          listener.onDrop(
            payload.paths.map((path) => ({
              name: baseName(path),
              read: () => readTextFile(path),
            })),
          );
          break;
      }
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e) => console.error("No se pudo escuchar el arrastre de archivos", e));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || "abierto.sql";
}

/** Rust validates UTF-8 and sends the raw bytes; TextDecoder also drops a
 * leading BOM, which databases would otherwise reject as part of the SQL. */
async function readTextFile(path: string): Promise<string> {
  const data = await call<ArrayBuffer | number[]>("read_text_file", { path });
  // Raw responses arrive as an ArrayBuffer, except on the postMessage IPC
  // fallback, which serializes them as a plain array of bytes.
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return new TextDecoder().decode(bytes);
}

/**
 * Desktop replacement for a Blob + `<a download>` download (which the Tauri
 * webview cancels on macOS and silently drops into ~/Downloads on Linux):
 * asks where to save with the OS dialog and writes the text from Rust.
 * Returns the chosen path, or `null` if the user cancelled the dialog.
 */
export async function saveTextFile(
  suggestedName: string,
  contents: string,
): Promise<string | null> {
  const ext = suggestedName.includes(".")
    ? suggestedName.slice(suggestedName.lastIndexOf(".") + 1)
    : "";
  const path = await save({
    defaultPath: suggestedName,
    filters: ext
      ? [
          { name: ext.toUpperCase(), extensions: [ext] },
          { name: "Todos", extensions: ["*"] },
        ]
      : undefined,
  });
  if (!path) return null;
  await call<number>("write_text_file", { path, contents });
  return path;
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
