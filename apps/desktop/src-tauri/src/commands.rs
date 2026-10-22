use crate::db;
use crate::error::{AppError, AppResult};
use crate::export::{
    self, ExportDatabaseOptions, ExportDatabaseResult, ExportTableOptions, ExportTableResult,
};
use crate::model::{
    ConnectionConfig, ConnectionInput, ConnectionOverview, CreateIndexOptions, CreateSchemaOptions,
    CreateTableOptions, DropIndexOptions, DropOptions, Folder, FolderInput, PageOptions,
    QueryResult, RelationInfo, SchemaInfo, TableDetails, Tag, TagInput, TestConnectionResult,
};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn list_connections(state: State<AppState>) -> AppResult<Vec<ConnectionConfig>> {
    Ok(state.store()?.list())
}

#[tauri::command]
pub fn get_connection(id: String, state: State<AppState>) -> AppResult<ConnectionConfig> {
    state
        .store()?
        .get(&id)
        .ok_or(crate::error::AppError::NotFound)
}

#[tauri::command]
pub fn save_connection(
    input: ConnectionInput,
    state: State<AppState>,
) -> AppResult<ConnectionConfig> {
    state.store()?.upsert(input)
}

#[tauri::command]
pub fn delete_connection(id: String, state: State<AppState>) -> AppResult<()> {
    state.store()?.delete(&id)
}

#[tauri::command]
pub fn list_folders(state: State<AppState>) -> AppResult<Vec<Folder>> {
    Ok(state.store()?.list_folders())
}

#[tauri::command]
pub fn save_folder(input: FolderInput, state: State<AppState>) -> AppResult<Folder> {
    state.store()?.upsert_folder(input)
}

#[tauri::command]
pub fn delete_folder(id: String, state: State<AppState>) -> AppResult<()> {
    state.store()?.delete_folder(&id)
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> AppResult<Vec<Tag>> {
    Ok(state.store()?.list_tags())
}

#[tauri::command]
pub fn save_tag(input: TagInput, state: State<AppState>) -> AppResult<Tag> {
    state.store()?.upsert_tag(input)
}

#[tauri::command]
pub fn delete_tag(id: String, state: State<AppState>) -> AppResult<()> {
    state.store()?.delete_tag(&id)
}

#[tauri::command]
pub async fn test_connection(
    input: ConnectionInput,
    state: State<'_, AppState>,
) -> AppResult<TestConnectionResult> {
    let conn = state.store()?.resolve_or_input(&input)?;
    db::test(&conn).await
}

#[tauri::command]
pub async fn list_schemas(
    connection_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<SchemaInfo>> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::list_schemas(&conn).await
}

#[tauri::command]
pub async fn list_relations(
    connection_id: String,
    schema: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<RelationInfo>> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::list_relations(&conn, schema.as_deref()).await
}

#[tauri::command]
pub async fn get_connection_overview(
    connection_id: String,
    state: State<'_, AppState>,
) -> AppResult<ConnectionOverview> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::get_connection_overview(&conn).await
}

#[tauri::command]
pub async fn describe_table(
    connection_id: String,
    schema: String,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<TableDetails> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::describe_table(&conn, &schema, &name).await
}

#[tauri::command]
pub async fn run_query(
    connection_id: String,
    sql: String,
    schema: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<QueryResult> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::run_query(&conn, &sql, schema.as_deref()).await
}

#[tauri::command]
pub async fn fetch_table_data(
    connection_id: String,
    schema: String,
    name: String,
    options: Option<PageOptions>,
    state: State<'_, AppState>,
) -> AppResult<QueryResult> {
    let conn = state.store()?.resolve(&connection_id)?;
    let opts = options.unwrap_or_default();
    db::fetch_table_data(&conn, &schema, &name, &opts).await
}

#[tauri::command]
pub async fn export_table(
    connection_id: String,
    schema: String,
    name: String,
    options: ExportTableOptions,
    target_path: String,
    state: State<'_, AppState>,
) -> AppResult<ExportTableResult> {
    let conn = state.store()?.resolve(&connection_id)?;
    let path = PathBuf::from(target_path);
    if path.as_os_str().is_empty() {
        return Err(AppError::msg("ruta de destino vacía"));
    }
    export::export_table_to_path(&conn, &schema, &name, options, path).await
}

#[tauri::command]
pub async fn export_database(
    connection_id: String,
    options: ExportDatabaseOptions,
    target_path: String,
    state: State<'_, AppState>,
) -> AppResult<ExportDatabaseResult> {
    let conn = state.store()?.resolve(&connection_id)?;
    let path = PathBuf::from(target_path);
    if path.as_os_str().is_empty() {
        return Err(AppError::msg("ruta de destino vacía"));
    }
    export::export_database_to_path(&conn, options, path).await
}

#[tauri::command]
pub async fn create_schema(
    connection_id: String,
    options: CreateSchemaOptions,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::create_schema(&conn, &options).await
}

#[tauri::command]
pub async fn create_table(
    connection_id: String,
    options: CreateTableOptions,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::create_table(&conn, &options).await
}

#[tauri::command]
pub async fn drop_table(
    connection_id: String,
    schema: String,
    name: String,
    options: Option<DropOptions>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::drop_table(&conn, &schema, &name, &options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn drop_schema(
    connection_id: String,
    name: String,
    options: Option<DropOptions>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::drop_schema(&conn, &name, &options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn truncate_table(
    connection_id: String,
    schema: String,
    name: String,
    options: Option<DropOptions>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::truncate_table(&conn, &schema, &name, &options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn create_index(
    connection_id: String,
    options: CreateIndexOptions,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::create_index(&conn, &options).await
}

#[tauri::command]
pub async fn drop_index(
    connection_id: String,
    options: DropIndexOptions,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = state.store()?.resolve(&connection_id)?;
    db::drop_index(&conn, &options).await
}

/// Read a UTF-8 text file from disk. Used by the desktop app to open .sql
/// files picked from the OS dialog and load them into a new SQL editor tab.
/// Limited to a generous-but-finite size so an accidental pick of a huge
/// non-SQL file can't lock up the UI.
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    let p = PathBuf::from(&path);
    if p.as_os_str().is_empty() {
        return Err(AppError::msg("ruta vacía"));
    }
    let metadata = tokio::fs::metadata(&p)
        .await
        .map_err(|e| AppError::msg(format!("No se pudo leer {}: {}", path, e)))?;
    if metadata.len() > MAX_BYTES {
        return Err(AppError::msg(format!(
            "Archivo demasiado grande ({} MB; máximo {} MB)",
            metadata.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| AppError::msg(format!("No se pudo leer {}: {}", path, e)))?;
    String::from_utf8(bytes).map_err(|_| AppError::msg("El archivo no parece UTF-8 válido"))
}

/// Write a UTF-8 text file chosen by the user in the OS "save" dialog. The
/// webview can't download Blob URLs reliably (wry cancels `<a download>` on
/// macOS and WebKitGTK silently drops it into ~/Downloads), so client-side
/// exports go through here instead. Returns the bytes written.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> AppResult<u64> {
    let p = PathBuf::from(&path);
    if p.as_os_str().is_empty() {
        return Err(AppError::msg("ruta vacía"));
    }
    tokio::fs::write(&p, contents.as_bytes())
        .await
        .map_err(|e| AppError::msg(format!("No se pudo escribir {}: {}", path, e)))?;
    Ok(contents.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn text_files_round_trip_and_limits() {
        let dir = std::env::temp_dir().join(format!("dvt_rs_files_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("q.sql").to_string_lossy().into_owned();
        assert_eq!(
            write_text_file(path.clone(), "SELECT 'ñ';\n".into())
                .await
                .unwrap(),
            13
        );
        assert_eq!(read_text_file(path.clone()).await.unwrap(), "SELECT 'ñ';\n");

        let bin = dir.join("bin.dat");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        let err = read_text_file(bin.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("UTF-8"));

        let big = dir.join("big.sql");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(16 * 1024 * 1024 + 1).unwrap();
        let err = read_text_file(big.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("demasiado grande"));

        assert!(read_text_file(String::new()).await.is_err());
        assert!(
            read_text_file(dir.join("missing").to_string_lossy().into_owned())
                .await
                .is_err()
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
