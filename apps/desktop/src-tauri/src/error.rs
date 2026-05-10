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
    #[error("postgres: {0}")]
    Postgres(#[from] tokio_postgres::Error),
    #[error("mysql: {0}")]
    MySql(#[from] mysql_async::Error),
    #[error("mssql: {0}")]
    MsSql(#[from] tiberius::error::Error),
    #[error("not found")]
    NotFound,
    #[error("unsupported driver: {0}")]
    UnsupportedDriver(String),
}

impl AppError {
    pub fn msg<S: Into<String>>(s: S) -> Self {
        AppError::Generic(s.into())
    }
}

// Tauri commands return strings to the frontend on error.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
