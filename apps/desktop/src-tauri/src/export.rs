use crate::db;
use crate::error::AppResult;
use crate::model::{ColumnInfo, DriverKind, PageOptions, ResolvedConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Ndjson,
    Sql,
    Markdown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTableOptions {
    pub format: ExportFormat,
    #[serde(default, rename = "where")]
    pub where_clause: Option<String>,
    #[serde(default = "default_true")]
    pub include_header: bool,
    #[serde(default)]
    pub batch_size: Option<u32>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTableResult {
    pub row_count: usize,
    pub bytes: u64,
    pub duration_ms: u64,
    pub format: ExportFormat,
    pub file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDatabaseOptions {
    #[serde(default)]
    pub schemas: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub include_schema: bool,
    #[serde(default = "default_true")]
    pub include_data: bool,
    #[serde(default)]
    pub batch_size: Option<u32>,
    #[serde(default)]
    pub drop_if_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDatabaseResult {
    pub bytes: u64,
    pub duration_ms: u64,
    pub table_count: usize,
    pub row_count: usize,
    pub file_path: String,
}

const CHUNK_SIZE: u32 = 1000;

pub async fn export_table_to_path(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: ExportTableOptions,
    path: PathBuf,
) -> AppResult<ExportTableResult> {
    let start = Instant::now();
    let file = File::create(&path)?;
    let mut w = BufWriter::new(file);

    let batch_size = options.batch_size.unwrap_or(CHUNK_SIZE);
    let mut offset: u32 = 0;
    let mut columns: Vec<crate::model::QueryResultColumn> = Vec::new();
    let mut row_count: usize = 0;
    let mut first_batch = true;

    loop {
        let page = db::fetch_table_data(
            conn,
            schema,
            name,
            &PageOptions {
                schema: None,
                limit: Some(batch_size),
                offset: Some(offset),
                order_by: None,
                where_clause: options.where_clause.clone(),
            },
        )
        .await?;

        if columns.is_empty() {
            columns = page.columns.clone();
            write_prelude(&mut w, &options, &columns)?;
        }
        if page.rows.is_empty() {
            break;
        }
        if !first_batch {
            write_separator(&mut w, options.format)?;
        }
        write_body(&mut w, options.format, &columns, &page.rows, conn, schema, name)?;
        first_batch = false;
        row_count += page.rows.len();
        if (page.rows.len() as u32) < batch_size {
            break;
        }
        offset += page.rows.len() as u32;
    }
    if columns.is_empty() {
        // Empty table — emit a valid header anyway.
        write_prelude(&mut w, &options, &columns)?;
    }
    write_postlude(&mut w, options.format)?;
    w.flush()?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportTableResult {
        row_count,
        bytes,
        duration_ms: start.elapsed().as_millis() as u64,
        format: options.format,
        file_path: path.to_string_lossy().into_owned(),
    })
}

pub async fn export_database_to_path(
    conn: &ResolvedConnection,
    options: ExportDatabaseOptions,
    path: PathBuf,
) -> AppResult<ExportDatabaseResult> {
    let start = Instant::now();
    let file = File::create(&path)?;
    let mut w = BufWriter::new(file);

    writeln!(w, "-- Data View dump")?;
    writeln!(w, "-- driver: {:?}", conn.driver)?;
    writeln!(
        w,
        "-- generated: {}",
        chrono::Utc::now().to_rfc3339()
    )?;
    writeln!(w, "-- connection: {}", conn.id)?;
    writeln!(w)?;

    let target_schemas = match &options.schemas {
        Some(v) if !v.is_empty() => v.clone(),
        _ => {
            let all = db::list_schemas(conn).await?;
            all.into_iter().filter(|s| !s.is_system).map(|s| s.name).collect()
        }
    };

    let batch_size = options.batch_size.unwrap_or(100).clamp(1, 1000);
    let mut table_count = 0usize;
    let mut total_rows = 0usize;

    for schema in &target_schemas {
        let relations = db::list_relations(conn, Some(schema)).await?;
        let tables: Vec<_> = relations
            .into_iter()
            .filter(|r| matches!(r.kind, crate::model::RelationKind::Table))
            .collect();
        if tables.is_empty() {
            continue;
        }
        writeln!(w, "-- ────────────────────────────────────────────────")?;
        writeln!(w, "-- Schema: {} ({} tablas)", schema, tables.len())?;
        writeln!(w, "-- ────────────────────────────────────────────────")?;
        writeln!(w)?;

        for table in tables {
            table_count += 1;
            let details = db::describe_table(conn, &table.schema, &table.name).await?;
            let id = qualified_ident(conn.driver.clone(), &table.schema, &table.name);
            writeln!(w, "-- Table: {}", id)?;

            if options.include_schema {
                if options.drop_if_exists {
                    writeln!(w, "DROP TABLE IF EXISTS {};", id)?;
                }
                let ddl = create_table_sql(conn.driver.clone(), &table.schema, &table.name, &details.columns);
                writeln!(w, "{}", ddl)?;
                writeln!(w)?;
            }

            if options.include_data {
                total_rows += dump_table_data(
                    &mut w,
                    conn,
                    &table.schema,
                    &table.name,
                    &details.columns,
                    batch_size,
                )
                .await?;
                writeln!(w)?;
            }
        }
    }

    writeln!(w, "-- End of dump")?;
    w.flush()?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportDatabaseResult {
        bytes,
        duration_ms: start.elapsed().as_millis() as u64,
        table_count,
        row_count: total_rows,
        file_path: path.to_string_lossy().into_owned(),
    })
}

async fn dump_table_data(
    w: &mut BufWriter<File>,
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    columns: &[ColumnInfo],
    batch_size: u32,
) -> AppResult<usize> {
    let id = qualified_ident(conn.driver.clone(), schema, name);
    let col_list = columns
        .iter()
        .map(|c| quote_ident(conn.driver.clone(), &c.name))
        .collect::<Vec<_>>()
        .join(", ");

    let mut offset: u32 = 0;
    let mut rows_emitted = 0usize;
    let mut pending: Vec<String> = Vec::with_capacity(batch_size as usize);

    let flush = |w: &mut BufWriter<File>, pending: &mut Vec<String>| -> std::io::Result<()> {
        if pending.is_empty() {
            return Ok(());
        }
        writeln!(w, "INSERT INTO {} ({}) VALUES", id, col_list)?;
        for (i, tuple) in pending.iter().enumerate() {
            if i + 1 == pending.len() {
                writeln!(w, "  {};", tuple)?;
            } else {
                writeln!(w, "  {},", tuple)?;
            }
        }
        pending.clear();
        Ok(())
    };

    loop {
        let page = db::fetch_table_data(
            conn,
            schema,
            name,
            &PageOptions {
                schema: None,
                limit: Some(CHUNK_SIZE),
                offset: Some(offset),
                order_by: None,
                where_clause: None,
            },
        )
        .await?;
        if page.rows.is_empty() {
            break;
        }
        for row in &page.rows {
            let tuple = row_to_sql_tuple(row, columns, conn.driver.clone());
            pending.push(tuple);
            rows_emitted += 1;
            if pending.len() as u32 >= batch_size {
                flush(w, &mut pending)?;
            }
        }
        if (page.rows.len() as u32) < CHUNK_SIZE {
            break;
        }
        offset += page.rows.len() as u32;
    }
    flush(w, &mut pending)?;
    Ok(rows_emitted)
}

fn write_prelude(
    w: &mut BufWriter<File>,
    opts: &ExportTableOptions,
    columns: &[crate::model::QueryResultColumn],
) -> std::io::Result<()> {
    match opts.format {
        ExportFormat::Csv | ExportFormat::Tsv => {
            if !opts.include_header || columns.is_empty() {
                return Ok(());
            }
            let delim = if matches!(opts.format, ExportFormat::Tsv) {
                "\t"
            } else {
                ","
            };
            let header = columns
                .iter()
                .map(|c| csv_escape(&c.name, delim))
                .collect::<Vec<_>>()
                .join(delim);
            writeln!(w, "{}\r", header)?;
        }
        ExportFormat::Json => {
            write!(w, "[\n")?;
        }
        ExportFormat::Markdown => {
            if columns.is_empty() {
                return Ok(());
            }
            let head = columns
                .iter()
                .map(|c| c.name.replace('|', "\\|"))
                .collect::<Vec<_>>()
                .join(" | ");
            writeln!(w, "| {} |", head)?;
            let sep = columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | ");
            writeln!(w, "| {} |", sep)?;
        }
        ExportFormat::Ndjson | ExportFormat::Sql => {}
    }
    Ok(())
}

fn write_postlude(w: &mut BufWriter<File>, format: ExportFormat) -> std::io::Result<()> {
    match format {
        ExportFormat::Json => writeln!(w, "\n]")?,
        ExportFormat::Csv | ExportFormat::Tsv | ExportFormat::Markdown => writeln!(w)?,
        ExportFormat::Ndjson | ExportFormat::Sql => {}
    }
    Ok(())
}

fn write_separator(w: &mut BufWriter<File>, format: ExportFormat) -> std::io::Result<()> {
    match format {
        ExportFormat::Json => write!(w, ",\n")?,
        ExportFormat::Csv | ExportFormat::Tsv | ExportFormat::Markdown => write!(w, "\r\n")?,
        ExportFormat::Ndjson => write!(w, "\n")?,
        ExportFormat::Sql => write!(w, "\n")?,
    }
    Ok(())
}

fn write_body(
    w: &mut BufWriter<File>,
    format: ExportFormat,
    columns: &[crate::model::QueryResultColumn],
    rows: &[Vec<Value>],
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
) -> std::io::Result<()> {
    match format {
        ExportFormat::Csv | ExportFormat::Tsv => {
            let delim = if matches!(format, ExportFormat::Tsv) { "\t" } else { "," };
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    write!(w, "\r\n")?;
                }
                let line = row
                    .iter()
                    .map(|v| csv_escape(&cell_to_string(v), delim))
                    .collect::<Vec<_>>()
                    .join(delim);
                write!(w, "{}", line)?;
            }
        }
        ExportFormat::Json => {
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    write!(w, ",\n")?;
                }
                let obj = row_to_json_obj(row, columns);
                write!(w, "  {}", serde_json::to_string(&obj).unwrap())?;
            }
        }
        ExportFormat::Ndjson => {
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    write!(w, "\n")?;
                }
                let obj = row_to_json_obj(row, columns);
                write!(w, "{}", serde_json::to_string(&obj).unwrap())?;
            }
        }
        ExportFormat::Sql => {
            let id = qualified_ident(conn.driver.clone(), schema, name);
            let col_list = columns
                .iter()
                .map(|c| quote_ident(conn.driver.clone(), &c.name))
                .collect::<Vec<_>>()
                .join(", ");
            writeln!(w, "INSERT INTO {} ({}) VALUES", id, col_list)?;
            for (i, row) in rows.iter().enumerate() {
                let tuple = row_to_sql_tuple_from_columns(row, columns, conn.driver.clone());
                if i + 1 == rows.len() {
                    writeln!(w, "  {};", tuple)?;
                } else {
                    writeln!(w, "  {},", tuple)?;
                }
            }
        }
        ExportFormat::Markdown => {
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    write!(w, "\n")?;
                }
                let cells = row
                    .iter()
                    .map(|v| cell_to_string(v).replace('\\', "\\\\").replace('|', "\\|").replace('\n', " "))
                    .collect::<Vec<_>>()
                    .join(" | ");
                write!(w, "| {} |", cells)?;
            }
        }
    }
    Ok(())
}

fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn csv_escape(text: &str, delim: &str) -> String {
    let needs = text.contains(delim) || text.contains('"') || text.contains('\n') || text.contains('\r');
    if !needs {
        return text.to_string();
    }
    format!("\"{}\"", text.replace('"', "\"\""))
}

fn row_to_json_obj(row: &[Value], columns: &[crate::model::QueryResultColumn]) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        obj.insert(col.name.clone(), row.get(i).cloned().unwrap_or(Value::Null));
    }
    obj
}

fn row_to_sql_tuple(row: &[Value], columns: &[ColumnInfo], driver: DriverKind) -> String {
    let vals: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, col)| cell_to_sql_literal(row.get(i).unwrap_or(&Value::Null), &col.data_type, driver.clone()))
        .collect();
    format!("({})", vals.join(", "))
}

fn row_to_sql_tuple_from_columns(
    row: &[Value],
    columns: &[crate::model::QueryResultColumn],
    driver: DriverKind,
) -> String {
    let vals: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, col)| cell_to_sql_literal(row.get(i).unwrap_or(&Value::Null), &col.data_type, driver.clone()))
        .collect();
    format!("({})", vals.join(", "))
}

fn cell_to_sql_literal(v: &Value, data_type: &str, driver: DriverKind) -> String {
    let lower = data_type.to_lowercase();
    let is_bool = lower.starts_with("bool")
        || lower == "tinyint(1)"
        || lower == "bit(1)";
    let is_numeric = !is_bool
        && (lower.starts_with("int")
            || lower.starts_with("bigint")
            || lower.starts_with("smallint")
            || lower.starts_with("tinyint")
            || lower.starts_with("mediumint")
            || lower.starts_with("integer")
            || lower.starts_with("number")
            || lower.starts_with("numeric")
            || lower.starts_with("decimal")
            || lower.starts_with("float")
            || lower.starts_with("double")
            || lower.starts_with("real")
            || lower.starts_with("money"));
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => match driver {
            DriverKind::Mysql => (if *b { "1" } else { "0" }).to_string(),
            _ => (if *b { "TRUE" } else { "FALSE" }).to_string(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            if is_bool {
                let truthy = s == "true" || s == "1";
                match driver {
                    DriverKind::Mysql => (if truthy { "1" } else { "0" }).to_string(),
                    _ => (if truthy { "TRUE" } else { "FALSE" }).to_string(),
                }
            } else if is_numeric && s.parse::<f64>().is_ok() {
                s.clone()
            } else {
                quote_string(s)
            }
        }
        Value::Object(map) if map.get("__binary").is_some() => "NULL".to_string(),
        _ => quote_string(&serde_json::to_string(v).unwrap_or_default()),
    }
}

fn quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn quote_ident(driver: DriverKind, s: &str) -> String {
    match driver {
        DriverKind::Mysql => format!("`{}`", s.replace('`', "``")),
        DriverKind::Mssql => format!("[{}]", s.replace(']', "]]")),
        DriverKind::Postgres => {
            let safe = s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !s.is_empty()
                && !s.starts_with(|c: char| c.is_ascii_digit());
            if safe {
                s.to_string()
            } else {
                format!("\"{}\"", s.replace('"', "\"\""))
            }
        }
    }
}

fn qualified_ident(driver: DriverKind, schema: &str, name: &str) -> String {
    format!(
        "{}.{}",
        quote_ident(driver.clone(), schema),
        quote_ident(driver, name)
    )
}

fn create_table_sql(driver: DriverKind, schema: &str, name: &str, columns: &[ColumnInfo]) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(columns.len() + 1);
    for c in columns {
        let mut parts = vec![quote_ident(driver.clone(), &c.name), c.data_type.clone()];
        match driver {
            DriverKind::Mssql => parts.push(if c.nullable { "NULL" } else { "NOT NULL" }.to_string()),
            _ => {
                if !c.nullable {
                    parts.push("NOT NULL".to_string());
                }
            }
        }
        if let Some(def) = &c.default {
            parts.push(format!("DEFAULT {}", def));
        }
        lines.push(format!("  {}", parts.join(" ")));
    }
    let pk: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_ident(driver.clone(), &c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk.join(", ")));
    }
    format!(
        "CREATE TABLE {} (\n{}\n);",
        qualified_ident(driver, schema, name),
        lines.join(",\n")
    )
}
