import type {
  ConnectionConfig,
  ConnectionOverview,
  PageOptions,
  QueryResult,
  RelationInfo,
  RunQueryOptions,
  SchemaInfo,
  TableDetails,
  TestConnectionResult,
} from "@data-view/core";

/** Server-side connection that includes the decrypted password. */
export interface ResolvedConnection extends ConnectionConfig {
  password: string;
}

export interface DriverAdapter {
  testConnection(conn: ResolvedConnection): Promise<TestConnectionResult>;
  listSchemas(conn: ResolvedConnection): Promise<SchemaInfo[]>;
  listRelations(conn: ResolvedConnection, schema?: string): Promise<RelationInfo[]>;
  getConnectionOverview(conn: ResolvedConnection): Promise<ConnectionOverview>;
  describeTable(conn: ResolvedConnection, schema: string, name: string): Promise<TableDetails>;
  runQuery(
    conn: ResolvedConnection,
    sql: string,
    options?: RunQueryOptions,
  ): Promise<QueryResult>;
  fetchTableData(
    conn: ResolvedConnection,
    schema: string,
    name: string,
    options?: PageOptions,
  ): Promise<QueryResult>;
}
