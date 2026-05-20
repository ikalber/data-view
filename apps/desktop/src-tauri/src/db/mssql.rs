use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ConnectionOverview, DatabaseSummary, ForeignKeyInfo, IndexInfo, PageOptions,
    QueryResult, QueryResultColumn, RelationInfo, RelationKind, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult, QUERY_LIMIT,
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

pub async fn get_connection_overview(c: &ResolvedConnection) -> AppResult<ConnectionOverview> {
    let mut client = connect(c).await?;

    let meta_rows = client
        .query(
            "SELECT @@VERSION,
                    DB_NAME(),
                    SUSER_SNAME(),
                    CONVERT(varchar(33), SYSUTCDATETIME(), 126),
                    DATEDIFF(SECOND, sqlserver_start_time, SYSUTCDATETIME())
             FROM sys.dm_os_sys_info",
            &[],
        )
        .await?
        .into_first_result()
        .await?;

    let (server_version, current_database, current_user, server_time, uptime_seconds) =
        if let Some(row) = meta_rows.first() {
            let version: Option<String> = row.get::<&str, _>(0).map(String::from);
            let cur_db: Option<String> = row.get::<&str, _>(1).map(String::from);
            let cur_user: Option<String> = row.get::<&str, _>(2).map(String::from);
            let s_time: Option<String> = row.get::<&str, _>(3).map(String::from);
            let up: Option<i32> = row.get::<i32, _>(4);
            (version, cur_db, cur_user, s_time, up)
        } else {
            (None, None, None, None, None)
        };

    let db_rows = client
        .query(
            "SELECT d.name,
                    SUM(CAST(f.size AS BIGINT)) * 8192,
                    CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END
             FROM sys.databases d
             LEFT JOIN sys.master_files f ON f.database_id = d.database_id
             GROUP BY d.name, d.database_id
             ORDER BY d.name",
            &[],
        )
        .await?
        .into_first_result()
        .await?;

    let active: Option<i32> = match client
        .query(
            "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1",
            &[],
        )
        .await
    {
        Ok(stream) => stream
            .into_first_result()
            .await
            .ok()
            .and_then(|rows| rows.first().and_then(|r| r.get::<i32, _>(0))),
        Err(_) => None,
    };

    let mut databases = Vec::with_capacity(db_rows.len());
    let mut total: u64 = 0;
    for row in db_rows {
        let name: String = row.get::<&str, _>(0).unwrap_or("").to_string();
        let size: Option<i64> = row.get::<i64, _>(1);
        let is_system_flag: i32 = row.get::<i32, _>(2).unwrap_or(0);
        let size_bytes = size.and_then(|s| if s > 0 { Some(s as u64) } else { None });
        if let Some(s) = size_bytes {
            total = total.saturating_add(s);
        }
        databases.push(DatabaseSummary {
            name,
            is_system: is_system_flag == 1,
            size_bytes,
            relation_count: None,
            details: None,
        });
    }

    Ok(ConnectionOverview {
        driver: "mssql".to_string(),
        server_version,
        current_database,
        current_user,
        server_time,
        uptime_seconds: uptime_seconds.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
        total_size_bytes: if total > 0 { Some(total) } else { None },
        active_connections: active.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
        max_connections: None,
        databases,
    })
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
    // Indexes from sys.indexes — drop tiberius rows into a BTreeMap to group
    // columns per index name.
    let idx_stream = client
        .query(
            "SELECT i.name AS index_name,
                    i.is_unique,
                    i.is_primary_key,
                    c.name AS column_name,
                    ic.key_ordinal
             FROM sys.indexes i
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             JOIN sys.tables t ON t.object_id = i.object_id
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             WHERE s.name = @P1 AND t.name = @P2 AND i.name IS NOT NULL
               AND ic.is_included_column = 0
             ORDER BY i.name, ic.key_ordinal",
            &[&schema, &name],
        )
        .await?;
    let idx_rows = idx_stream.into_first_result().await?;
    let mut idx_map: std::collections::BTreeMap<String, IndexInfo> =
        std::collections::BTreeMap::new();
    for row in idx_rows {
        let idx_name: &str = row.get(0).unwrap_or("");
        let is_unique: bool = row.get(1).unwrap_or(false);
        let is_primary: bool = row.get(2).unwrap_or(false);
        let col_name: &str = row.get(3).unwrap_or("");
        if idx_name.is_empty() {
            continue;
        }
        let entry = idx_map
            .entry(idx_name.to_string())
            .or_insert_with(|| IndexInfo {
                name: idx_name.to_string(),
                columns: Vec::new(),
                unique: is_unique,
                primary: is_primary,
            });
        entry.columns.push(col_name.to_string());
    }
    let mut indexes: Vec<IndexInfo> = idx_map.into_values().collect();
    indexes.sort_by(|a, b| {
        b.primary
            .cmp(&a.primary)
            .then(b.unique.cmp(&a.unique))
            .then(a.name.cmp(&b.name))
    });
    // Foreign keys from sys.foreign_keys with STRING_AGG (SQL Server 2017+).
    let fk_stream = client
        .query(
            "SELECT fk.name,
                    STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS local_cols,
                    ref_s.name,
                    ref_t.name,
                    STRING_AGG(ref_c.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS ref_cols,
                    fk.update_referential_action_desc,
                    fk.delete_referential_action_desc
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN sys.columns c ON c.object_id = fk.parent_object_id AND c.column_id = fkc.parent_column_id
             JOIN sys.columns ref_c ON ref_c.object_id = fk.referenced_object_id AND ref_c.column_id = fkc.referenced_column_id
             JOIN sys.tables ref_t ON ref_t.object_id = fk.referenced_object_id
             JOIN sys.schemas ref_s ON ref_s.schema_id = ref_t.schema_id
             JOIN sys.tables tab ON tab.object_id = fk.parent_object_id
             JOIN sys.schemas sch ON sch.schema_id = tab.schema_id
             WHERE sch.name = @P1 AND tab.name = @P2
             GROUP BY fk.name, ref_s.name, ref_t.name,
                      fk.update_referential_action_desc,
                      fk.delete_referential_action_desc
             ORDER BY fk.name",
            &[&schema, &name],
        )
        .await?;
    let fk_rows = fk_stream.into_first_result().await?;
    let foreign_keys: Vec<ForeignKeyInfo> = fk_rows
        .into_iter()
        .map(|row| {
            let fkname: &str = row.get(0).unwrap_or("");
            let local: &str = row.get(1).unwrap_or("");
            let rs: &str = row.get(2).unwrap_or("");
            let rt: &str = row.get(3).unwrap_or("");
            let refc: &str = row.get(4).unwrap_or("");
            let up: Option<&str> = row.get(5);
            let del: Option<&str> = row.get(6);
            // sys.foreign_keys uses NO_ACTION / SET_NULL etc; convert to the
            // standard "NO ACTION" / "SET NULL" form so the generated DDL is
            // valid as-is.
            let normalize = |s: Option<&str>| -> Option<String> {
                s.filter(|v| !v.is_empty()).map(|v| v.replace('_', " "))
            };
            ForeignKeyInfo {
                name: fkname.to_string(),
                columns: local.split(',').map(String::from).collect(),
                referenced_schema: rs.to_string(),
                referenced_table: rt.to_string(),
                referenced_columns: refc.split(',').map(String::from).collect(),
                on_update: normalize(up),
                on_delete: normalize(del),
            }
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
