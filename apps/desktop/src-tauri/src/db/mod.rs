pub mod postgres;
pub mod mysql;
pub mod mssql;

use crate::error::{AppError, AppResult};
use crate::model::{
    ConnectionOverview, CreateSchemaOptions, CreateTableColumn, CreateTableOptions, DriverKind,
    DropOptions, PageOptions, QueryResult, RelationInfo, ResolvedConnection, SchemaInfo,
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

pub async fn get_connection_overview(conn: &ResolvedConnection) -> AppResult<ConnectionOverview> {
    match conn.driver {
        DriverKind::Postgres => postgres::get_connection_overview(conn).await,
        DriverKind::Mysql => mysql::get_connection_overview(conn).await,
        DriverKind::Mssql => mssql::get_connection_overview(conn).await,
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

pub async fn create_schema(
    conn: &ResolvedConnection,
    options: &CreateSchemaOptions,
) -> AppResult<()> {
    let name = options.name.trim();
    if name.is_empty() {
        return Err(AppError::msg("El nombre no puede estar vacío"));
    }
    let sql = match conn.driver {
        DriverKind::Postgres => {
            let mut s = format!("CREATE SCHEMA {}", pg_ident(name));
            if let Some(owner) = options.owner.as_deref().filter(|s| !s.is_empty()) {
                s.push_str(&format!(" AUTHORIZATION {}", pg_ident(owner)));
            }
            s
        }
        DriverKind::Mysql => {
            let mut s = format!("CREATE DATABASE {}", my_ident(name));
            if let Some(cs) = options.charset.as_deref().filter(|s| !s.is_empty()) {
                s.push_str(&format!(" CHARACTER SET {}", quote_lit(cs)));
            }
            if let Some(co) = options.collation.as_deref().filter(|s| !s.is_empty()) {
                s.push_str(&format!(" COLLATE {}", quote_lit(co)));
            }
            s
        }
        DriverKind::Mssql => format!("CREATE SCHEMA {}", ms_ident(name)),
    };
    run_query(conn, &sql).await.map(|_| ())
}

pub async fn create_table(
    conn: &ResolvedConnection,
    options: &CreateTableOptions,
) -> AppResult<()> {
    if options.schema.trim().is_empty() {
        return Err(AppError::msg("Schema/Database requerido"));
    }
    if options.name.trim().is_empty() {
        return Err(AppError::msg("Nombre de tabla requerido"));
    }
    if options.columns.is_empty() {
        return Err(AppError::msg("Agregá al menos una columna"));
    }
    let sql = build_create_table_sql(conn.driver.clone(), &options.schema, &options.name, &options.columns)?;
    run_query(conn, &sql).await.map(|_| ())
}

fn build_create_table_sql(
    driver: DriverKind,
    schema: &str,
    name: &str,
    columns: &[CreateTableColumn],
) -> AppResult<String> {
    let (ident_fn, nullable_keyword): (fn(&str) -> String, fn(bool) -> &'static str) = match driver {
        DriverKind::Postgres => (
            pg_ident,
            |nullable| if nullable { "" } else { "NOT NULL" },
        ),
        DriverKind::Mysql => (
            my_ident,
            |nullable| if nullable { "" } else { "NOT NULL" },
        ),
        // SQL Server is explicit about NULL/NOT NULL on every column.
        DriverKind::Mssql => (
            ms_ident,
            |nullable| if nullable { "NULL" } else { "NOT NULL" },
        ),
    };
    let mut col_lines = Vec::with_capacity(columns.len() + 1);
    for c in columns {
        if c.name.trim().is_empty() {
            return Err(AppError::msg("Hay una columna sin nombre"));
        }
        if c.data_type.trim().is_empty() {
            return Err(AppError::msg(format!("Falta el tipo de \"{}\"", c.name)));
        }
        let mut parts: Vec<String> = vec![ident_fn(&c.name), c.data_type.clone()];
        let nk = nullable_keyword(c.nullable);
        if !nk.is_empty() {
            parts.push(nk.to_string());
        }
        if let Some(def) = c.default.as_deref().filter(|s| !s.is_empty()) {
            parts.push(format!("DEFAULT {}", def));
        }
        col_lines.push(format!("  {}", parts.join(" ")));
    }
    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| ident_fn(&c.name))
        .collect();
    if !pk_cols.is_empty() {
        col_lines.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }
    Ok(format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        ident_fn(schema),
        ident_fn(name),
        col_lines.join(",\n")
    ))
}

pub async fn drop_table(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: &DropOptions,
) -> AppResult<()> {
    let (idfn, cascade_supported): (fn(&str) -> String, bool) = match conn.driver {
        DriverKind::Postgres => (pg_ident, true),
        DriverKind::Mysql => (my_ident, false),
        DriverKind::Mssql => (ms_ident, false),
    };
    let tail = if options.cascade && cascade_supported {
        " CASCADE"
    } else {
        ""
    };
    let sql = format!(
        "DROP TABLE IF EXISTS {}.{}{}",
        idfn(schema),
        idfn(name),
        tail
    );
    run_query(conn, &sql).await.map(|_| ())
}

pub async fn drop_schema(
    conn: &ResolvedConnection,
    name: &str,
    options: &DropOptions,
) -> AppResult<()> {
    let sql = match conn.driver {
        DriverKind::Postgres => {
            let tail = if options.cascade { " CASCADE" } else { "" };
            format!("DROP SCHEMA IF EXISTS {}{}", pg_ident(name), tail)
        }
        DriverKind::Mysql => format!("DROP DATABASE IF EXISTS {}", my_ident(name)),
        DriverKind::Mssql => format!("DROP SCHEMA IF EXISTS {}", ms_ident(name)),
    };
    run_query(conn, &sql).await.map(|_| ())
}

pub async fn truncate_table(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: &DropOptions,
) -> AppResult<()> {
    let (idfn, cascade_supported): (fn(&str) -> String, bool) = match conn.driver {
        DriverKind::Postgres => (pg_ident, true),
        DriverKind::Mysql => (my_ident, false),
        DriverKind::Mssql => (ms_ident, false),
    };
    let tail = if options.cascade && cascade_supported {
        " CASCADE"
    } else {
        ""
    };
    let sql = format!(
        "TRUNCATE TABLE {}.{}{}",
        idfn(schema),
        idfn(name),
        tail
    );
    run_query(conn, &sql).await.map(|_| ())
}

fn pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn my_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn ms_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn quote_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn unsupported(feature: &str) -> AppError {
    AppError::msg(format!("not implemented yet: {feature}"))
}
