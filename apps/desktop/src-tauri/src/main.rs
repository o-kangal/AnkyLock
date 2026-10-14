#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod b64;
mod commands;
mod db;
mod error;

use tauri::Manager;

use crate::commands::oauth::{GoogleAuth, KeychainStore, OAuthClient};
use crate::commands::{categories, folders, notes, oauth, outbox, settings};
use crate::db::pool::DbPool;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(GoogleAuth { client: OAuthClient::from_build_env(), store: Box::new(KeychainStore) })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(DbPool::open(&data_dir.join("ankylock.db"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            categories::category_list,
            categories::category_create,
            categories::category_rename,
            categories::category_delete,
            folders::folder_list,
            folders::folder_create,
            folders::folder_move,
            folders::folder_rename,
            folders::folder_list_trashed,
            folders::folder_set_archived,
            folders::folder_trash,
            folders::folder_restore,
            folders::folder_purge,
            notes::note_create,
            notes::note_get,
            notes::note_list,
            notes::note_list_trashed,
            notes::note_move,
            notes::note_set_archived,
            notes::note_trash,
            notes::note_restore,
            notes::note_purge,
            notes::note_discard_ephemeral,
            notes::note_get_content,
            notes::note_save_content,
            outbox::outbox_enqueue,
            outbox::outbox_list,
            outbox::outbox_delete,
            settings::settings_get_retention_days,
            settings::settings_set_retention_days,
            settings::settings_get_vault_header,
            settings::settings_set_vault_header,
            oauth::oauth_sign_in,
            oauth::oauth_restore,
            oauth::oauth_refresh,
            oauth::oauth_sign_out,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AnkyLock");
}
