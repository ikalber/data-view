use super::common::{
    binary_value, mark_unique_columns, parse_float_text, parse_int_text, where_fragment,
    ResultCollector, RowSink,
};
use super::pg_tls::MakeRustlsConnect;
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ConnectionOverview, DatabaseSummary, ForeignKeyInfo, IndexInfo, PageOptions,
    QueryResult, QueryResultColumn, RelationInfo, RelationKind, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use futures::TryStreamExt;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage, SimpleQueryRow};

async fn connect(c: &ResolvedConnection) -> AppResult<Client> {
    // Build the config field by field: a hand-formatted "key=value" string
    // breaks as soon as a password/user/database contains spaces or quotes.
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&c.host)
        .port(c.port)
        .user(&c.username)
        .password(c.password.as_bytes())
        .application_name("data-view")
        .connect_timeout(Duration::from_secs(15));
    if !c.database.is_empty() {
        cfg.dbname(&c.database);
    }
    if c.ssl {
        // sslmode=require: encrypt, fail if the server doesn't offer TLS.
        cfg.ssl_mode(SslMode::Require);
        let tls = MakeRustlsConnect::new()
            .map_err(|e| AppError::msg(format!("No se pudo inicializar TLS: {e}")))?;
        let (client, conn) = cfg.connect(tls).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    } else {
        cfg.ssl_mode(SslMode::Disable);
        let (client, conn) = cfg.connect(NoTls).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    }
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub async fn test(c: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    let start = Instant::now();
    match connect(c).await {
        Ok(client) => match client.simple_query("SELECT 1").await {
            Ok(_) => Ok(TestConnectionResult {
                ok: true,
                message: "Conexión exitosa".into(),
                latency_ms: Some(start.elapsed().as_millis() as u64),
            }),
            Err(e) => Ok(TestConnectionResult {
                ok: false,
                message: AppError::from(e).to_string(),
                latency_ms: None,
            }),
        },
        Err(e) => Ok(TestConnectionResult {
            ok: false,
            message: e.to_string(),
            latency_ms: None,
        }),
    }
}

pub async fn list_schemas(c: &ResolvedConnection) -> AppResult<Vec<SchemaInfo>> {
    let client = connect(c).await?;
    let rows = client
        .query(
            "SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name",
            &[],
        )
        .await?;
    let result = rows
        .into_iter()
        .map(|row| {
            let name: String = row.get(0);
            let is_system = name.starts_with("pg_") || name == "information_schema";
            SchemaInfo { name, is_system }
        })
        .collect();
    Ok(result)
}

pub async fn list_relations(
    c: &ResolvedConnection,
    schema: Option<&str>,
) -> AppResult<Vec<RelationInfo>> {
    let client = connect(c).await?;
    // pg_total_relation_size includes heap + indexes + toast; pg_relation_size
    // is heap only; pg_indexes_size sums secondary indexes. Views/foreign
    // tables get NULL — UI renders missing values as "—".
    let sql = "SELECT n.nspname, c.relname, c.relkind::text,
                      CASE WHEN c.relkind IN ('r','m','p') AND c.reltuples >= 0
                           THEN c.reltuples::bigint END AS approx_rows,
                      CASE WHEN c.relkind IN ('r','m','p')
                           THEN pg_total_relation_size(c.oid) END AS total_bytes,
                      CASE WHEN c.relkind IN ('r','m','p')
                           THEN pg_relation_size(c.oid) END AS data_bytes,
                      CASE WHEN c.relkind IN ('r','m','p')
                           THEN pg_indexes_size(c.oid) END AS index_bytes
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('r','v','m','p')
                 AND ($1::text IS NULL OR n.nspname = $1)
               ORDER BY n.nspname, c.relname";
    let rows = client.query(sql, &[&schema]).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let s: String = row.get(0);
        let n: String = row.get(1);
        let kind: String = row.get(2);
        let approx_rows: Option<i64> = row.try_get(3).ok();
        let total_bytes: Option<i64> = row.try_get(4).ok();
        let data_bytes: Option<i64> = row.try_get(5).ok();
        let index_bytes: Option<i64> = row.try_get(6).ok();
        let kind = match kind.as_str() {
            "v" => RelationKind::View,
            "m" => RelationKind::MaterializedView,
            _ => RelationKind::Table,
        };
        out.push(RelationInfo {
            schema: s,
            name: n,
            kind,
            approx_row_count: non_negative(approx_rows),
            total_bytes: non_negative(total_bytes),
            data_bytes: non_negative(data_bytes),
            index_bytes: non_negative(index_bytes),
        });
    }
    Ok(out)
}

fn non_negative(v: Option<i64>) -> Option<u64> {
    v.and_then(|n| if n >= 0 { Some(n as u64) } else { None })
}

pub async fn get_connection_overview(c: &ResolvedConnection) -> AppResult<ConnectionOverview> {
    let client = connect(c).await?;
    let meta = client
        .query_one(
            "SELECT version(),
                    current_database(),
                    current_user::text,
                    -- ISO-8601 UTC: WebKit's Date() rejects Postgres' text form.
                    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint",
            &[],
        )
        .await?;
    let server_version: Option<String> = meta.try_get(0).ok();
    let current_database: Option<String> = meta.try_get(1).ok();
    let current_user: Option<String> = meta.try_get(2).ok();
    let server_time: Option<String> = meta.try_get(3).ok();
    let uptime_seconds: Option<i64> = meta.try_get(4).ok();

    let db_rows = client
        .query(
            "SELECT d.datname,
                    CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                         THEN pg_database_size(d.datname) END,
                    d.datistemplate
             FROM pg_database d
             WHERE NOT d.datistemplate OR d.datname IN ('template0', 'template1')
             ORDER BY d.datname",
            &[],
        )
        .await?;

    let active: Option<i64> = client
        .query_one(
            "SELECT count(*)::bigint FROM pg_stat_activity WHERE state IS NOT NULL",
            &[],
        )
        .await
        .ok()
        .and_then(|r| r.try_get(0).ok());

    let max_conn: Option<i64> = client
        .query_one(
            "SELECT setting::bigint FROM pg_settings WHERE name = 'max_connections'",
            &[],
        )
        .await
        .ok()
        .and_then(|r| r.try_get(0).ok());

    let mut databases = Vec::with_capacity(db_rows.len());
    let mut total_size: u64 = 0;
    for row in db_rows {
        let name: String = row.get(0);
        let size: Option<i64> = row.try_get(1).ok();
        let is_template: bool = row.try_get(2).unwrap_or(false);
        let size_bytes = size.and_then(|s| if s >= 0 { Some(s as u64) } else { None });
        if let Some(s) = size_bytes {
            total_size = total_size.saturating_add(s);
        }
        let is_system = is_template || name == "postgres";
        databases.push(DatabaseSummary {
            name,
            is_system,
            size_bytes,
            relation_count: None,
            details: None,
        });
    }

    Ok(ConnectionOverview {
        driver: "postgres".to_string(),
        server_version,
        current_database,
        current_user,
        server_time,
        uptime_seconds: uptime_seconds.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
        total_size_bytes: if total_size > 0 {
            Some(total_size)
        } else {
            None
        },
        active_connections: active.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
        max_connections: max_conn.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
        databases,
    })
}

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let client = connect(c).await?;
    let kind = client
        .query_opt(
            "SELECT c.relkind::text
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        )
        .await?
        .map(|r| r.get::<_, String>(0));
    let kind = match kind.as_deref() {
        Some("v") => RelationKind::View,
        Some("m") => RelationKind::MaterializedView,
        _ => RelationKind::Table,
    };
    let sql = "SELECT a.attname,
                      pg_catalog.format_type(a.atttypid, a.atttypmod),
                      a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid),
                      EXISTS (SELECT 1 FROM pg_index i
                              WHERE i.indisprimary AND i.indrelid = c.oid
                                AND a.attnum = ANY(i.indkey)) AS is_pk,
                      col_description(c.oid, a.attnum)
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
               ORDER BY a.attnum";
    let rows = client.query(sql, &[&schema, &name]).await?;
    let mut columns: Vec<ColumnInfo> = rows
        .into_iter()
        .map(|row| {
            let notnull: bool = row.get(2);
            ColumnInfo {
                name: row.get(0),
                data_type: row.get(1),
                nullable: !notnull,
                is_primary_key: row.get(4),
                is_unique: false,
                default: row.get(3),
                comment: row.get(5),
            }
        })
        .collect();
    // Indexes. Plain columns resolve to their attname (pg_get_indexdef would
    // return them quoted when they're mixed-case); expressions use the def.
    let idx_rows = client
        .query(
            "SELECT ic.relname AS name,
                    i.indisunique AS is_unique,
                    i.indisprimary AS is_primary,
                    ARRAY(
                      SELECT CASE WHEN i.indkey[k] = 0
                                  THEN pg_get_indexdef(i.indexrelid, k + 1, true)
                                  ELSE (SELECT a.attname::text FROM pg_attribute a
                                        WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[k])
                             END
                      FROM generate_subscripts(i.indkey, 1) AS k
                      ORDER BY k
                    ) AS columns
             FROM pg_index i
             JOIN pg_class ic ON ic.oid = i.indexrelid
             JOIN pg_class tc ON tc.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = tc.relnamespace
             WHERE n.nspname = $1 AND tc.relname = $2
             ORDER BY i.indisprimary DESC, i.indisunique DESC, ic.relname",
            &[&schema, &name],
        )
        .await?;
    let indexes: Vec<IndexInfo> = idx_rows
        .into_iter()
        .map(|row| IndexInfo {
            name: row.get(0),
            unique: row.get(1),
            primary: row.get(2),
            columns: row.get(3),
        })
        .collect();
    mark_unique_columns(&mut columns, &indexes);

    // Foreign keys — single query resolves both column arrays.
    let fk_rows = client
        .query(
            "SELECT
               c.conname,
               ARRAY(
                 SELECT a.attname
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                 ORDER BY k.ord
               ) AS local_cols,
               n2.nspname AS ref_schema,
               c2.relname AS ref_table,
               ARRAY(
                 SELECT a.attname
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                 ORDER BY k.ord
               ) AS ref_cols,
               CASE c.confupdtype
                 WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                 WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                 WHEN 'd' THEN 'SET DEFAULT' END,
               CASE c.confdeltype
                 WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                 WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                 WHEN 'd' THEN 'SET DEFAULT' END
             FROM pg_constraint c
             JOIN pg_class cls ON cls.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = cls.relnamespace
             JOIN pg_class c2 ON c2.oid = c.confrelid
             JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
             WHERE c.contype = 'f' AND n.nspname = $1 AND cls.relname = $2
             ORDER BY c.conname",
            &[&schema, &name],
        )
        .await?;
    let foreign_keys = fk_rows
        .into_iter()
        .map(|row| {
            let fkname: String = row.get(0);
            let local: Vec<String> = row.get(1);
            let rs: String = row.get(2);
            let rt: String = row.get(3);
            let refc: Vec<String> = row.get(4);
            let on_update: Option<String> = row.try_get(5).ok();
            let on_delete: Option<String> = row.try_get(6).ok();
            ForeignKeyInfo {
                name: fkname,
                columns: local,
                referenced_schema: rs,
                referenced_table: rt,
                referenced_columns: refc,
                on_update,
                on_delete,
            }
        })
        .collect();
    Ok(TableDetails {
        schema: schema.into(),
        name: name.into(),
        kind,
        columns,
        indexes,
        foreign_keys,
    })
}

/// Run an arbitrary SQL script.
///
/// We execute through the *simple query* protocol so multi-statement scripts
/// work (the extended protocol rejects them) and every value arrives in
/// Postgres' canonical text form — which is exactly what psql shows and is
/// round-trippable when the UI builds UPDATE/WHERE literals from it. Column
/// types come from a `prepare` of the same SQL; when that fails (multiple
/// statements) values are kept as text.
pub async fn run_query(
    c: &ResolvedConnection,
    sql: &str,
    schema: Option<&str>,
) -> AppResult<QueryResult> {
    let start = Instant::now();
    let client = connect(c).await?;
    if let Some(s) = schema.filter(|s| !s.is_empty()) {
        // search_path is per-session — safe on this short-lived connection.
        client
            .batch_execute(&format!("SET search_path TO {}, public", ident(s)))
            .await?;
    }
    let types: Option<Vec<Type>> = match client.prepare(sql).await {
        Ok(stmt) => Some(stmt.columns().iter().map(|c| c.type_().clone()).collect()),
        Err(_) => None,
    };
    let stream = client.simple_query_raw(sql).await?;
    futures::pin_mut!(stream);
    let mut collector = ResultCollector::new(start);
    let mut current_types: Vec<Option<Type>> = Vec::new();
    while let Some(msg) = stream.try_next().await? {
        match msg {
            SimpleQueryMessage::RowDescription(cols) => {
                current_types = cols
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        types
                            .as_ref()
                            .filter(|t| t.len() == cols.len())
                            .map(|t| t[i].clone())
                    })
                    .collect();
                collector.begin_set(
                    cols.iter()
                        .zip(current_types.iter())
                        .map(|(col, ty)| QueryResultColumn {
                            name: col.name().to_string(),
                            data_type: ty
                                .as_ref()
                                .map(|t| t.name().to_string())
                                .unwrap_or_else(|| "text".to_string()),
                        })
                        .collect(),
                );
            }
            SimpleQueryMessage::Row(row) => {
                if collector.wants_row() {
                    collector.push_row(simple_row_to_json(&row, &current_types));
                } else {
                    collector.skip_row();
                }
            }
            SimpleQueryMessage::CommandComplete(n) => {
                if collector.has_current_set() {
                    collector.end_set();
                } else {
                    collector.add_affected(n);
                }
            }
            _ => {}
        }
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
    let order_by = options
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
        order_by,
        limit,
        offset
    );
    run_query(c, &sql, None).await
}

/// Stream every row of a table (optionally filtered) into `sink` with a single
/// query — no OFFSET paging, constant memory.
pub async fn stream_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
    where_clause: Option<&str>,
    sink: &mut dyn RowSink,
) -> AppResult<()> {
    let client = connect(c).await?;
    let sql = format!(
        "SELECT * FROM {}.{} {}",
        ident(schema),
        ident(name),
        where_fragment(where_clause)
    );
    let stmt = client.prepare(&sql).await?;
    let types: Vec<Option<Type>> = stmt
        .columns()
        .iter()
        .map(|c| Some(c.type_().clone()))
        .collect();
    let columns: Vec<QueryResultColumn> = stmt
        .columns()
        .iter()
        .map(|col| QueryResultColumn {
            name: col.name().to_string(),
            data_type: col.type_().name().to_string(),
        })
        .collect();
    sink.columns(&columns)?;
    let stream = client.simple_query_raw(&sql).await?;
    futures::pin_mut!(stream);
    while let Some(msg) = stream.try_next().await? {
        if let SimpleQueryMessage::Row(row) = msg {
            sink.row(simple_row_to_json(&row, &types))?;
        }
    }
    Ok(())
}

fn simple_row_to_json(row: &SimpleQueryRow, types: &[Option<Type>]) -> Vec<Value> {
    (0..row.len())
        .map(|i| match row.try_get(i) {
            Ok(Some(text)) => text_to_json(text, types.get(i).and_then(|t| t.as_ref())),
            _ => Value::Null,
        })
        .collect()
}

/// Convert Postgres' text representation of a value into a `CellValue`.
/// Unknown/complex types (numeric, dates, arrays, enums, ranges, inet, …)
/// stay as their canonical text.
fn text_to_json(text: &str, ty: Option<&Type>) -> Value {
    let Some(ty) = ty else {
        return Value::String(text.to_string());
    };
    if let Kind::Domain(inner) = ty.kind() {
        return text_to_json(text, Some(inner));
    }
    match *ty {
        Type::BOOL => match text {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            other => Value::String(other.to_string()),
        },
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => parse_int_text(text),
        Type::FLOAT4 | Type::FLOAT8 => parse_float_text(text),
        Type::BYTEA => {
            // Default bytea_output=hex: "\x" + 2 chars per byte.
            let len = match text.strip_prefix("\\x") {
                Some(hex) => hex.len() / 2,
                None => text.len(),
            };
            binary_value(len)
        }
        _ => Value::String(text.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_conversion_by_type() {
        assert_eq!(text_to_json("t", Some(&Type::BOOL)), json!(true));
        assert_eq!(text_to_json("f", Some(&Type::BOOL)), json!(false));
        assert_eq!(text_to_json("42", Some(&Type::INT4)), json!(42));
        assert_eq!(
            text_to_json("9223372036854775807", Some(&Type::INT8)),
            json!("9223372036854775807")
        );
        assert_eq!(text_to_json("1.5", Some(&Type::FLOAT8)), json!(1.5));
        assert_eq!(text_to_json("NaN", Some(&Type::FLOAT8)), json!("NaN"));
        assert_eq!(
            text_to_json("123456789012345678901234.5", Some(&Type::NUMERIC)),
            json!("123456789012345678901234.5")
        );
        assert_eq!(
            text_to_json("\\x010203", Some(&Type::BYTEA)),
            json!({"__binary": true, "bytes": 3})
        );
        assert_eq!(
            text_to_json("{1,2}", Some(&Type::INT4_ARRAY)),
            json!("{1,2}")
        );
        assert_eq!(text_to_json("42", None), json!("42"));
    }
}
