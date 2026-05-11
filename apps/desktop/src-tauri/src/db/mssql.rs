use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, PageOptions, QueryResult, QueryResultColumn, RelationInfo, RelationKind,
    ResolvedConnection, SchemaInfo, TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use serde_json::{json, Value};
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

async fn connect(c: &ResolvedConnection) -> AppResult<Client<tokio_util::compat::Compat<TcpStream>>> {
    let mut config = Config::new();
    config.host(&c.host);
    config.port(c.port);
    config.database(&c.database);
    config.authentication(AuthMethod::sql_server(&c.username, &c.password));
    if c.ssl {
        config.encryption(EncryptionLevel::Required);
    } else {
        config.encryption(EncryptionLevel::NotSupported);
    }
    if c.options.get("trustServerCertificate").map(|v| v == "true").unwrap_or(false) {
        config.trust_cert();
    }
    let tcp = TcpStream::connect(config.get_addr()).await.map_err(AppError::Io)?;
    tcp.set_nodelay(true).map_err(AppError::Io)?;
    let client = Client::connect(config, tcp.compat_write()).await?;
    Ok(client)
}

fn ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

pub async fn test(c: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    let start = Instant::now();
    match connect(c).await {
        Ok(mut client) => match client.simple_query("SELECT 1").await {
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
    let mut client = connect(c).await?;
    let stream = client
        .query("SELECT name FROM sys.schemas ORDER BY name", &[])
        .await?;
    let rows = stream.into_first_result().await?;
    let sys: std::collections::HashSet<&str> = [
        "sys",
        "INFORMATION_SCHEMA",
        "guest",
        "db_owner",
        "db_accessadmin",
        "db_securityadmin",
        "db_ddladmin",
        "db_backupoperator",
        "db_datareader",
        "db_datawriter",
        "db_denydatareader",
        "db_denydatawriter",
    ]
    .into_iter()
    .collect();
    Ok(rows
        .into_iter()
        .map(|row| {
            let name: &str = row.get(0).unwrap_or("");
            SchemaInfo {
                name: name.to_string(),
                is_system: sys.contains(name),
            }
        })
        .collect())
}

pub async fn list_relations(
    c: &ResolvedConnection,
    schema: Option<&str>,
) -> AppResult<Vec<RelationInfo>> {
    let mut client = connect(c).await?;
    let sql = match schema {
        Some(_) => "SELECT s.name, o.name, o.type
                    FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                    WHERE o.type IN ('U','V') AND s.name = @P1
                    ORDER BY s.name, o.name",
        None => "SELECT s.name, o.name, o.type
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE o.type IN ('U','V')
                 ORDER BY s.name, o.name",
    };
    let stream = if let Some(s) = schema {
        client.query(sql, &[&s]).await?
    } else {
        client.query(sql, &[]).await?
    };
    let rows = stream.into_first_result().await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let s: &str = row.get(0).unwrap_or("");
            let n: &str = row.get(1).unwrap_or("");
            let t: &str = row.get(2).unwrap_or("U");
            let kind = if t.trim() == "V" {
                RelationKind::View
            } else {
                RelationKind::Table
            };
            RelationInfo {
                schema: s.to_string(),
                name: n.to_string(),
                kind,
            }
        })
        .collect())
}

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let mut client = connect(c).await?;
    let sql = "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                      CASE WHEN kcu.column_name IS NOT NULL THEN 1 ELSE 0 END
               FROM information_schema.columns c
               LEFT JOIN information_schema.table_constraints tc
                 ON tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
               LEFT JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name AND kcu.column_name = c.column_name
               WHERE c.table_schema = @P1 AND c.table_name = @P2
               ORDER BY c.ordinal_position";
    let stream = client.query(sql, &[&schema, &name]).await?;
    let rows = stream.into_first_result().await?;
    let columns = rows
        .into_iter()
        .map(|row| ColumnInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            data_type: row.get::<&str, _>(1).unwrap_or("").to_string(),
            nullable: row.get::<&str, _>(2).unwrap_or("") == "YES",
            is_primary_key: row.get::<i32, _>(4).unwrap_or(0) == 1,
            is_unique: false,
            default: row.get::<&str, _>(3).map(String::from),
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
    let mut client = connect(c).await?;
    let stream = client.query(sql, &[]).await?;
    let result = stream.into_results().await?;
    let mut all_columns = Vec::new();
    let mut all_rows = Vec::new();
    let mut truncated = false;
    for set in result {
        if set.is_empty() {
            continue;
        }
        let first_row: &Row = &set[0];
        all_columns = first_row
            .columns()
            .iter()
            .map(|c| QueryResultColumn {
                name: c.name().to_string(),
                data_type: format!("{:?}", c.column_type()),
            })
            .collect();
        for row in set {
            if all_rows.len() >= QUERY_LIMIT {
                truncated = true;
                break;
            }
            let json_row: Vec<Value> = row
                .cells()
                .map(|(_, cd)| coldata_to_json(cd))
                .collect();
            all_rows.push(json_row);
        }
        if truncated {
            break;
        }
    }
    Ok(QueryResult {
        row_count: all_rows.len(),
        columns: all_columns,
        rows: all_rows,
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
    let order = options
        .order_by
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|cols| {
            cols.iter()
                .map(|o| {
                    let dir = if o.direction.eq_ignore_ascii_case("desc") {
                        "DESC"
                    } else {
                        "ASC"
                    };
                    format!("{} {}", ident(&o.column), dir)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "(SELECT NULL)".to_string());
    let where_clause = options
        .where_clause
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("WHERE {}", s))
        .unwrap_or_default();
    let sql = format!(
        "SELECT * FROM {}.{} {} ORDER BY {} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
        ident(schema),
        ident(name),
        where_clause,
        order,
        offset,
        limit
    );
    run_query(c, &sql).await
}

fn coldata_to_json(cd: &ColumnData<'_>) -> Value {
    match cd {
        ColumnData::U8(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::I16(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::I32(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::I64(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::F32(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::F64(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::Bit(v) => v.map(|x| json!(x)).unwrap_or(Value::Null),
        ColumnData::String(v) => v.as_ref().map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        ColumnData::Guid(v) => v.map(|g| Value::String(g.to_string())).unwrap_or(Value::Null),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| json!({ "__binary": true, "bytes": b.len() }))
            .unwrap_or(Value::Null),
        _ => Value::String(format!("{cd:?}")),
    }
}
