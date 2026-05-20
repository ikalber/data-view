import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionOverview,
  CreateSchemaOptions,
  CreateTableOptions,
  DropOptions,
  ExportDatabaseOptions,
  ExportDatabaseResult,
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

async function http<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (body && typeof body === "object" && "error" in body && body.error) || res.statusText;
    throw new Error(String(err));
  }
  return body as T;
}

export const webTransport: Transport = {
  listConnections: () => http<ConnectionConfig[]>("/api/connections"),
  getConnection: (id) => http<ConnectionConfig>(`/api/connections/${id}`),
  saveConnection: (input: ConnectionInput) =>
    http<ConnectionConfig>("/api/connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteConnection: (id) =>
    http<void>(`/api/connections/${id}`, { method: "DELETE" }) as unknown as Promise<void>,
  testConnection: (input: ConnectionInput) =>
    http<TestConnectionResult>("/api/connections/test", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listFolders: () => http<Folder[]>("/api/folders"),
  saveFolder: (input: FolderInput) =>
    http<Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteFolder: (id) =>
    http<void>(`/api/folders/${id}`, { method: "DELETE" }) as unknown as Promise<void>,
  listTags: () => http<Tag[]>("/api/tags"),
  saveTag: (input: TagInput) =>
    http<Tag>("/api/tags", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteTag: (id) =>
    http<void>(`/api/tags/${id}`, { method: "DELETE" }) as unknown as Promise<void>,
  listSchemas: (connectionId) => http<SchemaInfo[]>(`/api/connections/${connectionId}/schemas`),
  listRelations: (connectionId, schema) => {
    const qs = schema ? `?schema=${encodeURIComponent(schema)}` : "";
    return http<RelationInfo[]>(`/api/connections/${connectionId}/relations${qs}`);
  },
  getConnectionOverview: (connectionId) =>
    http<ConnectionOverview>(`/api/connections/${connectionId}/overview`),
  describeTable: (connectionId, schema, name) =>
    http<TableDetails>(
      `/api/connections/${connectionId}/describe?schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}`,
    ),
  runQuery: (connectionId, sql, options) =>
    http<QueryResult>(`/api/connections/${connectionId}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql,
        schema: options?.schema,
        params: options?.params,
      }),
    }),
  fetchTableData: (connectionId, schema, name, options?: PageOptions) =>
    http<QueryResult>(`/api/connections/${connectionId}/table-data`, {
      method: "POST",
      body: JSON.stringify({ schema, name, options }),
    }),
  exportTable: async (connectionId, schema, name, options: ExportTableOptions) => {
    const meta = await downloadExport(
      `/api/connections/${connectionId}/export-table`,
      { schema, name, options },
      options.format,
      name,
    );
    const out: ExportTableResult = {
      rowCount: 0,
      bytes: meta.bytes,
      durationMs: meta.durationMs,
      format: options.format,
      fileName: meta.fileName,
    };
    return out;
  },
  createSchema: (connectionId, options: CreateSchemaOptions) =>
    http<{ ok: true }>(`/api/connections/${connectionId}/databases`, {
      method: "POST",
      body: JSON.stringify(options),
    }) as unknown as Promise<void>,
  createTable: (connectionId, options: CreateTableOptions) =>
    http<{ ok: true }>(`/api/connections/${connectionId}/tables`, {
      method: "POST",
      body: JSON.stringify(options),
    }) as unknown as Promise<void>,
  dropTable: (connectionId, schema, name, options?: DropOptions) =>
    http<{ ok: true }>(`/api/connections/${connectionId}/ddl`, {
      method: "POST",
      body: JSON.stringify({
        action: "drop-table",
        schema,
        name,
        cascade: options?.cascade,
      }),
    }) as unknown as Promise<void>,
  dropSchema: (connectionId, name, options?: DropOptions) =>
    http<{ ok: true }>(`/api/connections/${connectionId}/ddl`, {
      method: "POST",
      body: JSON.stringify({
        action: "drop-schema",
        name,
        cascade: options?.cascade,
      }),
    }) as unknown as Promise<void>,
  truncateTable: (connectionId, schema, name, options?: DropOptions) =>
    http<{ ok: true }>(`/api/connections/${connectionId}/ddl`, {
      method: "POST",
      body: JSON.stringify({
        action: "truncate-table",
        schema,
        name,
        cascade: options?.cascade,
      }),
    }) as unknown as Promise<void>,
  exportDatabase: async (connectionId, options: ExportDatabaseOptions) => {
    const meta = await downloadExport(
      `/api/connections/${connectionId}/export-database`,
      { options },
      "sql",
      "database",
    );
    const out: ExportDatabaseResult = {
      bytes: meta.bytes,
      durationMs: meta.durationMs,
      tableCount: 0,
      rowCount: 0,
      fileName: meta.fileName,
    };
    return out;
  },
};

async function downloadExport(
  url: string,
  payload: unknown,
  defaultFormat: string,
  fallbackBase: string,
): Promise<{ bytes: number; durationMs: number; fileName: string }> {
  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let err = res.statusText;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) err = String(parsed.error);
    } catch {}
    throw new Error(err);
  }
  const filenameHeader = res.headers.get("X-Export-Filename") ?? `${fallbackBase}.${defaultFormat}`;
  const blob = await res.blob();
  const a = document.createElement("a");
  const objUrl = URL.createObjectURL(blob);
  a.href = objUrl;
  a.download = filenameHeader;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 0);
  return {
    bytes: blob.size,
    durationMs: Math.round(performance.now() - start),
    fileName: filenameHeader,
  };
}
