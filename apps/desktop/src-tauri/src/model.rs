use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Postgres,
    Mysql,
    Mssql,
}

impl DriverKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "postgres" => Some(Self::Postgres),
            "mysql" => Some(Self::Mysql),
            "mssql" => Some(Self::Mssql),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TagColor {
    #[default]
    Neutral,
    Success,
    Warn,
    Danger,
    Info,
    Accent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TagKind {
    System,
    User,
}

impl Default for TagKind {
    fn default() -> Self {
        TagKind::User
    }
}

/// Public connection (no password) — what the UI sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub options: HashMap<String, String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub options: HashMap<String, String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: TagColor,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: TagColor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: TagColor,
    #[serde(default)]
    pub kind: TagKind,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: TagColor,
}

/// Resolved connection (server-side only) with the actual password.
#[derive(Debug, Clone)]
pub struct ResolvedConnection {
    pub id: String,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl: bool,
    pub options: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub is_system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Table,
    View,
    MaterializedView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInfo {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub default: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<serde_json::Value>,
    pub foreign_keys: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<QueryResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub affected_rows: Option<u64>,
    pub duration_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOptions {
    pub schema: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub order_by: Option<Vec<OrderBy>>,
    /// Raw SQL fragment placed after `WHERE`. Trusted input (the operator can
    /// already run arbitrary SQL via the editor).
    #[serde(rename = "where")]
    pub where_clause: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBy {
    pub column: String,
    pub direction: String,
}

pub const QUERY_LIMIT: usize = 5000;
