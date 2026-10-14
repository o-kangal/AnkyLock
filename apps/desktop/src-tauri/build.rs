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
    "folder_set_category",
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
    "settings_get_vault_name",
    "settings_get_device_id",
    "vault_list",
    "vault_create",
    "vault_open",
    "vault_import",
    "sync_list_tombstones",
    "sync_merge_records",
    "sync_detach_folders",
    "oauth_sign_in",
    "oauth_restore",
    "oauth_refresh",
    "oauth_sign_out",
];

/// Compiles the Google OAuth client (a "Desktop app" client, whose secret Google does not treat
/// as confidential) into the binary from `apps/desktop/.env.local` or the environment. It is
/// never exposed to the frontend bundle.
fn load_oauth_client() {
    const KEYS: [&str; 2] = ["ANKYLOCK_GOOGLE_CLIENT_ID", "ANKYLOCK_GOOGLE_CLIENT_SECRET"];
    println!("cargo:rerun-if-changed=../.env.local");
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let Ok(text) = std::fs::read_to_string("../.env.local") else {
        return;
    };
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if KEYS.contains(&key) && std::env::var(key).is_err() {
            println!("cargo:rustc-env={key}={}", value.trim());
        }
    }
}

fn main() {
    load_oauth_client();
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
