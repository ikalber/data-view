use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Generic(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("postgres: {}", pg_error_message(.0))]
    Postgres(#[from] tokio_postgres::Error),
    #[error("mysql: {0}")]
    MySql(#[from] mysql_async::Error),
    #[error("mssql: {0}")]
    MsSql(#[from] tiberius::error::Error),
    #[error("not found")]
    NotFound,
}

impl AppError {
    pub fn msg<S: Into<String>>(s: S) -> Self {
        AppError::Generic(s.into())
    }
}

/// `tokio_postgres::Error`'s Display only prints the error *kind* ("db error",
/// "error connecting to server"), dropping the server message. Build a useful
/// message from the DbError fields (or the source chain for non-db errors).
fn pg_error_message(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut out = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            out.push_str(&format!("\nDetalle: {detail}"));
        }
        if let Some(hint) = db.hint() {
            out.push_str(&format!("\nSugerencia: {hint}"));
        }
        if let Some(tokio_postgres::error::ErrorPosition::Original(pos)) = db.position() {
            out.push_str(&format!("\nPosición: {pos}"));
        }
        return out;
    }
    let mut out = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        out.push_str(&format!(": {s}"));
        source = s.source();
    }
    out
}

// Tauri commands return strings to the frontend on error.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
