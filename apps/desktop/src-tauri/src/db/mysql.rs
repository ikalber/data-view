use crate::error::AppResult;
use crate::model::{
    ColumnInfo, ConnectionOverview, DatabaseSummary, ForeignKeyInfo, IndexInfo, PageOptions,
    QueryResult, QueryResultColumn, RelationInfo, RelationKind, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, Row, Value as MyValue};
use serde_json::{json, Value};
use std::time::Instant;

async fn connect(c: &ResolvedConnection) -> AppResult<Conn> {
    let opts: Opts = OptsBuilder::default()
        .ip_or_hostname(c.host.clone())
        .tcp_port(c.port)
        .user(Some(c.username.clone()))
        .pass(Some(c.password.clone()))
        .db_name(Some(c.database.clone()))
        .into();
    Ok(Conn::new(opts).await?)
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub async fn test(c: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    let start = Instant::now();
    match connect(c).await {
        Ok(mut conn) => {
            let res: Result<Option<i64>, _> = conn.query_first("SELECT 1").await;
            let ok = res.is_ok();
            let latency = start.elapsed().as_millis() as u64;
            let _ = conn.disconnect().await;
            if ok {
                Ok(TestConnectionResult {
                    ok: true,
                    message: "Conexión exitosa".into(),
                    latency_ms: Some(latency),
                })
            } else {
                Ok(TestConnectionResult {
                    ok: false,
                    message: res.err().map(|e| e.to_string()).unwrap_or_default(),
                    latency_ms: None,
                })
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
        ["information_schema", "mysql", "performance_schema", "sys"].into_iter().collect();
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
    let target = schema.map(String::from).unwrap_or_else(|| c.database.clone());
    let rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT table_schema, table_name, table_type FROM information_schema.tables
             WHERE table_schema = ? ORDER BY table_name",
            (target,),
        )
        .await?;
    let _ = conn.disconnect().await;
    Ok(rows
        .into_iter()
        .map(|(s, n, t)| {
            let kind = if t == "VIEW" {
                RelationKind::View
            } else {
                RelationKind::Table
            };
            RelationInfo {
                schema: s,
                name: n,
                kind,
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

    let meta: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<u64>)> =
        conn.query_first(
            "SELECT VERSION(), DATABASE(), CURRENT_USER(), DATE_FORMAT(NOW(), '%Y-%m-%dT%H:%i:%s'), @@max_connections",
        )
        .await?;
    let (version, current_db, current_user, server_time, max_conn) =
        meta.unwrap_or((None, None, None, None, None));

    // Uptime via SHOW GLOBAL STATUS — wrap to survive missing privilege.
    let uptime: Option<u64> = match conn
        .query_first::<(String, String), _>("SHOW GLOBAL STATUS LIKE 'Uptime'")
        .await
    {
        Ok(Some((_, v))) => v.parse::<u64>().ok(),
        _ => None,
    };

    let db_rows: Vec<(String, Option<u64>, u64, Option<String>)> = conn
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
        .query_first::<u64, _>(
            "SELECT COUNT(*) FROM information_schema.processlist",
        )
        .await
        .ok()
        .flatten();

    let _ = conn.disconnect().await;

    let mut databases = Vec::with_capacity(db_rows.len());
    let mut total: u64 = 0;
    for (name, size_bytes, rel_count, charset) in db_rows {
        let size = size_bytes.and_then(|s| if s > 0 { Some(s) } else { None });
        if let Some(s) = size {
            total = total.saturating_add(s);
        }
        let is_system = sys.contains(name.as_str());
        databases.push(DatabaseSummary {
            name,
            is_system,
            size_bytes: size,
            relation_count: Some(rel_count),
            details: charset,
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

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let mut conn = connect(c).await?;
    let rows: Vec<(String, String, String, String, Option<String>)> = conn
        .exec(
            "SELECT column_name, column_type, is_nullable, column_key, column_default
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            (schema, name),
        )
        .await?;
    // Indexes — group rows by index name.
    let idx_rows: Vec<(String, i64, String, u32)> = conn
        .exec(
            "SELECT index_name, non_unique, column_name, seq_in_index
             FROM information_schema.statistics
             WHERE table_schema = ? AND table_name = ?
             ORDER BY index_name, seq_in_index",
            (schema, name),
        )
        .await?;
    let mut idx_map: std::collections::BTreeMap<String, IndexInfo> =
        std::collections::BTreeMap::new();
    for (idx_name, non_unique, col_name, _seq) in idx_rows {
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
    // Foreign keys — aggregate columns per constraint with GROUP_CONCAT.
    let fk_rows: Vec<(String, String, String, String, String, String, String)> = conn
        .exec(
            "SELECT rc.constraint_name,
                    GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position),
                    rc.unique_constraint_schema,
                    rc.referenced_table_name,
                    GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position),
                    rc.update_rule,
                    rc.delete_rule
             FROM information_schema.referential_constraints rc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_schema = rc.constraint_schema
              AND kcu.constraint_name = rc.constraint_name
             WHERE kcu.table_schema = ? AND kcu.table_name = ?
             GROUP BY rc.constraint_name, rc.unique_constraint_schema,
                      rc.referenced_table_name, rc.update_rule, rc.delete_rule
             ORDER BY rc.constraint_name",
            (schema, name),
        )
        .await?;
    let foreign_keys: Vec<ForeignKeyInfo> = fk_rows
        .into_iter()
        .map(|(fkname, local, rs, rt, refc, up, del)| ForeignKeyInfo {
            name: fkname,
            columns: local.split(',').map(|s| s.to_string()).collect(),
            referenced_schema: rs,
            referenced_table: rt,
            referenced_columns: refc.split(',').map(|s| s.to_string()).collect(),
            on_update: if up.is_empty() { None } else { Some(up) },
            on_delete: if del.is_empty() { None } else { Some(del) },
        })
        .collect();
    let _ = conn.disconnect().await;
    let columns = rows
        .into_iter()
        .map(|(col, ty, null, key, def)| ColumnInfo {
            name: col,
            data_type: ty,
            nullable: null == "YES",
            is_primary_key: key == "PRI",
            is_unique: key == "UNI",
            default: def,
        })
        .collect();
    Ok(TableDetails {
        schema: schema.into(),
        name: name.into(),
        kind: RelationKind::Table,
        columns,
        indexes,
        foreign_keys,
    })
}

pub async fn run_query(c: &ResolvedConnection, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let mut conn = connect(c).await?;
    let mut result = conn.query_iter(sql).await?;
    let mut all_columns: Vec<QueryResultColumn> = vec![];
    let mut rows_out: Vec<Vec<Value>> = vec![];
    let mut affected: Option<u64> = None;
    let mut truncated = false;

    while !result.is_empty() {
        let cols_now: Vec<QueryResultColumn> = result
            .columns_ref()
            .iter()
            .map(|c| QueryResultColumn {
                name: c.name_str().to_string(),
                data_type: format!("{:?}", c.column_type()),
            })
            .collect();
        if all_columns.is_empty() && !cols_now.is_empty() {
            all_columns = cols_now;
        }
        let collected: Vec<Row> = result.collect().await?;
        if collected.is_empty() {
            affected = Some(result.affected_rows());
        }
        for row in collected {
            if rows_out.len() >= QUERY_LIMIT {
                truncated = true;
                break;
            }
            let json_row: Vec<Value> = (0..row.len()).map(|i| myvalue_to_json(&row[i])).collect();
            rows_out.push(json_row);
        }
        if truncated {
            break;
        }
    }
    drop(result);
    let _ = conn.disconnect().await;

    Ok(QueryResult {
        row_count: rows_out.len(),
        columns: all_columns,
        rows: rows_out,
        affected_rows: affected,
        duration_ms: start.elapsed().as_millis() as u64,
        truncated,
    })
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
    let where_clause = options
        .where_clause
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("WHERE {}", s))
        .unwrap_or_default();
    let sql = format!(
        "SELECT * FROM {}.{} {} {} LIMIT {} OFFSET {}",
        ident(schema),
        ident(name),
        where_clause,
        order,
        limit,
        offset
    );
    run_query(c, &sql).await
}

fn myvalue_to_json(v: &MyValue) -> Value {
    match v {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(b) => match std::str::from_utf8(b) {
            Ok(s) => Value::String(s.to_string()),
            Err(_) => json!({ "__binary": true, "bytes": b.len() }),
        },
        MyValue::Int(i) => json!(i),
        MyValue::UInt(u) => json!(u),
        MyValue::Float(f) => json!(f),
        MyValue::Double(f) => json!(f),
        MyValue::Date(y, m, d, h, mi, s, _) => {
            Value::String(format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, h, mi, s))
        }
        MyValue::Time(_, _, h, m, s, _) => Value::String(format!("{:02}:{:02}:{:02}", h, m, s)),
    }
}
