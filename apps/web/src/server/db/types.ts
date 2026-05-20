import type {
  ColumnInfo,
  ConnectionConfig,
  ConnectionOverview,
  CreateSchemaOptions,
  CreateTableOptions,
  PageOptions,
  QueryResult,
  QueryResultColumn,
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

export interface TableBatch {
  columns: QueryResultColumn[];
  rows: QueryResult["rows"];
}

export interface IterateTableOptions {
  schema: string;
  name: string;
  where?: string;
  /** Rows per chunk. Defaults driver-specific. */
  batchSize?: number;
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

  /**
   * Iterate every row of a table in chunks. The async generator MUST keep the
   * connection open until the caller stops consuming, so callers should always
   * drain the iterator (`for await … of`) and break on errors.
   *
   * The first yielded batch carries the canonical column list; subsequent
   * batches may omit / reuse it (callers should rely on the first).
   */
  iterateTable(
    conn: ResolvedConnection,
    opts: IterateTableOptions,
  ): AsyncIterable<TableBatch>;

  /**
   * Render a `CREATE TABLE` statement for the given table using the driver's
   * native dialect. Includes columns, NULL/NOT NULL, defaults, and the PRIMARY
   * KEY constraint. Foreign keys and indexes are intentionally omitted —
   * adding them needs the schema for *other* tables to already exist.
   */
  generateCreateTableSql(
    conn: ResolvedConnection,
    schema: string,
    name: string,
    columns: ColumnInfo[],
  ): string;

  createSchema(conn: ResolvedConnection, options: CreateSchemaOptions): Promise<void>;
  createTable(conn: ResolvedConnection, options: CreateTableOptions): Promise<void>;
}
