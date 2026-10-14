use rusqlite::{params, Connection, OptionalExtension};
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

/// Writes the header and the encrypted name of a new vault in one transaction.
pub fn initialize_vault(conn: &mut Connection, header: &str, name_ciphertext: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![VAULT_HEADER_KEY, header],
    )?;
    if inserted == 0 {
        return Err(AppError::InvalidSetting("The vault is already initialized.".into()));
    }
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![VAULT_NAME_KEY, name_ciphertext],
    )?;
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn settings_get_vault_header(db: State<'_, DbPool>) -> AppResult<Option<String>> {
    get_vault_header(&*db.conn()?)
}

#[tauri::command(async)]
pub fn settings_get_vault_name(db: State<'_, DbPool>) -> AppResult<Option<String>> {
    get_vault_name(&*db.conn()?)
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
    fn initializes_the_vault_once() {
        let mut conn = test_conn();
        assert_eq!(get_vault_header(&conn).unwrap(), None);
        assert_eq!(get_vault_name(&conn).unwrap(), None);
        initialize_vault(&mut conn, "{\"version\":1}", "bmFtZQ==").unwrap();
        assert_eq!(get_vault_header(&conn).unwrap().as_deref(), Some("{\"version\":1}"));
        assert_eq!(get_vault_name(&conn).unwrap().as_deref(), Some("bmFtZQ=="));
        assert_eq!(initialize_vault(&mut conn, "{}", "b3RoZXI=").unwrap_err().code(), "ERR_INVALID_SETTING");
        assert_eq!(get_vault_header(&conn).unwrap().as_deref(), Some("{\"version\":1}"));
        assert_eq!(get_vault_name(&conn).unwrap().as_deref(), Some("bmFtZQ=="));
    }
}
