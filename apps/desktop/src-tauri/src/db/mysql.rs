use super::common::{
    binary_value, float_value, int_value, parse_float_text, parse_int_text, uint_value,
    where_fragment, ResultCollector, RowSink,
};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ConnectionOverview, DatabaseSummary, ForeignKeyInfo, IndexInfo, PageOptions,
    QueryResult, QueryResultColumn, RelationInfo, RelationKind, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Opts, OptsBuilder, Row, SslOpts, Value as MyValue};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Charset id MySQL reports for binary strings / blobs.
const BINARY_CHARSET: u16 = 63;

async fn connect(c: &ResolvedConnection) -> AppResult<Conn> {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(c.host.clone())
        .tcp_port(c.port)
        .user(Some(c.username.clone()))
        .pass(Some(c.password.clone()))
        .db_name(if c.database.is_empty() {
            None
        } else {
            Some(c.database.clone())
        })
        // mysql_async otherwise re-connects through the server-reported unix
        // socket path when the host is local — which on a dockerized server
        // (or a second local instance) points at a *different* server.
        .prefer_socket(false);
    if c.ssl {
        // Encrypt without verifying the chain: MySQL ships self-signed certs
        // by default (same trade-off as the web driver's Postgres SSL).
        builder = builder.ssl_opts(SslOpts::default().with_danger_accept_invalid_certs(true));
    }
    let opts: Opts = builder.into();
    match tokio::time::timeout(Duration::from_secs(15), Conn::new(opts)).await {
        Ok(conn) => Ok(conn?),
        Err(_) => Err(AppError::msg(format!(
            "Tiempo de espera agotado conectando a {}:{}",
            c.host, c.port
        ))),
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// MySQL string literal (default sql_mode treats backslash as an escape).
fn quote_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// Non-panicking typed cell read (`Row::get` panics on conversion errors).
fn cell<T: FromValue>(row: &Row, idx: usize) -> Option<T> {
    row.get_opt::<Option<T>, _>(idx)
        .and_then(|r| r.ok())
        .flatten()
}

pub async fn test(c: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    let start = Instant::now();
    match connect(c).await {
        Ok(mut conn) => {
            let res: Result<Option<i64>, _> = conn.query_first("SELECT 1").await;
            let latency = start.elapsed().as_millis() as u64;
            let _ = conn.disconnect().await;
            match res {
                Ok(_) => Ok(TestConnectionResult {
                    ok: true,
                    message: "Conexión exitosa".into(),
                    latency_ms: Some(latency),
                }),
                Err(e) => Ok(TestConnectionResult {
                    ok: false,
                    message: AppError::from(e).to_string(),
                    latency_ms: None,
                }),
            }
        }
        Err(e) => Ok(TestConnectionResult {
            ok: false,
            message: e.to_string(),
            latency_ms: None,
        }),
    }
}

pub async fn list_schemas(c: &ResolvedConnection) -> AppResult<Vec<SchemaInfo>> {
    let mut conn = connect(c).await?;
    let rows: Vec<String> = conn.query("SHOW DATABASES").await?;
    let _ = conn.disconnect().await;
    let sys: std::collections::HashSet<&str> =
        ["information_schema", "mysql", "performance_schema", "sys"]
            .into_iter()
            .collect();
    Ok(rows
        .into_iter()
        .map(|name| {
            let is_system = sys.contains(name.as_str());
            SchemaInfo { name, is_system }
        })
        .collect())
}

pub async fn list_relations(
    c: &ResolvedConnection,
    schema: Option<&str>,
) -> AppResult<Vec<RelationInfo>> {
    let mut conn = connect(c).await?;
    let target = schema
        .map(String::from)
        .unwrap_or_else(|| c.database.clone());
    // table_rows / data_length / index_length are InnoDB statistics cached
    // until ANALYZE TABLE — close enough for an overview, NULL for views.
    let rows: Vec<Row> = conn
        .exec(
            "SELECT table_schema, table_name, table_type,
                    table_rows, data_length, index_length
             FROM information_schema.tables
             WHERE table_schema = ? ORDER BY table_name",
            (target,),
        )
        .await?;
    let _ = conn.disconnect().await;
    Ok(rows
        .iter()
        .map(|row| {
            let table_type: String = cell(row, 2).unwrap_or_default();
            let data_len: Option<u64> = cell(row, 4);
            let idx_len: Option<u64> = cell(row, 5);
            let total = match (data_len, idx_len) {
                (None, None) => None,
                (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
            };
            RelationInfo {
                schema: cell(row, 0).unwrap_or_default(),
                name: cell(row, 1).unwrap_or_default(),
                kind: if table_type == "VIEW" {
                    RelationKind::View
                } else {
                    RelationKind::Table
                },
                approx_row_count: cell(row, 3),
                total_bytes: total,
                data_bytes: data_len,
                index_bytes: idx_len,
            }
        })
        .collect())
}

pub async fn get_connection_overview(c: &ResolvedConnection) -> AppResult<ConnectionOverview> {
    let mut conn = connect(c).await?;
    let sys: std::collections::HashSet<&str> =
        ["information_schema", "mysql", "performance_schema", "sys"]
            .into_iter()
            .collect();

    let meta: Option<Row> = conn
        .query_first(
            "SELECT VERSION(), DATABASE(), CURRENT_USER(), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'), @@max_connections",
        )
        .await?;
    let (version, current_db, current_user, server_time, max_conn) = match meta.as_ref() {
        Some(r) => (
            cell::<String>(r, 0),
            cell::<String>(r, 1),
            cell::<String>(r, 2),
            cell::<String>(r, 3),
            cell::<u64>(r, 4),
        ),
        None => (None, None, None, None, None),
    };

    // Uptime via SHOW GLOBAL STATUS — wrap to survive missing privilege.
    let uptime: Option<u64> = match conn
        .query_first::<Row, _>("SHOW GLOBAL STATUS LIKE 'Uptime'")
        .await
    {
        Ok(Some(r)) => cell::<String>(&r, 1).and_then(|v| v.parse::<u64>().ok()),
        _ => None,
    };

    let db_rows: Vec<Row> = conn
        .query(
            "SELECT s.schema_name,
                    COALESCE(SUM(t.data_length + t.index_length), 0),
                    COUNT(t.table_name),
                    s.default_character_set_name
             FROM information_schema.schemata s
             LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
             GROUP BY s.schema_name, s.default_character_set_name
             ORDER BY s.schema_name",
        )
        .await
        .unwrap_or_default();

    let active: Option<u64> = conn
        .query_first::<Row, _>("SELECT COUNT(*) FROM information_schema.processlist")
        .await
        .ok()
        .flatten()
        .and_then(|r| cell::<u64>(&r, 0));

    let _ = conn.disconnect().await;

    let mut databases = Vec::with_capacity(db_rows.len());
    let mut total: u64 = 0;
    for row in db_rows {
        let name: String = cell(&row, 0).unwrap_or_default();
        let size = cell::<u64>(&row, 1).filter(|s| *s > 0);
        if let Some(s) = size {
            total = total.saturating_add(s);
        }
        let is_system = sys.contains(name.as_str());
        databases.push(DatabaseSummary {
            name,
            is_system,
            size_bytes: size,
            relation_count: cell(&row, 2),
            details: cell(&row, 3),
        });
    }

    Ok(ConnectionOverview {
        driver: "mysql".to_string(),
        server_version: version.map(|v| format!("MySQL {}", v)),
        current_database: current_db,
        current_user,
        server_time,
        uptime_seconds: uptime,
        total_size_bytes: if total > 0 { Some(total) } else { None },
        active_connections: active,
        max_connections: max_conn,
        databases,
    })
}

/// Types whose `column_default` is a bare number in information_schema.
fn is_numeric_data_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "float"
            | "double"
            | "real"
            | "bit"
            | "year"
            | "boolean"
            | "bool"
    )
}

/// information_schema.columns.column_default holds *literal* defaults
/// unquoted on MySQL (`abc`, not `'abc'`); only expression defaults
/// (DEFAULT_GENERATED) are SQL. Return a SQL expression so the structure
/// editor / DDL generators can paste it after `DEFAULT` as-is. MariaDB
/// already reports defaults as SQL expressions.
fn default_as_sql(
    default: Option<String>,
    data_type: &str,
    extra: &str,
    is_mariadb: bool,
) -> Option<String> {
    let d = default?;
    if is_mariadb
        || extra.to_ascii_uppercase().contains("DEFAULT_GENERATED")
        || is_numeric_data_type(data_type)
    {
        return Some(d);
    }
    Some(quote_lit(&d))
}

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let mut conn = connect(c).await?;
    let result = describe_table_on(&mut conn, schema, name).await;
    let _ = conn.disconnect().await;
    result
}

async fn describe_table_on(conn: &mut Conn, schema: &str, name: &str) -> AppResult<TableDetails> {
    let version: Option<String> = conn.query_first("SELECT VERSION()").await?;
    let is_mariadb = version
        .as_deref()
        .map(|v| v.to_ascii_lowercase().contains("mariadb"))
        .unwrap_or(false);
    let table_type: Option<String> = conn
        .exec_first(
            "SELECT table_type FROM information_schema.tables
             WHERE table_schema = ? AND table_name = ?",
            (schema, name),
        )
        .await?;
    let kind = if table_type.as_deref() == Some("VIEW") {
        RelationKind::View
    } else {
        RelationKind::Table
    };
    let rows: Vec<Row> = conn
        .exec(
            "SELECT column_name, column_type, is_nullable, column_key, column_default,
                    data_type, extra, column_comment
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            (schema, name),
        )
        .await?;
    let columns: Vec<ColumnInfo> = rows
        .iter()
        .map(|row| {
            let key: String = cell(row, 3).unwrap_or_default();
            let data_type: String = cell(row, 5).unwrap_or_default();
            let extra: String = cell(row, 6).unwrap_or_default();
            ColumnInfo {
                name: cell(row, 0).unwrap_or_default(),
                data_type: cell(row, 1).unwrap_or_default(),
                nullable: cell::<String>(row, 2).as_deref() == Some("YES"),
                is_primary_key: key == "PRI",
                is_unique: key == "UNI",
                default: default_as_sql(cell(row, 4), &data_type, &extra, is_mariadb),
                comment: cell::<String>(row, 7).filter(|s| !s.is_empty()),
            }
        })
        .collect();
    // Indexes — group rows by index name. column_name is NULL for functional
    // (expression) indexes.
    let idx_rows: Vec<Row> = conn
        .exec(
            "SELECT index_name, non_unique, column_name, seq_in_index
             FROM information_schema.statistics
             WHERE table_schema = ? AND table_name = ?
             ORDER BY index_name, seq_in_index",
            (schema, name),
        )
        .await?;
    let mut idx_map: BTreeMap<String, IndexInfo> = BTreeMap::new();
    for row in idx_rows.iter() {
        let idx_name: String = cell(row, 0).unwrap_or_default();
        let non_unique: i64 = cell(row, 1).unwrap_or(1);
        let col_name: String = cell(row, 2).unwrap_or_else(|| "(expr)".to_string());
        let entry = idx_map
            .entry(idx_name.clone())
            .or_insert_with(|| IndexInfo {
                name: idx_name.clone(),
                columns: Vec::new(),
                unique: non_unique == 0,
                primary: idx_name == "PRIMARY",
            });
        entry.columns.push(col_name);
    }
    let mut indexes: Vec<IndexInfo> = idx_map.into_values().collect();
    indexes.sort_by(|a, b| {
        b.primary
            .cmp(&a.primary)
            .then(b.unique.cmp(&a.unique))
            .then(a.name.cmp(&b.name))
    });
    // Foreign keys — one row per (constraint, column), grouped here so column
    // names containing commas survive (GROUP_CONCAT + split wouldn't).
    let fk_rows: Vec<Row> = conn
        .exec(
            "SELECT kcu.constraint_name, kcu.column_name,
                    kcu.referenced_table_schema, kcu.referenced_table_name,
                    kcu.referenced_column_name, rc.update_rule, rc.delete_rule
             FROM information_schema.key_column_usage kcu
             JOIN information_schema.referential_constraints rc
               ON rc.constraint_schema = kcu.constraint_schema
              AND rc.constraint_name = kcu.constraint_name
              AND rc.table_name = kcu.table_name
             WHERE kcu.table_schema = ? AND kcu.table_name = ?
               AND kcu.referenced_table_name IS NOT NULL
             ORDER BY kcu.constraint_name, kcu.ordinal_position",
            (schema, name),
        )
        .await?;
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    for row in fk_rows.iter() {
        let fk_name: String = cell(row, 0).unwrap_or_default();
        let col: String = cell(row, 1).unwrap_or_default();
        let ref_col: String = cell(row, 4).unwrap_or_default();
        match foreign_keys.last_mut() {
            Some(fk) if fk.name == fk_name => {
                fk.columns.push(col);
                fk.referenced_columns.push(ref_col);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name: fk_name,
                columns: vec![col],
                referenced_schema: cell(row, 2).unwrap_or_default(),
                referenced_table: cell(row, 3).unwrap_or_default(),
                referenced_columns: vec![ref_col],
                on_update: cell::<String>(row, 5).filter(|s| !s.is_empty()),
                on_delete: cell::<String>(row, 6).filter(|s| !s.is_empty()),
            }),
        }
    }
    Ok(TableDetails {
        schema: schema.into(),
        name: name.into(),
        kind,
        columns,
        indexes,
        foreign_keys,
    })
}

/// `SHOW CREATE TABLE` output (exact DDL incl. AUTO_INCREMENT, indexes, FKs,
/// engine/charset) — used by the database dump.
pub async fn show_create_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<Option<String>> {
    let mut conn = connect(c).await?;
    let row: AppResult<Option<Row>> = conn
        .query_first(format!(
            "SHOW CREATE TABLE {}.{}",
            ident(schema),
            ident(name)
        ))
        .await
        .map_err(AppError::from);
    let _ = conn.disconnect().await;
    Ok(row?.and_then(|r| cell::<String>(&r, 1)))
}

pub async fn run_query(
    c: &ResolvedConnection,
    sql: &str,
    schema: Option<&str>,
) -> AppResult<QueryResult> {
    let start = Instant::now();
    let mut conn = connect(c).await?;
    let result = run_query_on(&mut conn, sql, schema, start).await;
    let _ = conn.disconnect().await;
    result
}

async fn run_query_on(
    conn: &mut Conn,
    sql: &str,
    schema: Option<&str>,
    start: Instant,
) -> AppResult<QueryResult> {
    if let Some(s) = schema.filter(|s| !s.is_empty()) {
        conn.query_drop(format!("USE {}", ident(s))).await?;
    }
    let mut result = conn.query_iter(sql).await?;
    let mut collector = ResultCollector::new(start);
    loop {
        let columns = match result.columns() {
            Some(cols) => cols,
            None => {
                // No pending result — or an error from a later statement of a
                // multi-statement script, which `next()` surfaces.
                result.next().await?;
                break;
            }
        };
        if columns.is_empty() {
            // OK packet of a DML/DDL statement.
            collector.add_affected(result.affected_rows());
            result.next().await?;
            continue;
        }
        collector.begin_set(columns.iter().map(column_info).collect());
        while let Some(row) = result.next().await? {
            if collector.wants_row() {
                collector.push_row(row_to_json(&row, &columns));
            } else {
                collector.skip_row();
            }
        }
        collector.end_set();
    }
    Ok(collector.finish())
}

pub async fn fetch_table_data(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: &PageOptions,
) -> AppResult<QueryResult> {
    let limit = options.limit.unwrap_or(100).min(QUERY_LIMIT as u32);
    let offset = options.offset.unwrap_or(0);
    let order = options
        .order_by
        .as_ref()
        .filter(|cols| !cols.is_empty())
        .map(|cols| {
            let parts: Vec<String> = cols
                .iter()
                .map(|o| {
                    let dir = if o.direction.eq_ignore_ascii_case("desc") {
                        "DESC"
                    } else {
                        "ASC"
                    };
                    format!("{} {}", ident(&o.column), dir)
                })
                .collect();
            format!("ORDER BY {}", parts.join(", "))
        })
        .unwrap_or_default();
    let sql = format!(
        "SELECT * FROM {}.{} {} {} LIMIT {} OFFSET {}",
        ident(schema),
        ident(name),
        where_fragment(options.where_clause.as_deref()),
        order,
        limit,
        offset
    );
    run_query(c, &sql, None).await
}

/// Stream every row of a table into `sink` with a single (row-by-row) query.
pub async fn stream_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
    where_clause: Option<&str>,
    sink: &mut dyn RowSink,
) -> AppResult<()> {
    let mut conn = connect(c).await?;
    let sql = format!(
        "SELECT * FROM {}.{} {}",
        ident(schema),
        ident(name),
        where_fragment(where_clause)
    );
    let result = async {
        let mut result = conn.query_iter(sql).await?;
        let columns = result.columns().unwrap_or_else(|| Vec::new().into());
        sink.columns(&columns.iter().map(column_info).collect::<Vec<_>>())?;
        while let Some(row) = result.next().await? {
            sink.row(row_to_json(&row, &columns))?;
        }
        AppResult::Ok(())
    }
    .await;
    let _ = conn.disconnect().await;
    result
}

fn is_binary(col: &Column) -> bool {
    use ColumnType::*;
    match col.column_type() {
        MYSQL_TYPE_GEOMETRY => true,
        MYSQL_TYPE_TINY_BLOB
        | MYSQL_TYPE_MEDIUM_BLOB
        | MYSQL_TYPE_LONG_BLOB
        | MYSQL_TYPE_BLOB
        | MYSQL_TYPE_VAR_STRING
        | MYSQL_TYPE_STRING
        | MYSQL_TYPE_VARCHAR => col.character_set() == BINARY_CHARSET,
        _ => false,
    }
}

fn column_info(col: &Column) -> QueryResultColumn {
    QueryResultColumn {
        name: col.name_str().to_string(),
        data_type: type_name(col).to_string(),
    }
}

fn type_name(col: &Column) -> &'static str {
    use ColumnType::*;
    let binary = is_binary(col);
    match col.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_NULL => "null",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        _ => "unknown",
    }
}

fn row_to_json(row: &Row, columns: &[Column]) -> Vec<Value> {
    (0..row.len())
        .map(|i| match (row.as_ref(i), columns.get(i)) {
            (Some(v), Some(col)) => myvalue_to_json(v, col),
            (Some(v), None) => myvalue_to_json_untyped(v),
            (None, _) => Value::Null,
        })
        .collect()
}

/// Text-protocol values arrive as bytes; interpret them with the column type.
fn myvalue_to_json(v: &MyValue, col: &Column) -> Value {
    use ColumnType::*;
    let MyValue::Bytes(bytes) = v else {
        return myvalue_to_json_untyped(v);
    };
    match col.column_type() {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_INT24
        | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => parse_int_text(&String::from_utf8_lossy(bytes)),
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => parse_float_text(&String::from_utf8_lossy(bytes)),
        MYSQL_TYPE_BIT => {
            // BIT(n) comes as big-endian raw bytes.
            if bytes.len() <= 8 {
                uint_value(bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64))
            } else {
                binary_value(bytes.len())
            }
        }
        _ if is_binary(col) => binary_value(bytes.len()),
        _ => Value::String(String::from_utf8_lossy(bytes).into_owned()),
    }
}

fn myvalue_to_json_untyped(v: &MyValue) -> Value {
    match v {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(b) => match std::str::from_utf8(b) {
            Ok(s) => Value::String(s.to_string()),
            Err(_) => binary_value(b.len()),
        },
        MyValue::Int(i) => int_value(*i),
        MyValue::UInt(u) => uint_value(*u),
        MyValue::Float(f) => float_value(*f as f64),
        MyValue::Double(f) => float_value(*f),
        MyValue::Date(y, m, d, h, mi, s, us) => {
            if *h == 0 && *mi == 0 && *s == 0 && *us == 0 {
                Value::String(format!("{:04}-{:02}-{:02}", y, m, d))
            } else if *us == 0 {
                Value::String(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    y, m, d, h, mi, s
                ))
            } else {
                Value::String(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                    y, m, d, h, mi, s, us
                ))
            }
        }
        MyValue::Time(neg, days, h, m, s, us) => {
            let hours = *days as u64 * 24 + *h as u64;
            let sign = if *neg { "-" } else { "" };
            if *us == 0 {
                Value::String(format!("{sign}{:02}:{:02}:{:02}", hours, m, s))
            } else {
                Value::String(format!("{sign}{:02}:{:02}:{:02}.{:06}", hours, m, s, us))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_defaults_get_quoted() {
        assert_eq!(
            default_as_sql(Some("abc".into()), "varchar", "", false),
            Some("'abc'".into())
        );
        assert_eq!(
            default_as_sql(Some("C:\\x 'q'".into()), "varchar", "", false),
            Some("'C:\\\\x ''q'''".into())
        );
        assert_eq!(
            default_as_sql(Some("0".into()), "int", "", false),
            Some("0".into())
        );
        assert_eq!(
            default_as_sql(
                Some("CURRENT_TIMESTAMP".into()),
                "timestamp",
                "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
                false
            ),
            Some("CURRENT_TIMESTAMP".into())
        );
        assert_eq!(
            default_as_sql(Some("'abc'".into()), "varchar", "", true),
            Some("'abc'".into())
        );
        assert_eq!(default_as_sql(None, "varchar", "", false), None);
    }
}
