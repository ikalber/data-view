mod commands;
mod crypto;
mod error;
mod export;
mod model;
mod state;
mod storage;
mod db;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::get_connection,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::list_folders,
            commands::save_folder,
            commands::delete_folder,
            commands::list_tags,
            commands::save_tag,
            commands::delete_tag,
            commands::list_schemas,
            commands::list_relations,
            commands::describe_table,
            commands::run_query,
            commands::fetch_table_data,
            commands::export_table,
            commands::export_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running data-view");
}
