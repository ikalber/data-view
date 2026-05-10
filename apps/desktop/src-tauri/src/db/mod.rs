pub mod postgres;
pub mod mysql;
pub mod mssql;

use crate::error::{AppError, AppResult};
use crate::model::{
    DriverKind, PageOptions, QueryResult, RelationInfo, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult,
};

pub async fn test(conn: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    match conn.driver {
        DriverKind::Postgres => postgres::test(conn).await,
        DriverKind::Mysql => mysql::test(conn).await,
        DriverKind::Mssql => mssql::test(conn).await,
    }
}

pub async fn list_schemas(conn: &ResolvedConnection) -> AppResult<Vec<SchemaInfo>> {
    match conn.driver {
        DriverKind::Postgres => postgres::list_schemas(conn).await,
        DriverKind::Mysql => mysql::list_schemas(conn).await,
        DriverKind::Mssql => mssql::list_schemas(conn).await,
    }
}

pub async fn list_relations(
    conn: &ResolvedConnection,
    schema: Option<&str>,
) -> AppResult<Vec<RelationInfo>> {
    match conn.driver {
        DriverKind::Postgres => postgres::list_relations(conn, schema).await,
        DriverKind::Mysql => mysql::list_relations(conn, schema).await,
        DriverKind::Mssql => mssql::list_relations(conn, schema).await,
    }
}

pub async fn describe_table(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    match conn.driver {
        DriverKind::Postgres => postgres::describe_table(conn, schema, name).await,
        DriverKind::Mysql => mysql::describe_table(conn, schema, name).await,
        DriverKind::Mssql => mssql::describe_table(conn, schema, name).await,
    }
}

pub async fn run_query(conn: &ResolvedConnection, sql: &str) -> AppResult<QueryResult> {
    match conn.driver {
        DriverKind::Postgres => postgres::run_query(conn, sql).await,
        DriverKind::Mysql => mysql::run_query(conn, sql).await,
        DriverKind::Mssql => mssql::run_query(conn, sql).await,
    }
}

pub async fn fetch_table_data(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: &PageOptions,
) -> AppResult<QueryResult> {
    match conn.driver {
        DriverKind::Postgres => postgres::fetch_table_data(conn, schema, name, options).await,
        DriverKind::Mysql => mysql::fetch_table_data(conn, schema, name, options).await,
        DriverKind::Mssql => mssql::fetch_table_data(conn, schema, name, options).await,
    }
}

pub fn unsupported(feature: &str) -> AppError {
    AppError::msg(format!("not implemented yet: {feature}"))
}
