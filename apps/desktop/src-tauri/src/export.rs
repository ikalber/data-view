//! Table / database exports written straight to disk.
//!
//! The text formats mirror `packages/core/src/format-rows.ts` (the streaming
//! `formatBatch*` helpers the web exporter uses) byte for byte, so a file
//! exported from the desktop app matches one downloaded from the web app.

use crate::db;
use crate::db::common::RowSink;
use crate::error::AppResult;
use crate::model::{ColumnInfo, DriverKind, QueryResultColumn, ResolvedConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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
    /// SQL format only: rows per INSERT statement (TS default: 100).
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

const DEFAULT_INSERT_BATCH: u32 = 100;

pub async fn export_table_to_path(
    conn: &ResolvedConnection,
    schema: &str,
    name: &str,
    options: ExportTableOptions,
    path: PathBuf,
) -> AppResult<ExportTableResult> {
    let start = Instant::now();
    let file = File::create(&path)?;
    let mut sink = TableExportSink::new(
        BufWriter::new(file),
        options.format,
        conn.driver,
        schema,
        name,
        options.include_header,
        options.batch_size.unwrap_or(DEFAULT_INSERT_BATCH),
    );
    db::stream_table(
        conn,
        schema,
        name,
        options.where_clause.as_deref(),
        &mut sink,
    )
    .await?;
    let row_count = sink.row_count;
    sink.finish()?.flush()?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportTableResult {
        row_count,
        bytes,
        duration_ms: start.elapsed().as_millis() as u64,
        format: options.format,
        file_path: path.to_string_lossy().into_owned(),
    })
}

/// Streams rows into `W` in one of the export formats. Equivalent to core's
/// `formatBatchPrelude` + `formatBatchBody`/`formatBatchSeparator` +
/// `formatBatchPostlude`, applied row by row.
pub struct TableExportSink<W: Write + Send> {
    w: W,
    format: ExportFormat,
    driver: DriverKind,
    table_ref: String,
    include_header: bool,
    insert_batch: usize,
    columns: Vec<QueryResultColumn>,
    started: bool,
    /// SQL format: VALUES tuples waiting for the next INSERT statement.
    pending: Vec<String>,
    statements: usize,
    pub row_count: usize,
}

impl<W: Write + Send> TableExportSink<W> {
    pub fn new(
        w: W,
        format: ExportFormat,
        driver: DriverKind,
        schema: &str,
        name: &str,
        include_header: bool,
        insert_batch: u32,
    ) -> Self {
        Self {
            w,
            format,
            driver,
            table_ref: format!(
                "{}.{}",
                quote_ident(driver, schema),
                quote_ident(driver, name)
            ),
            include_header,
            insert_batch: insert_batch.max(1) as usize,
            columns: Vec::new(),
            started: false,
            pending: Vec::new(),
            statements: 0,
            row_count: 0,
        }
    }

    fn write_prelude(&mut self) -> std::io::Result<()> {
        match self.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                if self.include_header {
                    let delim = delimiter(self.format);
                    let header = self
                        .columns
                        .iter()
                        .map(|c| csv_escape(&c.name, delim))
                        .collect::<Vec<_>>()
                        .join(delim);
                    write!(self.w, "{}\r\n", header)?;
                }
            }
            ExportFormat::Json => write!(self.w, "[\n")?,
            ExportFormat::Markdown => {
                let head = self
                    .columns
                    .iter()
                    .map(|c| markdown_escape(&c.name))
                    .collect::<Vec<_>>()
                    .join(" | ");
                let sep = self
                    .columns
                    .iter()
                    .map(|_| "---")
                    .collect::<Vec<_>>()
                    .join(" | ");
                write!(self.w, "| {} |\n| {} |\n", head, sep)?;
            }
            ExportFormat::Ndjson | ExportFormat::Sql => {}
        }
        Ok(())
    }

    fn flush_inserts(&mut self) -> std::io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        if self.statements > 0 {
            // formatBatchSeparator("sql")
            write!(self.w, "\n")?;
        }
        let col_list = self
            .columns
            .iter()
            .map(|c| quote_ident(self.driver, &c.name))
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            self.w,
            "INSERT INTO {} ({}) VALUES\n  {};\n",
            self.table_ref,
            col_list,
            self.pending.join(",\n  ")
        )?;
        self.pending.clear();
        self.statements += 1;
        Ok(())
    }

    /// Write the trailing bytes and hand back the writer.
    pub fn finish(mut self) -> AppResult<W> {
        if !self.started {
            // Empty result without column metadata — still a valid file.
            self.write_prelude()?;
            self.started = true;
        }
        self.flush_inserts()?;
        match self.format {
            ExportFormat::Json => write!(self.w, "\n]\n")?,
            ExportFormat::Csv | ExportFormat::Tsv => write!(self.w, "\r\n")?,
            ExportFormat::Markdown => write!(self.w, "\n")?,
            ExportFormat::Ndjson | ExportFormat::Sql => {}
        }
        Ok(self.w)
    }
}

impl<W: Write + Send> RowSink for TableExportSink<W> {
    fn columns(&mut self, columns: &[QueryResultColumn]) -> AppResult<()> {
        self.columns = columns.to_vec();
        self.write_prelude()?;
        self.started = true;
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<()> {
        let first = self.row_count == 0;
        self.row_count += 1;
        match self.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let delim = delimiter(self.format);
                if !first {
                    write!(self.w, "\r\n")?;
                }
                let line = row
                    .iter()
                    .map(|v| csv_escape(&cell_as_string(v), delim))
                    .collect::<Vec<_>>()
                    .join(delim);
                write!(self.w, "{}", line)?;
            }
            ExportFormat::Json => {
                if !first {
                    write!(self.w, ",\n")?;
                }
                write!(self.w, "  {}", row_to_json_object(&row, &self.columns))?;
            }
            ExportFormat::Ndjson => {
                if !first {
                    write!(self.w, "\n")?;
                }
                write!(self.w, "{}", row_to_json_object(&row, &self.columns))?;
            }
            ExportFormat::Markdown => {
                if !first {
                    write!(self.w, "\n")?;
                }
                let cells = row
                    .iter()
                    .map(|v| markdown_escape(&cell_as_string(v)))
                    .collect::<Vec<_>>()
                    .join(" | ");
                write!(self.w, "| {} |", cells)?;
            }
            ExportFormat::Sql => {
                let tuple = sql_tuple(
                    &row,
                    self.columns.iter().map(|c| c.data_type.as_str()),
                    self.driver,
                );
                self.pending.push(tuple);
                if self.pending.len() >= self.insert_batch {
                    self.flush_inserts()?;
                }
            }
        }
        Ok(())
    }
}

pub async fn export_database_to_path(
    conn: &ResolvedConnection,
    options: ExportDatabaseOptions,
    path: PathBuf,
) -> AppResult<ExportDatabaseResult> {
    let start = Instant::now();
    let file = File::create(&path)?;
    let mut w = BufWriter::new(file);
    let driver = conn.driver;

    write!(
        w,
        "-- Data View dump\n-- driver: {}\n-- generated: {}\n-- connection: {}\n\n",
        driver.as_str(),
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        conn.id
    )?;
    if driver == DriverKind::Mysql {
        // SHOW CREATE TABLE carries the FKs; tables are dumped alphabetically,
        // so referenced tables may come later — like mysqldump, relax checks.
        write!(w, "SET FOREIGN_KEY_CHECKS=0;\n\n")?;
    }

    let target_schemas = match &options.schemas {
        Some(v) if !v.is_empty() => v.clone(),
        _ => {
            let all = db::list_schemas(conn).await?;
            all.into_iter()
                .filter(|s| !s.is_system)
                .map(|s| s.name)
                .collect()
        }
    };

    let batch_size = options
        .batch_size
        .unwrap_or(DEFAULT_INSERT_BATCH)
        .clamp(1, 1000);
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
        write!(w, "-- ────────────────────────────────────────────────\n")?;
        write!(w, "-- Schema: {} ({} tablas)\n", schema, tables.len())?;
        write!(w, "-- ────────────────────────────────────────────────\n\n")?;
        if options.include_schema {
            // So the dump restores on a server where the schema doesn't exist.
            write!(w, "{}\n", create_schema_if_missing(driver, schema))?;
        }

        for table in tables {
            table_count += 1;
            let details = db::describe_table(conn, &table.schema, &table.name).await?;
            let id = qualified_ident(driver, &table.schema, &table.name);
            write!(w, "\n-- Table: {}\n", id)?;

            if options.include_schema {
                if options.drop_if_exists {
                    write!(w, "DROP TABLE IF EXISTS {};\n", id)?;
                }
                let ddl = match driver {
                    DriverKind::Mysql => {
                        db::mysql::show_create_table(conn, &table.schema, &table.name)
                            .await?
                            .map(|ddl| {
                                format!(
                                    "{};",
                                    qualify_mysql_create(&ddl, &table.schema, &table.name)
                                )
                            })
                    }
                    _ => None,
                }
                .unwrap_or_else(|| {
                    create_table_sql(driver, &table.schema, &table.name, &details.columns)
                });
                write!(w, "{}\n\n", ddl)?;
            }

            if options.include_data {
                let mut sink = DumpDataSink {
                    w: &mut w,
                    driver,
                    table_ref: id.clone(),
                    columns: &details.columns,
                    batch: batch_size as usize,
                    pending: Vec::new(),
                    rows: 0,
                };
                db::stream_table(conn, &table.schema, &table.name, None, &mut sink).await?;
                sink.flush()?;
                total_rows += sink.rows;
                write!(w, "\n")?;
            }
        }
    }

    if driver == DriverKind::Mysql {
        write!(w, "SET FOREIGN_KEY_CHECKS=1;\n")?;
    }
    write!(w, "\n-- End of dump\n")?;
    w.flush()?;
    drop(w);
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportDatabaseResult {
        bytes,
        duration_ms: start.elapsed().as_millis() as u64,
        table_count,
        row_count: total_rows,
        file_path: path.to_string_lossy().into_owned(),
    })
}

/// INSERT batches for the database dump. Literal typing follows the
/// described column types (like the web exporter).
struct DumpDataSink<'a, W: Write + Send> {
    w: &'a mut W,
    driver: DriverKind,
    table_ref: String,
    columns: &'a [ColumnInfo],
    batch: usize,
    pending: Vec<String>,
    rows: usize,
}

impl<W: Write + Send> DumpDataSink<'_, W> {
    fn flush(&mut self) -> std::io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let col_list = self
            .columns
            .iter()
            .map(|c| quote_ident(self.driver, &c.name))
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            self.w,
            "INSERT INTO {} ({}) VALUES\n  {};\n",
            self.table_ref,
            col_list,
            self.pending.join(",\n  ")
        )?;
        self.pending.clear();
        Ok(())
    }
}

impl<W: Write + Send> RowSink for DumpDataSink<'_, W> {
    fn columns(&mut self, _columns: &[QueryResultColumn]) -> AppResult<()> {
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<()> {
        let tuple = sql_tuple(
            &row,
            self.columns.iter().map(|c| c.data_type.as_str()),
            self.driver,
        );
        self.pending.push(tuple);
        self.rows += 1;
        if self.pending.len() >= self.batch {
            self.flush()?;
        }
        Ok(())
    }
}

fn delimiter(format: ExportFormat) -> &'static str {
    if format == ExportFormat::Tsv {
        "\t"
    } else {
        ","
    }
}

fn is_binary(v: &Value) -> Option<u64> {
    match v {
        Value::Object(map) if map.contains_key("__binary") => {
            Some(map.get("bytes").and_then(Value::as_u64).unwrap_or(0))
        }
        _ => None,
    }
}

/// core `cellAsString`.
fn cell_as_string(v: &Value) -> String {
    if let Some(n) = is_binary(v) {
        return format!("<binary {}B>", n);
    }
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// core `cellAsJson`.
fn cell_as_json(v: &Value) -> Value {
    match is_binary(v) {
        Some(n) => Value::String(format!("<binary {}B>", n)),
        None => v.clone(),
    }
}

/// `JSON.stringify(obj)` where obj is built by assigning `obj[col.name]` in
/// column order: keys keep column order (serde_json's Map would sort them),
/// a repeated name keeps its first position with the last value.
fn row_to_json_object(row: &[Value], columns: &[QueryResultColumn]) -> String {
    let mut entries: Vec<(&str, Value)> = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let v = cell_as_json(row.get(i).unwrap_or(&Value::Null));
        match entries.iter_mut().find(|(k, _)| *k == col.name) {
            Some(entry) => entry.1 = v,
            None => entries.push((col.name.as_str(), v)),
        }
    }
    let body = entries
        .iter()
        .map(|(k, v)| {
            format!(
                "{}:{}",
                serde_json::to_string(k).unwrap_or_default(),
                serde_json::to_string(v).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{}}}", body)
}

fn csv_escape(text: &str, delim: &str) -> String {
    let needs =
        text.contains(delim) || text.contains('"') || text.contains('\n') || text.contains('\r');
    if !needs {
        return text.to_string();
    }
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// core `escapeMarkdownCell`.
fn markdown_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", " ")
        .replace('\n', " ")
}

fn sql_tuple<'a>(
    row: &[Value],
    data_types: impl Iterator<Item = &'a str>,
    driver: DriverKind,
) -> String {
    let vals: Vec<String> = data_types
        .enumerate()
        .map(|(i, dt)| cell_as_sql_literal(row.get(i).unwrap_or(&Value::Null), dt, driver))
        .collect();
    format!("({})", vals.join(", "))
}

/// core `looksNumeric`: /^(int|bigint|…|smallmoney|bit\b)/i (not trimmed).
fn looks_numeric(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "int",
        "bigint",
        "smallint",
        "tinyint",
        "mediumint",
        "integer",
        "number",
        "numeric",
        "decimal",
        "float",
        "double",
        "real",
        "money",
        "smallmoney",
    ];
    if PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    lower.starts_with("bit")
        && !lower[3..]
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric() || c == '_')
            .unwrap_or(false)
}

/// core `looksBoolean`: /^(bool|boolean|tinyint\(1\)|bit\(1\)|bit$)/i on the
/// trimmed type.
fn looks_boolean(data_type: &str) -> bool {
    let lower = data_type.trim().to_ascii_lowercase();
    lower.starts_with("bool")
        || lower.starts_with("tinyint(1)")
        || lower.starts_with("bit(1)")
        || lower == "bit"
}

/// /^-?\d+(\.\d+)?$/
fn is_plain_number(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    !int.is_empty()
        && int.chars().all(|c| c.is_ascii_digit())
        && frac
            .map(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(true)
}

/// core `cellAsSqlLiteral`.
fn cell_as_sql_literal(v: &Value, data_type: &str, driver: DriverKind) -> String {
    let bool_lit = |b: bool| -> String {
        match driver {
            // MySQL stores booleans as tinyint; SQL Server has no TRUE/FALSE.
            DriverKind::Mysql | DriverKind::Mssql => (if b { "1" } else { "0" }).to_string(),
            DriverKind::Postgres => (if b { "TRUE" } else { "FALSE" }).to_string(),
        }
    };
    if is_binary(v).is_some() {
        return "NULL".to_string();
    }
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => bool_lit(*b),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            if looks_boolean(data_type) {
                let t = s.trim().to_lowercase();
                bool_lit(matches!(
                    t.as_str(),
                    "true" | "t" | "1" | "yes" | "y" | "on"
                ))
            } else if looks_numeric(data_type) && is_plain_number(s) {
                s.clone()
            } else {
                quote_string(s, driver)
            }
        }
        other => quote_string(&other.to_string(), driver),
    }
}

/// core `quoteString(text, driver)`.
fn quote_string(s: &str, driver: DriverKind) -> String {
    match driver {
        // Default sql_mode treats backslash as an escape character.
        DriverKind::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        DriverKind::Mssql => format!("N'{}'", s.replace('\'', "''")),
        DriverKind::Postgres => format!("'{}'", s.replace('\'', "''")),
    }
}

/// Postgres keywords that can't be bare identifiers — same list as core's
/// `PG_RESERVED` (over-quoting is harmless).
const PG_RESERVED: &[&str] = &[
    "all",
    "analyse",
    "analyze",
    "and",
    "any",
    "array",
    "as",
    "asc",
    "asymmetric",
    "authorization",
    "between",
    "bigint",
    "binary",
    "bit",
    "boolean",
    "both",
    "case",
    "cast",
    "char",
    "character",
    "check",
    "coalesce",
    "collate",
    "collation",
    "column",
    "concurrently",
    "constraint",
    "create",
    "cross",
    "current_catalog",
    "current_date",
    "current_role",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_user",
    "dec",
    "decimal",
    "default",
    "deferrable",
    "desc",
    "distinct",
    "do",
    "else",
    "end",
    "except",
    "exists",
    "extract",
    "false",
    "fetch",
    "float",
    "for",
    "foreign",
    "freeze",
    "from",
    "full",
    "grant",
    "greatest",
    "group",
    "grouping",
    "having",
    "ilike",
    "in",
    "initially",
    "inner",
    "inout",
    "int",
    "integer",
    "intersect",
    "interval",
    "into",
    "is",
    "isnull",
    "join",
    "lateral",
    "leading",
    "least",
    "left",
    "like",
    "limit",
    "localtime",
    "localtimestamp",
    "national",
    "natural",
    "nchar",
    "none",
    "normalize",
    "not",
    "notnull",
    "null",
    "nullif",
    "numeric",
    "offset",
    "on",
    "only",
    "or",
    "order",
    "out",
    "outer",
    "overlaps",
    "overlay",
    "placing",
    "position",
    "precision",
    "primary",
    "real",
    "references",
    "returning",
    "right",
    "row",
    "select",
    "session_user",
    "setof",
    "similar",
    "smallint",
    "some",
    "substring",
    "symmetric",
    "system_user",
    "table",
    "tablesample",
    "then",
    "time",
    "timestamp",
    "to",
    "trailing",
    "treat",
    "trim",
    "true",
    "union",
    "unique",
    "user",
    "using",
    "values",
    "varchar",
    "variadic",
    "verbose",
    "when",
    "where",
    "window",
    "with",
];

/// core `quoteIdent`: Postgres leaves only plain lowercase non-keywords bare
/// (unquoted identifiers fold to lowercase).
pub fn quote_ident(driver: DriverKind, s: &str) -> String {
    match driver {
        DriverKind::Mysql => format!("`{}`", s.replace('`', "``")),
        DriverKind::Mssql => format!("[{}]", s.replace(']', "]]")),
        DriverKind::Postgres => {
            let mut chars = s.chars();
            let bare = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c == '_')
                && chars
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '$')
                && !PG_RESERVED.contains(&s);
            if bare {
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
        quote_ident(driver, schema),
        quote_ident(driver, name)
    )
}

fn create_schema_if_missing(driver: DriverKind, schema: &str) -> String {
    match driver {
        DriverKind::Postgres => format!(
            "CREATE SCHEMA IF NOT EXISTS {};",
            quote_ident(driver, schema)
        ),
        DriverKind::Mysql => format!(
            "CREATE DATABASE IF NOT EXISTS {};",
            quote_ident(driver, schema)
        ),
        // CREATE SCHEMA must be alone in its batch → wrap it in EXEC.
        DriverKind::Mssql => format!(
            "IF SCHEMA_ID({}) IS NULL EXEC({});",
            quote_string(schema, driver),
            quote_string(
                &format!("CREATE SCHEMA {}", quote_ident(driver, schema)),
                driver
            )
        ),
    }
}

/// `SHOW CREATE TABLE` names the table unqualified; qualify it so the dump
/// recreates it in the right database.
fn qualify_mysql_create(ddl: &str, schema: &str, name: &str) -> String {
    let prefix = format!("CREATE TABLE {}", quote_ident(DriverKind::Mysql, name));
    match ddl.strip_prefix(&prefix) {
        Some(rest) => format!(
            "CREATE TABLE {}{}",
            qualified_ident(DriverKind::Mysql, schema, name),
            rest
        ),
        None => ddl.to_string(),
    }
}

/// `serial` column: an integer whose default draws from a sequence. The dump
/// doesn't recreate sequences, so `DEFAULT nextval('…')` would make the
/// CREATE TABLE fail on a fresh database.
fn pg_serial_type(column: &ColumnInfo) -> Option<&'static str> {
    let default = column.default.as_deref()?;
    if !default.starts_with("nextval(") {
        return None;
    }
    match column.data_type.as_str() {
        "integer" => Some("serial"),
        "bigint" => Some("bigserial"),
        "smallint" => Some("smallserial"),
        _ => None,
    }
}

fn create_table_sql(
    driver: DriverKind,
    schema: &str,
    name: &str,
    columns: &[ColumnInfo],
) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(columns.len() + 1);
    for c in columns {
        let serial = if driver == DriverKind::Postgres {
            pg_serial_type(c)
        } else {
            None
        };
        let data_type = serial
            .map(String::from)
            .unwrap_or_else(|| c.data_type.clone());
        let mut parts = vec![quote_ident(driver, &c.name), data_type];
        match driver {
            DriverKind::Mssql => {
                parts.push(if c.nullable { "NULL" } else { "NOT NULL" }.to_string())
            }
            _ => {
                if !c.nullable {
                    parts.push("NOT NULL".to_string());
                }
            }
        }
        if serial.is_none() {
            if let Some(def) = c.default.as_deref().filter(|d| !d.is_empty()) {
                parts.push(format!("DEFAULT {}", def));
            }
        }
        lines.push(format!("  {}", parts.join(" ")));
    }
    let pk: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_ident(driver, &c.name))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cols(names: &[(&str, &str)]) -> Vec<QueryResultColumn> {
        names
            .iter()
            .map(|(n, t)| QueryResultColumn {
                name: n.to_string(),
                data_type: t.to_string(),
            })
            .collect()
    }

    fn render(
        format: ExportFormat,
        driver: DriverKind,
        columns: &[QueryResultColumn],
        rows: Vec<Vec<Value>>,
        batch: u32,
    ) -> String {
        let mut sink = TableExportSink::new(Vec::new(), format, driver, "public", "t", true, batch);
        sink.columns(columns).unwrap();
        for r in rows {
            sink.row(r).unwrap();
        }
        String::from_utf8(sink.finish().unwrap()).unwrap()
    }

    fn sample() -> (Vec<QueryResultColumn>, Vec<Vec<Value>>) {
        (
            cols(&[("id", "int4"), ("name", "text"), ("data", "bytea")]),
            vec![
                vec![
                    json!(1),
                    json!("a,\"b\""),
                    json!({"__binary": true, "bytes": 3}),
                ],
                vec![json!(2), Value::Null, Value::Null],
            ],
        )
    }

    #[test]
    fn csv_matches_core() {
        let (c, r) = sample();
        assert_eq!(
            render(ExportFormat::Csv, DriverKind::Postgres, &c, r, 100),
            "id,name,data\r\n1,\"a,\"\"b\"\"\",<binary 3B>\r\n2,,\r\n"
        );
    }

    #[test]
    fn tsv_matches_core() {
        let c = cols(&[("a", "text"), ("b\tc", "text")]);
        let out = render(
            ExportFormat::Tsv,
            DriverKind::Postgres,
            &c,
            vec![vec![json!("x\ty"), json!("line\nbreak")]],
            100,
        );
        assert_eq!(out, "a\t\"b\tc\"\r\n\"x\ty\"\t\"line\nbreak\"\r\n");
    }

    #[test]
    fn json_keeps_column_order_and_binary_marker() {
        let c = cols(&[("z", "int4"), ("a", "text"), ("b", "bytea")]);
        let out = render(
            ExportFormat::Json,
            DriverKind::Postgres,
            &c,
            vec![
                vec![json!(1), json!("x"), json!({"__binary": true, "bytes": 2})],
                vec![json!(2), Value::Null, Value::Null],
            ],
            100,
        );
        assert_eq!(
            out,
            "[\n  {\"z\":1,\"a\":\"x\",\"b\":\"<binary 2B>\"},\n  {\"z\":2,\"a\":null,\"b\":null}\n]\n"
        );
    }

    #[test]
    fn json_empty_table() {
        let c = cols(&[("a", "text")]);
        assert_eq!(
            render(ExportFormat::Json, DriverKind::Postgres, &c, vec![], 100),
            "[\n\n]\n"
        );
    }

    #[test]
    fn json_duplicate_column_names_like_js_objects() {
        let c = cols(&[("a", "int4"), ("b", "int4"), ("a", "int4")]);
        assert_eq!(
            row_to_json_object(&[json!(1), json!(2), json!(3)], &c),
            "{\"a\":3,\"b\":2}"
        );
    }

    #[test]
    fn ndjson_matches_core() {
        let (c, r) = sample();
        assert_eq!(
            render(ExportFormat::Ndjson, DriverKind::Postgres, &c, r, 100),
            "{\"id\":1,\"name\":\"a,\\\"b\\\"\",\"data\":\"<binary 3B>\"}\n{\"id\":2,\"name\":null,\"data\":null}"
        );
    }

    #[test]
    fn markdown_escapes_header_and_cells() {
        let c = cols(&[("a|b", "text"), ("c", "bool")]);
        let out = render(
            ExportFormat::Markdown,
            DriverKind::Postgres,
            &c,
            vec![
                vec![json!("x|y\\z\r\nw"), json!(true)],
                vec![Value::Null, json!(false)],
            ],
            100,
        );
        assert_eq!(
            out,
            "| a\\|b | c |\n| --- | --- |\n| x\\|y\\\\z w | true |\n|  | false |\n"
        );
    }

    #[test]
    fn sql_inserts_are_batched() {
        let c = cols(&[("id", "int4"), ("Name", "text")]);
        let rows = (1..=3)
            .map(|i| vec![json!(i), json!(format!("n{i}"))])
            .collect();
        let out = render(ExportFormat::Sql, DriverKind::Postgres, &c, rows, 2);
        assert_eq!(
            out,
            "INSERT INTO public.t (id, \"Name\") VALUES\n  (1, 'n1'),\n  (2, 'n2');\n\
             \nINSERT INTO public.t (id, \"Name\") VALUES\n  (3, 'n3');\n"
        );
    }

    #[test]
    fn sql_empty_table_writes_nothing() {
        let c = cols(&[("id", "int4")]);
        assert_eq!(
            render(ExportFormat::Sql, DriverKind::Postgres, &c, vec![], 100),
            ""
        );
    }

    #[test]
    fn sql_literals_per_driver() {
        use DriverKind::*;
        assert_eq!(cell_as_sql_literal(&json!(true), "bool", Postgres), "TRUE");
        assert_eq!(cell_as_sql_literal(&json!(true), "bit", Mssql), "1");
        assert_eq!(cell_as_sql_literal(&json!(false), "tinyint(1)", Mysql), "0");
        assert_eq!(
            cell_as_sql_literal(&json!("t"), "boolean", Postgres),
            "TRUE"
        );
        assert_eq!(cell_as_sql_literal(&json!(" Yes "), "bit", Mssql), "1");
        assert_eq!(cell_as_sql_literal(&json!("off"), "bool", Mysql), "0");
        assert_eq!(
            cell_as_sql_literal(&json!("12.50"), "numeric(10,2)", Postgres),
            "12.50"
        );
        assert_eq!(cell_as_sql_literal(&json!("-3"), "bigint", Mysql), "-3");
        // Not a plain number → quoted, never emitted bare.
        assert_eq!(
            cell_as_sql_literal(&json!("NaN"), "float8", Postgres),
            "'NaN'"
        );
        assert_eq!(
            cell_as_sql_literal(&json!("1e5"), "numeric", Postgres),
            "'1e5'"
        );
        assert_eq!(
            cell_as_sql_literal(&json!("1 day"), "interval", Postgres),
            "'1 day'"
        );
        assert_eq!(
            cell_as_sql_literal(&json!("C:\\temp 'x'"), "text", Mysql),
            "'C:\\\\temp ''x'''"
        );
        assert_eq!(
            cell_as_sql_literal(&json!("C:\\temp 'x'"), "text", Postgres),
            "'C:\\temp ''x'''"
        );
        assert_eq!(
            cell_as_sql_literal(&json!("ñandú"), "nvarchar", Mssql),
            "N'ñandú'"
        );
        assert_eq!(cell_as_sql_literal(&Value::Null, "text", Mssql), "NULL");
        assert_eq!(
            cell_as_sql_literal(&json!({"__binary": true, "bytes": 4}), "bytea", Postgres),
            "NULL"
        );
        assert_eq!(cell_as_sql_literal(&json!(1.5), "float8", Postgres), "1.5");
    }

    #[test]
    fn type_heuristics_match_core_regexes() {
        assert!(looks_numeric("int4"));
        assert!(looks_numeric("INTERVAL")); // /^int/i, same as core
        assert!(looks_numeric("bit(8)"));
        assert!(looks_numeric("bit"));
        assert!(!looks_numeric("bitmap"));
        assert!(!looks_numeric("varchar"));
        assert!(looks_boolean(" bit "));
        assert!(looks_boolean("boolean"));
        assert!(looks_boolean("tinyint(1) unsigned"));
        assert!(!looks_boolean("bit(8)"));
        assert!(is_plain_number("-12.5"));
        assert!(!is_plain_number("12."));
        assert!(!is_plain_number("+1"));
        assert!(!is_plain_number(""));
    }

    #[test]
    fn identifiers_quoted_like_core() {
        use DriverKind::*;
        assert_eq!(quote_ident(Postgres, "users"), "users");
        assert_eq!(quote_ident(Postgres, "Users"), "\"Users\"");
        assert_eq!(quote_ident(Postgres, "order"), "\"order\"");
        assert_eq!(quote_ident(Postgres, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(Postgres, "1abc"), "\"1abc\"");
        assert_eq!(quote_ident(Postgres, "col$1"), "col$1");
        assert_eq!(quote_ident(Mysql, "we`ird"), "`we``ird`");
        assert_eq!(quote_ident(Mssql, "we]ird"), "[we]]ird]");
    }

    #[test]
    fn mysql_show_create_is_qualified() {
        assert_eq!(
            qualify_mysql_create("CREATE TABLE `t` (\n  `id` int\n)", "db", "t"),
            "CREATE TABLE `db`.`t` (\n  `id` int\n)"
        );
    }

    #[test]
    fn pg_serial_columns_dump_without_sequence_default() {
        let columns = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                is_primary_key: true,
                is_unique: false,
                default: Some("nextval('t_id_seq'::regclass)".into()),
                comment: None,
            },
            ColumnInfo {
                name: "Label".into(),
                data_type: "character varying(20)".into(),
                nullable: true,
                is_primary_key: false,
                is_unique: false,
                default: Some("'x'::character varying".into()),
                comment: None,
            },
        ];
        assert_eq!(
            create_table_sql(DriverKind::Postgres, "public", "t", &columns),
            "CREATE TABLE public.t (\n  id serial NOT NULL,\n  \"Label\" character varying(20) DEFAULT 'x'::character varying,\n  PRIMARY KEY (id)\n);"
        );
        assert_eq!(
            create_table_sql(DriverKind::Mssql, "dbo", "t", &columns[1..]),
            "CREATE TABLE [dbo].[t] (\n  [Label] character varying(20) NULL DEFAULT 'x'::character varying\n);"
        );
    }
}
