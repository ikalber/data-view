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
  runQuery: (connectionId, sql, params) =>
    http<QueryResult>(`/api/connections/${connectionId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    }),
  fetchTableData: (connectionId, schema, name, options?: PageOptions) =>
    http<QueryResult>(`/api/connections/${connectionId}/table-data`, {
      method: "POST",
      body: JSON.stringify({ schema, name, options }),
    }),
};
