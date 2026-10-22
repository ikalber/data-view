use super::common::{
    binary_value, f32_value, float_value, int_value, mark_unique_columns, where_fragment,
    ResultCollector, RowSink,
};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ConnectionOverview, DatabaseSummary, ForeignKeyInfo, IndexInfo, PageOptions,
    QueryResult, QueryResultColumn, RelationInfo, RelationKind, ResolvedConnection, SchemaInfo,
    TableDetails, TestConnectionResult, QUERY_LIMIT,
};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use futures::TryStreamExt;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tiberius::numeric::Numeric;
use tiberius::{
    AuthMethod, Client, Column, ColumnData, ColumnType, Config, EncryptionLevel, FromSql,
    QueryItem, Row,
};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type MsClient = Client<Compat<TcpStream>>;

async fn connect(c: &ResolvedConnection) -> AppResult<MsClient> {
    let mut config = Config::new();
    config.host(&c.host);
    config.port(c.port);
    if !c.database.is_empty() {
        config.database(&c.database);
    }
    config.application_name("data-view");
    config.authentication(AuthMethod::sql_server(&c.username, &c.password));
    if c.ssl {
        config.encryption(EncryptionLevel::Required);
        // SQL Server ships a self-signed certificate and the UI has no way to
        // set `trustServerCertificate`, so encrypt without verifying by
        // default (same as sslmode=require on Postgres); an explicit
        // `trustServerCertificate: "false"` option opts into verification.
        if c.options.get("trustServerCertificate").map(String::as_str) != Some("false") {
            config.trust_cert();
        }
    } else {
        config.encryption(EncryptionLevel::NotSupported);
    }
    let connect = async {
        let tcp = TcpStream::connect(config.get_addr())
            .await
            .map_err(AppError::Io)?;
        tcp.set_nodelay(true).map_err(AppError::Io)?;
        AppResult::Ok(Client::connect(config, tcp.compat_write()).await?)
    };
    match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Ok(client) => client,
        Err(_) => Err(AppError::msg(format!(
            "Tiempo de espera agotado conectando a {}:{}",
            c.host, c.port
        ))),
    }
}

fn ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// Non-panicking typed cell read (`Row::get` panics on type mismatches).
fn cell<'a, T: FromSql<'a>>(row: &'a Row, idx: usize) -> Option<T> {
    row.try_get::<T, _>(idx).ok().flatten()
}

fn cell_string(row: &Row, idx: usize) -> Option<String> {
    cell::<&str>(row, idx).map(String::from)
}

pub async fn test(c: &ResolvedConnection) -> AppResult<TestConnectionResult> {
    let start = Instant::now();
    match connect(c).await {
        Ok(mut client) => match client.simple_query("SELECT 1").await {
            Ok(stream) => {
                let _ = stream.into_results().await;
                Ok(TestConnectionResult {
                    ok: true,
                    message: "Conexión exitosa".into(),
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                })
            }
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
    let mut client = connect(c).await?;
    let rows = client
        .query("SELECT name FROM sys.schemas ORDER BY name", &[])
        .await?
        .into_first_result()
        .await?;
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
        .iter()
        .map(|row| {
            let name = cell_string(row, 0).unwrap_or_default();
            SchemaInfo {
                is_system: sys.contains(name.as_str()),
                name,
            }
        })
        .collect())
}

pub async fn list_relations(
    c: &ResolvedConnection,
    schema: Option<&str>,
) -> AppResult<Vec<RelationInfo>> {
    let mut client = connect(c).await?;
    // Row counts from sys.partitions (heap / clustered index only) and sizes
    // from sys.allocation_units (8 KB pages). Unlike sys.dm_db_partition_stats
    // these catalog views don't require VIEW DATABASE STATE. Views have no
    // partitions, so their stats come back NULL ("—" in the UI).
    let select = "SELECT s.name, o.name, o.type,
                         r.row_count, sz.total_pages, sz.data_pages, sz.index_pages
                  FROM sys.objects o
                  JOIN sys.schemas s ON s.schema_id = o.schema_id
                  OUTER APPLY (
                    SELECT SUM(p.rows) AS row_count
                    FROM sys.partitions p
                    WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
                  ) r
                  OUTER APPLY (
                    SELECT SUM(a.total_pages) AS total_pages,
                           SUM(CASE WHEN p.index_id IN (0, 1) THEN a.used_pages ELSE 0 END) AS data_pages,
                           SUM(CASE WHEN p.index_id > 1 THEN a.used_pages ELSE 0 END) AS index_pages
                    FROM sys.partitions p
                    JOIN sys.allocation_units a ON a.container_id = p.partition_id
                    WHERE p.object_id = o.object_id
                  ) sz
                  WHERE o.type IN ('U','V')";
    let rows = match schema {
        Some(s) => {
            let sql = format!("{} AND s.name = @P1 ORDER BY s.name, o.name", select);
            client.query(sql, &[&s]).await?.into_first_result().await?
        }
        None => {
            let sql = format!("{} ORDER BY s.name, o.name", select);
            client.query(sql, &[]).await?.into_first_result().await?
        }
    };
    let to_u64 = |v: Option<i64>| v.and_then(|n| u64::try_from(n).ok());
    let to_bytes = |pages: Option<i64>| to_u64(pages).map(|p| p * 8192);
    Ok(rows
        .iter()
        .map(|row| {
            let t = cell::<&str>(row, 2).unwrap_or("U");
            RelationInfo {
                schema: cell_string(row, 0).unwrap_or_default(),
                name: cell_string(row, 1).unwrap_or_default(),
                kind: if t.trim() == "V" {
                    RelationKind::View
                } else {
                    RelationKind::Table
                },
                approx_row_count: to_u64(cell(row, 3)),
                total_bytes: to_bytes(cell(row, 4)),
                data_bytes: to_bytes(cell(row, 5)),
                index_bytes: to_bytes(cell(row, 6)),
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
                    CONVERT(varchar(19), SYSUTCDATETIME(), 126) + 'Z',
                    DATEDIFF(SECOND, sqlserver_start_time, SYSUTCDATETIME()),
                    @@MAX_CONNECTIONS
             FROM sys.dm_os_sys_info",
            &[],
        )
        .await?
        .into_first_result()
        .await;
    let meta_rows = match meta_rows {
        Ok(rows) => rows,
        // sys.dm_os_sys_info needs VIEW SERVER STATE — fall back to the basics.
        Err(_) => {
            client
                .query(
                    "SELECT @@VERSION, DB_NAME(), SUSER_SNAME(),
                        CONVERT(varchar(19), SYSUTCDATETIME(), 126) + 'Z',
                        CAST(NULL AS int), @@MAX_CONNECTIONS",
                    &[],
                )
                .await?
                .into_first_result()
                .await?
        }
    };

    let (server_version, current_database, current_user, server_time, uptime, max_conn) =
        match meta_rows.first() {
            Some(row) => (
                cell_string(row, 0),
                cell_string(row, 1),
                cell_string(row, 2),
                cell_string(row, 3),
                cell::<i32>(row, 4),
                cell::<i32>(row, 5),
            ),
            None => (None, None, None, None, None, None),
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
            .and_then(|rows| rows.first().and_then(|r| cell::<i32>(r, 0))),
        Err(_) => None,
    };

    let mut databases = Vec::with_capacity(db_rows.len());
    let mut total: u64 = 0;
    for row in db_rows.iter() {
        let size_bytes =
            cell::<i64>(row, 1).and_then(|s| if s > 0 { Some(s as u64) } else { None });
        if let Some(s) = size_bytes {
            total = total.saturating_add(s);
        }
        databases.push(DatabaseSummary {
            name: cell_string(row, 0).unwrap_or_default(),
            is_system: cell::<i32>(row, 2).unwrap_or(0) == 1,
            size_bytes,
            relation_count: None,
            details: None,
        });
    }

    let non_neg = |v: Option<i32>| v.and_then(|n| u64::try_from(n).ok());
    Ok(ConnectionOverview {
        driver: "mssql".to_string(),
        server_version,
        current_database,
        current_user,
        server_time,
        uptime_seconds: non_neg(uptime),
        total_size_bytes: if total > 0 { Some(total) } else { None },
        active_connections: non_neg(active),
        max_connections: non_neg(max_conn),
        databases,
    })
}

pub async fn describe_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> AppResult<TableDetails> {
    let mut client = connect(c).await?;
    let kind_rows = client
        .query(
            "SELECT o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U','V')",
            &[&schema, &name],
        )
        .await?
        .into_first_result()
        .await?;
    let kind = match kind_rows.first().and_then(|r| cell::<&str>(r, 0)) {
        Some(t) if t.trim() == "V" => RelationKind::View,
        _ => RelationKind::Table,
    };
    // Columns from the sys catalog: unlike information_schema.data_type this
    // keeps lengths/precision (`nvarchar(50)`, `decimal(10,2)`), which the
    // DDL generators need — a bare `varchar` means varchar(1) in T-SQL.
    let rows = client
        .query(
            "SELECT c.name,
                    CASE
                      WHEN t.is_user_defined = 0 AND t.name IN ('varchar','char','varbinary','binary')
                        THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max'
                                                 ELSE CAST(c.max_length AS varchar(10)) END + ')'
                      WHEN t.is_user_defined = 0 AND t.name IN ('nvarchar','nchar')
                        THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max'
                                                 ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
                      WHEN t.is_user_defined = 0 AND t.name IN ('decimal','numeric')
                        THEN t.name + '(' + CAST(c.precision AS varchar(10)) + ','
                                          + CAST(c.scale AS varchar(10)) + ')'
                      WHEN t.is_user_defined = 0 AND t.name IN ('datetime2','time','datetimeoffset')
                        THEN t.name + '(' + CAST(c.scale AS varchar(10)) + ')'
                      ELSE t.name
                    END,
                    c.is_nullable,
                    dc.definition,
                    CAST(CASE WHEN EXISTS (
                      SELECT 1 FROM sys.indexes i
                      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                      WHERE i.object_id = c.object_id AND i.is_primary_key = 1
                        AND ic.column_id = c.column_id
                    ) THEN 1 ELSE 0 END AS bit),
                    CAST(ep.value AS nvarchar(4000))
             FROM sys.columns c
             JOIN sys.objects o ON o.object_id = c.object_id
             JOIN sys.schemas s ON s.schema_id = o.schema_id
             JOIN sys.types t ON t.user_type_id = c.user_type_id
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
             LEFT JOIN sys.extended_properties ep
               ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
              AND ep.name = 'MS_Description'
             WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U','V')
             ORDER BY c.column_id",
            &[&schema, &name],
        )
        .await?
        .into_first_result()
        .await?;
    let mut columns: Vec<ColumnInfo> = rows
        .iter()
        .map(|row| ColumnInfo {
            name: cell_string(row, 0).unwrap_or_default(),
            data_type: cell_string(row, 1).unwrap_or_default(),
            nullable: cell::<bool>(row, 2).unwrap_or(true),
            is_primary_key: cell::<bool>(row, 4).unwrap_or(false),
            is_unique: false,
            default: cell_string(row, 3),
            comment: cell_string(row, 5),
        })
        .collect();
    // Indexes from sys.indexes (heaps have a NULL-named entry → skipped).
    let idx_rows = client
        .query(
            "SELECT i.name, i.is_unique, i.is_primary_key, c.name
             FROM sys.indexes i
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             JOIN sys.objects t ON t.object_id = i.object_id
             JOIN sys.schemas s ON s.schema_id = t.schema_id
             WHERE s.name = @P1 AND t.name = @P2 AND i.name IS NOT NULL
               AND ic.is_included_column = 0
             ORDER BY i.name, ic.key_ordinal",
            &[&schema, &name],
        )
        .await?
        .into_first_result()
        .await?;
    let mut idx_map: std::collections::BTreeMap<String, IndexInfo> =
        std::collections::BTreeMap::new();
    for row in idx_rows.iter() {
        let Some(idx_name) = cell_string(row, 0) else {
            continue;
        };
        let entry = idx_map
            .entry(idx_name.clone())
            .or_insert_with(|| IndexInfo {
                name: idx_name,
                columns: Vec::new(),
                unique: cell::<bool>(row, 1).unwrap_or(false),
                primary: cell::<bool>(row, 2).unwrap_or(false),
            });
        entry.columns.push(cell_string(row, 3).unwrap_or_default());
    }
    let mut indexes: Vec<IndexInfo> = idx_map.into_values().collect();
    indexes.sort_by(|a, b| {
        b.primary
            .cmp(&a.primary)
            .then(b.unique.cmp(&a.unique))
            .then(a.name.cmp(&b.name))
    });
    mark_unique_columns(&mut columns, &indexes);
    // Foreign keys, one row per column (grouped here: works on servers
    // without STRING_AGG and with column names containing commas).
    let fk_rows = client
        .query(
            "SELECT fk.name, c.name, ref_s.name, ref_t.name, ref_c.name,
                    fk.update_referential_action_desc, fk.delete_referential_action_desc
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN sys.columns c ON c.object_id = fk.parent_object_id AND c.column_id = fkc.parent_column_id
             JOIN sys.columns ref_c ON ref_c.object_id = fk.referenced_object_id
                                   AND ref_c.column_id = fkc.referenced_column_id
             JOIN sys.objects ref_t ON ref_t.object_id = fk.referenced_object_id
             JOIN sys.schemas ref_s ON ref_s.schema_id = ref_t.schema_id
             JOIN sys.objects tab ON tab.object_id = fk.parent_object_id
             JOIN sys.schemas sch ON sch.schema_id = tab.schema_id
             WHERE sch.name = @P1 AND tab.name = @P2
             ORDER BY fk.name, fkc.constraint_column_id",
            &[&schema, &name],
        )
        .await?
        .into_first_result()
        .await?;
    // sys.foreign_keys uses NO_ACTION / SET_NULL etc; convert to the standard
    // "NO ACTION" / "SET NULL" form so generated DDL is valid as-is.
    let action = |v: Option<String>| v.filter(|s| !s.is_empty()).map(|s| s.replace('_', " "));
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    for row in fk_rows.iter() {
        let fk_name = cell_string(row, 0).unwrap_or_default();
        let col = cell_string(row, 1).unwrap_or_default();
        let ref_col = cell_string(row, 4).unwrap_or_default();
        match foreign_keys.last_mut() {
            Some(fk) if fk.name == fk_name => {
                fk.columns.push(col);
                fk.referenced_columns.push(ref_col);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name: fk_name,
                columns: vec![col],
                referenced_schema: cell_string(row, 2).unwrap_or_default(),
                referenced_table: cell_string(row, 3).unwrap_or_default(),
                referenced_columns: vec![ref_col],
                on_update: action(cell_string(row, 5)),
                on_delete: action(cell_string(row, 6)),
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

/// Split a script on `GO` batch separators (a line holding only `GO`,
/// optionally followed by a repeat count) the way sqlcmd/SSMS do, and move a
/// leading `SET SHOWPLAN_* ON` into its own batch — SQL Server requires both
/// (CREATE PROCEDURE/VIEW/… must start a batch; SHOWPLAN must be alone).
fn split_batches(sql: &str) -> Vec<String> {
    let mut batches: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in sql.split_inclusive('\n') {
        let t = line.trim();
        let mut words = t.split_whitespace();
        let is_go = matches!(words.next(), Some(w) if w.eq_ignore_ascii_case("go"))
            && words
                .next()
                .map(|n| n.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(true)
            && words.next().is_none();
        if is_go {
            batches.push(std::mem::take(&mut current));
        } else {
            current.push_str(line);
        }
    }
    batches.push(current);
    let mut out = Vec::new();
    for batch in batches {
        if batch.trim().is_empty() {
            continue;
        }
        let trimmed = batch.trim_start();
        let upper: String = trimmed
            .chars()
            .take(40)
            .collect::<String>()
            .to_ascii_uppercase();
        if upper.starts_with("SET SHOWPLAN_") {
            // `SET SHOWPLAN_TEXT ON;` / `SET SHOWPLAN_ALL ON` + newline.
            let end = trimmed
                .find(|ch| ch == ';' || ch == '\n')
                .unwrap_or(trimmed.len());
            let (set_stmt, rest) = trimmed.split_at(end);
            out.push(set_stmt.to_string());
            let rest = rest.trim_start_matches(';');
            if !rest.trim().is_empty() {
                out.push(rest.to_string());
            }
        } else {
            out.push(batch);
        }
    }
    out
}

/// Run an arbitrary script as SQL batches (not sp_executesql), so `USE`,
/// session `SET`s and DDL that must start a batch behave like in SSMS.
pub async fn run_query(c: &ResolvedConnection, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let mut client = connect(c).await?;
    let mut collector = ResultCollector::new(start);
    let mut saw_result_set = false;
    for batch in split_batches(sql) {
        let mut stream = client.simple_query(batch).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(meta) => {
                    saw_result_set = true;
                    collector.begin_set(meta.columns().iter().map(column_info).collect());
                }
                QueryItem::Row(row) => {
                    if collector.wants_row() {
                        collector.push_row(row_to_json(&row));
                    } else {
                        collector.skip_row();
                    }
                }
            }
        }
    }
    if !saw_result_set {
        // tiberius' QueryStream drops the DONE row counts; @@ROWCOUNT is
        // session-scoped, so ask for it in a follow-up batch.
        if let Ok(stream) = client
            .simple_query("SELECT CAST(@@ROWCOUNT AS bigint)")
            .await
        {
            if let Ok(Some(row)) = stream.into_row().await {
                if let Some(n) = cell::<i64>(&row, 0) {
                    collector.add_affected(n.max(0) as u64);
                }
            }
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
    let sql = format!(
        "SELECT * FROM {}.{} {} ORDER BY {} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
        ident(schema),
        ident(name),
        where_fragment(options.where_clause.as_deref()),
        order,
        offset,
        limit
    );
    run_query(c, &sql).await
}

/// Stream every row of a table into `sink` with a single query.
pub async fn stream_table(
    c: &ResolvedConnection,
    schema: &str,
    name: &str,
    where_clause: Option<&str>,
    sink: &mut dyn RowSink,
) -> AppResult<()> {
    let mut client = connect(c).await?;
    let sql = format!(
        "SELECT * FROM {}.{} {}",
        ident(schema),
        ident(name),
        where_fragment(where_clause)
    );
    let mut stream = client.simple_query(sql).await?;
    let mut sent_columns = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(meta) => {
                if !sent_columns {
                    sink.columns(&meta.columns().iter().map(column_info).collect::<Vec<_>>())?;
                    sent_columns = true;
                }
            }
            QueryItem::Row(row) => sink.row(row_to_json(&row))?,
        }
    }
    if !sent_columns {
        sink.columns(&[])?;
    }
    Ok(())
}

fn column_info(col: &Column) -> QueryResultColumn {
    QueryResultColumn {
        name: col.name().to_string(),
        data_type: type_name(col.column_type()).to_string(),
    }
}

/// SQL Server type names (tiberius' Debug names like `BigVarChar`/`Intn`
/// don't match what users — or the SQL-literal heuristics — expect).
fn type_name(t: ColumnType) -> &'static str {
    match t {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 | ColumnType::Intn => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money => "money",
        ColumnType::Money4 => "smallmoney",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln => "decimal",
        ColumnType::Numericn => "numeric",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::Text => "text",
        ColumnType::Image => "image",
        ColumnType::NText => "ntext",
        ColumnType::SSVariant => "sql_variant",
    }
}

fn row_to_json(row: &Row) -> Vec<Value> {
    row.cells().map(|(_, cd)| coldata_to_json(cd)).collect()
}

/// Exact decimal rendering. (tiberius' own Display prints negative values
/// like -1.50 as "-1.-50".)
fn numeric_to_string(n: Numeric) -> String {
    let value = n.value();
    let scale = n.scale() as usize;
    let digits = value.unsigned_abs().to_string();
    let sign = if value < 0 { "-" } else { "" };
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = format!("{:0>width$}", digits, width = scale + 1);
    let (int_part, frac_part) = padded.split_at(padded.len() - scale);
    format!("{sign}{int_part}.{frac_part}")
}

/// Fractional seconds with up to 7 digits (SQL Server's max precision),
/// trailing zeros trimmed. Empty when the value has no fraction.
fn fraction(nanos: u32, max_digits: usize) -> String {
    if nanos == 0 {
        return String::new();
    }
    let s = format!("{:09}", nanos);
    let s = &s[..max_digits.min(9)];
    let s = s.trim_end_matches('0');
    if s.is_empty() {
        String::new()
    } else {
        format!(".{s}")
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fffffff]` — the ISO form SQL Server parses back
/// regardless of SET DATEFORMAT / language.
fn datetime_text(dt: NaiveDateTime, max_digits: usize) -> String {
    format!(
        "{}{}",
        dt.format("%Y-%m-%dT%H:%M:%S"),
        fraction(dt.nanosecond(), max_digits)
    )
}

/// Legacy `datetime` ticks are 1/300 s: 299 ticks = .99666… s, which SQL
/// Server displays (and parses back) as .997 — round, don't truncate.
fn round_to_millis(dt: NaiveDateTime) -> NaiveDateTime {
    let rounded_ms = (dt.nanosecond() as i64 + 500_000) / 1_000_000;
    dt.with_nanosecond(0).unwrap_or(dt) + chrono::Duration::milliseconds(rounded_ms)
}

fn time_text(t: NaiveTime) -> String {
    format!("{}{}", t.format("%H:%M:%S"), fraction(t.nanosecond(), 7))
}

fn coldata_to_json(cd: &ColumnData<'static>) -> Value {
    fn or_null<T>(v: Option<T>, f: impl FnOnce(T) -> Value) -> Value {
        v.map(f).unwrap_or(Value::Null)
    }
    match cd {
        ColumnData::U8(v) => or_null(*v, |x| json!(x)),
        ColumnData::I16(v) => or_null(*v, |x| json!(x)),
        ColumnData::I32(v) => or_null(*v, |x| json!(x)),
        ColumnData::I64(v) => or_null(*v, int_value),
        ColumnData::F32(v) => or_null(*v, f32_value),
        ColumnData::F64(v) => or_null(*v, float_value),
        ColumnData::Bit(v) => or_null(*v, Value::Bool),
        ColumnData::String(v) => or_null(v.as_ref(), |s| Value::String(s.to_string())),
        ColumnData::Guid(v) => or_null(*v, |g| Value::String(g.to_string().to_uppercase())),
        ColumnData::Binary(v) => or_null(v.as_ref(), |b| binary_value(b.len())),
        ColumnData::Numeric(v) => or_null(*v, |n| Value::String(numeric_to_string(n))),
        ColumnData::Xml(v) => or_null(v.as_ref(), |x| {
            Value::String(x.as_ref().clone().into_string())
        }),
        ColumnData::DateTime(_) => or_null(NaiveDateTime::from_sql(cd).ok().flatten(), |dt| {
            Value::String(datetime_text(round_to_millis(dt), 3))
        }),
        ColumnData::SmallDateTime(_) => or_null(NaiveDateTime::from_sql(cd).ok().flatten(), |dt| {
            Value::String(datetime_text(dt, 0))
        }),
        ColumnData::DateTime2(_) => or_null(NaiveDateTime::from_sql(cd).ok().flatten(), |dt| {
            Value::String(datetime_text(dt, 7))
        }),
        ColumnData::Date(_) => or_null(NaiveDate::from_sql(cd).ok().flatten(), |d| {
            Value::String(d.format("%Y-%m-%d").to_string())
        }),
        ColumnData::Time(_) => or_null(NaiveTime::from_sql(cd).ok().flatten(), |t| {
            Value::String(time_text(t))
        }),
        ColumnData::DateTimeOffset(v) => or_null(v.as_ref(), |dto| {
            // The wire value is UTC + an offset in minutes; render local time
            // with the offset (`2024-01-02T03:04:05.1234567+02:00`).
            let dt2 = dto.datetime2();
            let date = NaiveDate::from_ymd_opt(1, 1, 1).unwrap_or_default()
                + chrono::Duration::days(dt2.date().days() as i64);
            let scale = dt2.time().scale().min(9) as u32;
            let nanos = dt2.time().increments() as i64 * 10i64.pow(9 - scale);
            let utc =
                NaiveDateTime::new(date, NaiveTime::MIN) + chrono::Duration::nanoseconds(nanos);
            let offset_min = dto.offset() as i32;
            let local = utc + chrono::Duration::minutes(offset_min as i64);
            let sign = if offset_min < 0 { '-' } else { '+' };
            Value::String(format!(
                "{}{}{:02}:{:02}",
                datetime_text(local, 7),
                sign,
                offset_min.abs() / 60,
                offset_min.abs() % 60
            ))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_formatting() {
        assert_eq!(numeric_to_string(Numeric::new_with_scale(150, 2)), "1.50");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(-150, 2)), "-1.50");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(-5, 2)), "-0.05");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(42, 0)), "42");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(0, 3)), "0.000");
    }

    #[test]
    fn legacy_datetime_rounds_to_millis() {
        let base = NaiveDate::from_ymd_opt(2024, 1, 2)
            .unwrap()
            .and_hms_opt(3, 4, 5)
            .unwrap();
        let at =
            |ns: i64| datetime_text(round_to_millis(base + chrono::Duration::nanoseconds(ns)), 3);
        assert_eq!(at(996_666_666), "2024-01-02T03:04:05.997");
        assert_eq!(at(999_666_666), "2024-01-02T03:04:06");
        assert_eq!(at(3_333_333), "2024-01-02T03:04:05.003");
    }

    #[test]
    fn fraction_formatting() {
        assert_eq!(fraction(0, 7), "");
        assert_eq!(fraction(123_000_000, 7), ".123");
        assert_eq!(fraction(123_456_700, 7), ".1234567");
        assert_eq!(fraction(996_666_666, 3), ".996");
    }

    #[test]
    fn batches_split_on_go_and_showplan() {
        assert_eq!(split_batches("SELECT 1"), vec!["SELECT 1"]);
        assert_eq!(
            split_batches("CREATE TABLE t(a int)\nGO\nSELECT 1\n  go  \n"),
            vec!["CREATE TABLE t(a int)\n", "SELECT 1\n"]
        );
        assert_eq!(
            split_batches("SELECT 1\nGO 2\nSELECT 2"),
            vec!["SELECT 1\n", "SELECT 2"]
        );
        // A column/identifier named "go" inside a line isn't a separator.
        assert_eq!(split_batches("SELECT go FROM t"), vec!["SELECT go FROM t"]);
        assert_eq!(
            split_batches("SET SHOWPLAN_TEXT ON;\nSELECT * FROM t"),
            vec!["SET SHOWPLAN_TEXT ON", "\nSELECT * FROM t"]
        );
    }
}
