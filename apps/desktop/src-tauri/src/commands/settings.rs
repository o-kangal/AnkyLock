use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};

const RETENTION_KEY: &str = "trash_retention_days";
/// Mirrors `DEFAULT_RETENTION_DAYS` / `MAX_RETENTION_DAYS` in `packages/core/src/constants.ts`.
const DEFAULT_RETENTION_DAYS: u32 = 28;
const MAX_RETENTION_DAYS: u32 = 365;

/// BR-LIFE-03: 0 means manual purge only; otherwise 1..=365 days. V1 seeds the default.
pub fn get_retention_days(conn: &Connection) -> AppResult<u32> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", [RETENTION_KEY], |r| r.get(0))
        .optional()?;
    Ok(raw
        .and_then(|v| v.parse().ok())
        .filter(|days| *days <= MAX_RETENTION_DAYS)
        .unwrap_or(DEFAULT_RETENTION_DAYS))
}

/// Stores the value only; confirming a shorter retention is the client's job (SPEC §6).
pub fn set_retention_days(conn: &Connection, days: u32) -> AppResult<u32> {
    if days > MAX_RETENTION_DAYS {
        return Err(AppError::InvalidSetting(format!(
            "Trash retention must be 0 (manual purge only) or 1 to {MAX_RETENTION_DAYS} days."
        )));
    }
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RETENTION_KEY, days.to_string()],
    )?;
    Ok(days)
}

const VAULT_HEADER_KEY: &str = "vault_header";
const VAULT_NAME_KEY: &str = "vault_name";
const DEVICE_ID_KEY: &str = "device_id";
const NAME_UPDATED_AT_KEY: &str = "vault_name_updated_at";
const HEADER_ON_DRIVE_KEY: &str = "header_on_drive";
const LOCAL_ONLY_KEY: &str = "local_only";

/// How this device relates to the vault's copy in Google Drive.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSyncState {
    /// When the name last changed (0: never renamed); the newer name wins across devices.
    pub name_updated_at: i64,
    /// The vault's header was in Drive once. If it disappears, another device deleted the vault.
    pub header_on_drive: bool,
    /// The user chose to keep this vault on this device only: no sync, no backup.
    pub local_only: bool,
}

fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

/// Serialized vault header (salt, iterations, key check). Not secret, but written only once:
/// replacing it would orphan everything encrypted under the existing key.
pub fn get_vault_header(conn: &Connection) -> AppResult<Option<String>> {
    get_setting(conn, VAULT_HEADER_KEY)
}

/// The vault's name, encrypted like every other name (BR-SEC-04).
pub fn get_vault_name(conn: &Connection) -> AppResult<Option<String>> {
    get_setting(conn, VAULT_NAME_KEY)
}

/// This device's id within the vault, created on first use. It names the device's own Drive
/// snapshot, so devices never overwrite each other's backups.
pub fn device_id(conn: &Connection) -> AppResult<String> {
    conn.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![DEVICE_ID_KEY, super::new_uuid()?],
    )?;
    Ok(get_setting(conn, DEVICE_ID_KEY)?.unwrap_or_default())
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_sync_state(conn: &Connection) -> AppResult<VaultSyncState> {
    let flag = |key| -> AppResult<bool> { Ok(get_setting(conn, key)?.as_deref() == Some("1")) };
    Ok(VaultSyncState {
        name_updated_at: get_setting(conn, NAME_UPDATED_AT_KEY)?.and_then(|v| v.parse().ok()).unwrap_or(0),
        header_on_drive: flag(HEADER_ON_DRIVE_KEY)?,
        local_only: flag(LOCAL_ONLY_KEY)?,
    })
}

pub fn set_sync_state(conn: &mut Connection, state: VaultSyncState) -> AppResult<()> {
    let tx = conn.transaction()?;
    set_setting(&tx, NAME_UPDATED_AT_KEY, &state.name_updated_at.to_string())?;
    set_setting(&tx, HEADER_ON_DRIVE_KEY, if state.header_on_drive { "1" } else { "0" })?;
    set_setting(&tx, LOCAL_ONLY_KEY, if state.local_only { "1" } else { "0" })?;
    tx.commit()?;
    Ok(())
}

/// Renames the vault: the new encrypted name and when it changed, together.
pub fn set_vault_name(conn: &mut Connection, name_ciphertext: &str, updated_at: i64) -> AppResult<()> {
    let tx = conn.transaction()?;
    set_setting(&tx, VAULT_NAME_KEY, name_ciphertext)?;
    set_setting(&tx, NAME_UPDATED_AT_KEY, &updated_at.to_string())?;
    tx.commit()?;
    Ok(())
}

/// Writes the header and the encrypted name of a new vault in one transaction. Vaults created
/// before vaults had names have none.
pub fn initialize_vault(conn: &mut Connection, header: &str, name_ciphertext: Option<&str>) -> AppResult<()> {
    let tx = conn.transaction()?;
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![VAULT_HEADER_KEY, header],
    )?;
    if inserted == 0 {
        return Err(AppError::InvalidSetting("The vault is already initialized.".into()));
    }
    if let Some(name) = name_ciphertext {
        tx.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![VAULT_NAME_KEY, name],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn settings_get_vault_header(db: State<'_, DbPool>) -> AppResult<Option<String>> {
    get_vault_header(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_get_device_id(db: State<'_, DbPool>) -> AppResult<String> {
    device_id(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_get_vault_name(db: State<'_, DbPool>) -> AppResult<Option<String>> {
    get_vault_name(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_set_vault_name(db: State<'_, DbPool>, name_ciphertext: String, updated_at: i64) -> AppResult<()> {
    set_vault_name(&mut *db.conn()?, &name_ciphertext, updated_at)
}

#[tauri::command(async)]
pub fn settings_get_sync_state(db: State<'_, DbPool>) -> AppResult<VaultSyncState> {
    get_sync_state(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_set_sync_state(db: State<'_, DbPool>, state: VaultSyncState) -> AppResult<()> {
    set_sync_state(&mut *db.conn()?, state)
}

#[tauri::command(async)]
pub fn settings_get_retention_days(db: State<'_, DbPool>) -> AppResult<u32> {
    get_retention_days(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_set_retention_days(db: State<'_, DbPool>, days: u32) -> AppResult<u32> {
    set_retention_days(&*db.conn()?, days)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_conn;

    #[test]
    fn reads_the_seeded_default() {
        assert_eq!(get_retention_days(&test_conn()).unwrap(), 28);
    }

    #[test]
    fn stores_valid_values_including_manual_mode() {
        let conn = test_conn();
        for days in [0, 1, 7, 365] {
            assert_eq!(set_retention_days(&conn, days).unwrap(), days);
            assert_eq!(get_retention_days(&conn).unwrap(), days);
        }
    }

    #[test]
    fn rejects_values_above_the_maximum() {
        let conn = test_conn();
        assert_eq!(set_retention_days(&conn, 366).unwrap_err().code(), "ERR_INVALID_SETTING");
        assert_eq!(get_retention_days(&conn).unwrap(), 28);
    }

    #[test]
    fn falls_back_to_the_default_for_corrupt_values() {
        let conn = test_conn();
        conn.execute("UPDATE app_settings SET value = 'soon' WHERE key = ?1", [RETENTION_KEY]).unwrap();
        assert_eq!(get_retention_days(&conn).unwrap(), 28);
    }

    #[test]
    fn renames_and_keeps_the_sync_state() {
        let mut conn = test_conn();
        assert_eq!(get_sync_state(&conn).unwrap(), VaultSyncState::default());
        set_vault_name(&mut conn, "bmV3", 42).unwrap();
        assert_eq!(get_vault_name(&conn).unwrap().as_deref(), Some("bmV3"));
        assert_eq!(get_sync_state(&conn).unwrap().name_updated_at, 42);
        let state = VaultSyncState { name_updated_at: 42, header_on_drive: true, local_only: true };
        set_sync_state(&mut conn, state).unwrap();
        assert_eq!(get_sync_state(&conn).unwrap(), state);
    }

    #[test]
    fn keeps_one_device_id_per_vault() {
        let conn = test_conn();
        let id = device_id(&conn).unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(device_id(&conn).unwrap(), id);
    }

    #[test]
    fn initializes_the_vault_once() {
        let mut conn = test_conn();
        assert_eq!(get_vault_header(&conn).unwrap(), None);
        assert_eq!(get_vault_name(&conn).unwrap(), None);
        initialize_vault(&mut conn, "{\"version\":1}", Some("bmFtZQ==")).unwrap();
        assert_eq!(get_vault_header(&conn).unwrap().as_deref(), Some("{\"version\":1}"));
        assert_eq!(get_vault_name(&conn).unwrap().as_deref(), Some("bmFtZQ=="));
        assert_eq!(initialize_vault(&mut conn, "{}", Some("b3RoZXI=")).unwrap_err().code(), "ERR_INVALID_SETTING");
        assert_eq!(get_vault_header(&conn).unwrap().as_deref(), Some("{\"version\":1}"));
        assert_eq!(get_vault_name(&conn).unwrap().as_deref(), Some("bmFtZQ=="));
    }
}
