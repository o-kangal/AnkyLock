/// Every IPC command the frontend may call. Declaring them generates `allow-<command>`
/// permissions; once an app manifest exists, Tauri only permits commands granted by a capability.
const COMMANDS: &[&str] = &[
    "category_list",
    "category_create",
    "category_rename",
    "category_delete",
    "folder_list",
    "folder_create",
    "folder_move",
    "folder_rename",
    "folder_list_trashed",
    "folder_set_archived",
    "folder_trash",
    "folder_restore",
    "folder_purge",
    "note_create",
    "note_get",
    "note_list",
    "note_list_trashed",
    "note_move",
    "note_set_archived",
    "note_trash",
    "note_restore",
    "note_purge",
    "note_discard_ephemeral",
    "note_get_content",
    "note_save_content",
    "outbox_enqueue",
    "outbox_list",
    "outbox_delete",
    "settings_get_retention_days",
    "settings_set_retention_days",
    "settings_get_vault_header",
    "settings_set_vault_header",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
