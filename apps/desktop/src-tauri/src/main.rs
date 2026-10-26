#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod b64;
mod commands;
mod db;
mod error;
#[cfg(target_os = "linux")]
mod window_frame;

use tauri::Manager;

use crate::commands::oauth::{GoogleAuth, KeychainStore, OAuthClient};
use crate::commands::vaults::{self, Vaults};
use crate::commands::{categories, export, folders, links, notes, oauth, outbox, settings, sync};
use crate::db::pool::DbPool;

/// Self-updates only exist for the AppImage, which can replace its own file; .deb and .rpm
/// installs belong to the system's package manager. Without the plugin the app's update check
/// fails quietly and shows nothing.
fn is_appimage() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some()
}

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    if is_appimage() {
        // Downloads are checked against the public key in tauri.conf.json before anything installs.
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .manage(GoogleAuth { client: OAuthClient::from_build_env(), store: Box::new(KeychainStore) })
        .manage(DbPool::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            vaults::adopt_legacy_database(&data_dir, commands::now_ms())?;
            app.manage(Vaults::new(data_dir));
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window_frame::round_corners(&window)?;
            }
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
            folders::folder_set_category,
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
            settings::settings_get_vault_name,
            settings::settings_get_device_id,
            settings::settings_set_vault_name,
            settings::settings_get_sync_state,
            settings::settings_set_sync_state,
            vaults::vault_remove,
            vaults::vault_list,
            vaults::vault_create,
            vaults::vault_open,
            vaults::vault_import,
            sync::sync_list_tombstones,
            sync::sync_merge_records,
            sync::sync_detach_folders,
            export::export_save,
            links::link_open,
            oauth::oauth_sign_in,
            oauth::oauth_restore,
            oauth::oauth_refresh,
            oauth::oauth_sign_out,
            oauth::oauth_revoke,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AnkyLock");
}
