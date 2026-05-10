use crate::error::AppResult;
use crate::model::{
    ColumnInfo, PageOptions, QueryResult, QueryResultColumn, RelationInfo, RelationKind,
    ResolvedConnection, SchemaInfo, TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use serde_json::{json, Value};
use std::time::Instant;
use tokio_postgres::types::Type;
use tokio_postgres::{Client, NoTls, Row};

async fn connect(c: &ResolvedConnection) -> AppResult<Client> {
    let cfg = format!(
        "host={} port={} dbname={} user={} password={} application_name=data-view",
        c.host, c.port, c.database, c.username, c.password
    );
    // For SSL we'd swap NoTls for native-tls/rustls; left as a TODO for now.
    let (client, conn) = tokio_postgres::connect(&cfg, NoTls).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(client)
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
                message: e.to_string(),
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
    let sql = "SELECT n.nspname, c.relname, c.relkind::text
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
        let kind = match kind.as_str() {
            "v" => RelationKind::View,
            "m" => RelationKind::MaterializedView,
            _ => RelationKind::Table,
        };
        out.push(RelationInfo {
            schema: s,
            name: n,
            kind,
        });
    }
    Ok(out)
}

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let client = connect(c).await?;
    let sql = "SELECT a.attname,
                      pg_catalog.format_type(a.atttypid, a.atttypmod),
                      a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid),
                      COALESCE((SELECT true FROM pg_index i
                                JOIN pg_attribute aa ON aa.attrelid = i.indrelid AND aa.attnum = ANY(i.indkey)
                                WHERE i.indisprimary AND i.indrelid = c.oid AND aa.attname = a.attname), false) AS is_pk
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
               ORDER BY a.attnum";
    let rows = client.query(sql, &[&schema, &name]).await?;
    let columns = rows
        .into_iter()
        .map(|row| {
            let nm: String = row.get(0);
            let dt: String = row.get(1);
            let notnull: bool = row.get(2);
            let default: Option<String> = row.get(3);
            let is_pk: bool = row.get(4);
            ColumnInfo {
                name: nm,
                data_type: dt,
                nullable: !notnull,
                is_primary_key: is_pk,
                is_unique: false,
                default,
            }
        })
        .collect();
    Ok(TableDetails {
        schema: schema.into(),
        name: name.into(),
        kind: RelationKind::Table,
        columns,
        indexes: vec![],
        foreign_keys: vec![],
    })
}

pub async fn run_query(c: &ResolvedConnection, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let client = connect(c).await?;
    let stmt = client.prepare(sql).await?;
    let cols: Vec<QueryResultColumn> = stmt
        .columns()
        .iter()
        .map(|col| QueryResultColumn {
            name: col.name().to_string(),
            data_type: col.type_().name().to_string(),
        })
        .collect();
    let rows = client.query(&stmt, &[]).await?;
    let truncated = rows.len() >= QUERY_LIMIT;
    let row_values: Vec<Vec<Value>> = rows
        .iter()
        .take(QUERY_LIMIT)
        .map(|r| extract_row(r, stmt.columns()))
        .collect();
    Ok(QueryResult {
        columns: cols,
        row_count: row_values.len(),
        rows: row_values,
        affected_rows: None,
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
    let order_by = options
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
        order_by,
        limit,
        offset
    );
    run_query(c, &sql).await
}

fn extract_row(row: &Row, columns: &[tokio_postgres::Column]) -> Vec<Value> {
    columns
        .iter()
        .enumerate()
        .map(|(i, col)| extract_cell(row, i, col.type_()))
        .collect()
}

fn extract_cell(row: &Row, idx: usize, ty: &Type) -> Value {
    macro_rules! try_get {
        ($ty:ty) => {{
            let v: Option<$ty> = row.try_get(idx).unwrap_or(None);
            match v {
                Some(x) => return json!(x),
                None => return Value::Null,
            }
        }};
    }
    match *ty {
        Type::BOOL => try_get!(bool),
        Type::INT2 => try_get!(i16),
        Type::INT4 => try_get!(i32),
        Type::INT8 => try_get!(i64),
        Type::FLOAT4 => try_get!(f32),
        Type::FLOAT8 => try_get!(f64),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => try_get!(String),
        Type::UUID => {
            let v: Option<uuid::Uuid> = row.try_get(idx).unwrap_or(None);
            return v.map(|u| Value::String(u.to_string())).unwrap_or(Value::Null);
        }
        Type::JSON | Type::JSONB => try_get!(serde_json::Value),
        _ => {
            // Fallback: ask Postgres to render as text.
            let v: Option<String> = row.try_get(idx).unwrap_or_else(|_| None);
            return v.map(Value::String).unwrap_or(Value::Null);
        }
    }
}
