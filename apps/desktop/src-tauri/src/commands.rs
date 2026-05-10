use crate::db;
use crate::error::AppResult;
use crate::model::{
    ConnectionConfig, ConnectionInput, Folder, FolderInput, PageOptions, QueryResult,
    RelationInfo, SchemaInfo, TableDetails, Tag, TagInput, TestConnectionResult,
};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_connections(state: State<AppState>) -> AppResult<Vec<ConnectionConfig>> {
    Ok(state.store().list())
}

#[tauri::command]
pub fn get_connection(id: String, state: State<AppState>) -> AppResult<ConnectionConfig> {
    state.store().get(&id).ok_or(crate::error::AppError::NotFound)
}

#[tauri::command]
pub fn save_connection(
    input: ConnectionInput,
    state: State<AppState>,
) -> AppResult<ConnectionConfig> {
    state.store().upsert(input)
}

#[tauri::command]
pub fn delete_connection(id: String, state: State<AppState>) -> AppResult<()> {
    state.store().delete(&id)
}

#[tauri::command]
pub fn list_folders(state: State<AppState>) -> AppResult<Vec<Folder>> {
    Ok(state.store().list_folders())
}

#[tauri::command]
pub fn save_folder(input: FolderInput, state: State<AppState>) -> AppResult<Folder> {
    state.store().upsert_folder(input)
}

#[tauri::command]
pub fn delete_folder(id: String, state: State<AppState>) -> AppResult<()> {
    state.store().delete_folder(&id)
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> AppResult<Vec<Tag>> {
    Ok(state.store().list_tags())
}

#[tauri::command]
pub fn save_tag(input: TagInput, state: State<AppState>) -> AppResult<Tag> {
    state.store().upsert_tag(input)
}

#[tauri::command]
pub fn delete_tag(id: String, state: State<AppState>) -> AppResult<()> {
    state.store().delete_tag(&id)
}

#[tauri::command]
pub async fn test_connection(
    input: ConnectionInput,
    state: State<'_, AppState>,
) -> AppResult<TestConnectionResult> {
    let conn = state.store().resolve_or_input(&input)?;
    db::test(&conn).await
}

#[tauri::command]
pub async fn list_schemas(
    connection_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<SchemaInfo>> {
    let conn = state.store().resolve(&connection_id)?;
    db::list_schemas(&conn).await
}

#[tauri::command]
pub async fn list_relations(
    connection_id: String,
    schema: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<RelationInfo>> {
    let conn = state.store().resolve(&connection_id)?;
    db::list_relations(&conn, schema.as_deref()).await
}

#[tauri::command]
pub async fn describe_table(
    connection_id: String,
    schema: String,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<TableDetails> {
    let conn = state.store().resolve(&connection_id)?;
    db::describe_table(&conn, &schema, &name).await
}

#[tauri::command]
pub async fn run_query(
    connection_id: String,
    sql: String,
    state: State<'_, AppState>,
) -> AppResult<QueryResult> {
    let conn = state.store().resolve(&connection_id)?;
    db::run_query(&conn, &sql).await
}

#[tauri::command]
pub async fn fetch_table_data(
    connection_id: String,
    schema: String,
    name: String,
    options: Option<PageOptions>,
    state: State<'_, AppState>,
) -> AppResult<QueryResult> {
    let conn = state.store().resolve(&connection_id)?;
    let opts = options.unwrap_or_default();
    db::fetch_table_data(&conn, &schema, &name, &opts).await
}
