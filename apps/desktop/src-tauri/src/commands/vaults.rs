use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::now_ms;
use super::settings::{get_vault_header, initialize_vault};
use crate::db::pool::{open_database, DbPool};
use crate::error::{AppError, AppResult};

const REGISTRY_FILE: &str = "vaults.json";
/// The single database used before vaults had ids; adopted as the first vault.
const LEGACY_DATABASE: &str = "ankylock.db";

/// A vault on this device. Plaintext by design: only an id and timestamps (BR-SEC-04).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub created_at: i64,
    pub last_opened_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    vaults: Vec<VaultEntry>,
}

/// The app data directory holding `vaults.json` and one `ankylock-<vaultId>.db` per vault.
/// The mutex serializes the registry's read-modify-write cycles.
pub struct Vaults {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Vaults {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    fn locked<T>(&self, work: impl FnOnce(&Path) -> AppResult<T>) -> AppResult<T> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&self.dir)
    }
}

/// Vault ids become file names, so only canonical UUIDs are accepted.
fn validate_id(id: &str) -> AppResult<()> {
    let canonical = id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_digit() || ('a'..='f').contains(&c)
            }
        });
    if canonical {
        Ok(())
    } else {
        Err(AppError::InvalidSetting("Invalid vault id.".into()))
    }
}

fn database_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("ankylock-{id}.db"))
}

fn read_registry(dir: &Path) -> AppResult<Registry> {
    match fs::read(dir.join(REGISTRY_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::Io(std::io::Error::other(e))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(e) => Err(e.into()),
    }
}

/// Writes through a temporary file so a crash never leaves a truncated registry.
fn write_registry(dir: &Path, registry: &Registry) -> AppResult<()> {
    let tmp = dir.join(format!("{REGISTRY_FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(registry).map_err(|e| AppError::Io(std::io::Error::other(e)))?)?;
    fs::rename(tmp, dir.join(REGISTRY_FILE))?;
    Ok(())
}

/// Most recently opened first.
pub fn list(dir: &Path) -> AppResult<Vec<VaultEntry>> {
    let mut vaults = read_registry(dir)?.vaults;
    vaults.sort_by_key(|v| std::cmp::Reverse(v.last_opened_at));
    Ok(vaults)
}

/// Creates the vault's database with its header and encrypted name, then registers it, so the
/// registry never lists a vault that cannot be unlocked.
pub fn create(dir: &Path, id: &str, header: &str, name_ciphertext: &str, now: i64) -> AppResult<(VaultEntry, Connection)> {
    validate_id(id)?;
    let mut registry = read_registry(dir)?;
    let path = database_path(dir, id);
    if registry.vaults.iter().any(|v| v.id == id) || path.exists() {
        return Err(AppError::InvalidSetting("A vault with this id already exists.".into()));
    }
    let mut conn = open_database(&path)?;
    if let Err(error) = initialize_vault(&mut conn, header, name_ciphertext) {
        drop(conn);
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    let entry = VaultEntry { id: id.to_owned(), created_at: now, last_opened_at: now };
    registry.vaults.push(entry.clone());
    write_registry(dir, &registry)?;
    Ok((entry, conn))
}

pub fn open(dir: &Path, id: &str, now: i64) -> AppResult<(VaultEntry, Connection)> {
    validate_id(id)?;
    let mut registry = read_registry(dir)?;
    let entry = registry.vaults.iter_mut().find(|v| v.id == id).ok_or(AppError::NotFound("Vault"))?;
    let conn = open_database(&database_path(dir, id))?;
    entry.last_opened_at = now;
    let entry = entry.clone();
    write_registry(dir, &registry)?;
    Ok((entry, conn))
}

fn new_vault_id() -> AppResult<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

/// Registers the pre-vault-id database (`ankylock.db`) as the first vault, renaming it to its
/// vault file. A database that never got a vault header holds nothing and is left alone.
pub fn adopt_legacy_database(dir: &Path, now: i64) -> AppResult<()> {
    let legacy = dir.join(LEGACY_DATABASE);
    if !legacy.exists() {
        return Ok(());
    }
    let conn = open_database(&legacy)?;
    if get_vault_header(&conn)?.is_none() {
        return Ok(());
    }
    // Fold the WAL into the main file so renaming it moves every committed write.
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    conn.close().map_err(|(_, e)| e)?;
    let created_at = fs::metadata(&legacy)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(now);
    let id = new_vault_id()?;
    fs::rename(&legacy, database_path(dir, &id))?;
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(dir.join(format!("{LEGACY_DATABASE}{suffix}")));
    }
    let mut registry = read_registry(dir)?;
    registry.vaults.push(VaultEntry { id, created_at, last_opened_at: created_at });
    write_registry(dir, &registry)
}

#[tauri::command(async)]
pub fn vault_list(vaults: State<'_, Vaults>) -> AppResult<Vec<VaultEntry>> {
    vaults.locked(list)
}

/// Creates a vault and makes it the open one.
#[tauri::command(async)]
pub fn vault_create(
    vaults: State<'_, Vaults>,
    db: State<'_, DbPool>,
    id: String,
    header: String,
    name_ciphertext: String,
) -> AppResult<VaultEntry> {
    let (entry, conn) = vaults.locked(|dir| create(dir, &id, &header, &name_ciphertext, now_ms()))?;
    db.replace(conn);
    Ok(entry)
}

/// Makes a registered vault the open one; every storage command then works on its database.
#[tauri::command(async)]
pub fn vault_open(vaults: State<'_, Vaults>, db: State<'_, DbPool>, id: String) -> AppResult<VaultEntry> {
    let (entry, conn) = vaults.locked(|dir| open(dir, &id, now_ms()))?;
    db.replace(conn);
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::get_vault_name;

    const ID: &str = "0b6f5c2e-3d1a-4c8e-9f7b-2a1d4e5f6a7b";
    const OTHER: &str = "1c7e9d3a-5b2f-4a6e-8d1c-3f5a7b9e2d4c";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ankylock-vaults-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_isolated_vaults_and_lists_the_last_opened_first() {
        let tmp = TempDir::new("create");
        let (_, first) = create(&tmp.0, ID, "{\"h\":1}", "bmFtZQ==", 10).unwrap();
        let (_, second) = create(&tmp.0, OTHER, "{\"h\":2}", "b3RoZXI=", 20).unwrap();
        assert_eq!(get_vault_header(&first).unwrap().as_deref(), Some("{\"h\":1}"));
        assert_eq!(get_vault_name(&second).unwrap().as_deref(), Some("b3RoZXI="));
        assert_eq!(list(&tmp.0).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), [OTHER, ID]);

        let (entry, reopened) = open(&tmp.0, ID, 30).unwrap();
        assert_eq!((entry.created_at, entry.last_opened_at), (10, 30));
        assert_eq!(get_vault_header(&reopened).unwrap().as_deref(), Some("{\"h\":1}"));
        assert_eq!(list(&tmp.0).unwrap()[0].id, ID);
    }

    #[test]
    fn rejects_duplicate_unknown_and_malformed_ids() {
        let tmp = TempDir::new("reject");
        create(&tmp.0, ID, "{}", "bg==", 1).unwrap();
        assert_eq!(create(&tmp.0, ID, "{}", "bg==", 2).unwrap_err().code(), "ERR_INVALID_SETTING");
        assert_eq!(open(&tmp.0, OTHER, 2).unwrap_err().code(), "ERR_NOT_FOUND");
        for bad in ["../ankylock", "0B6F5C2E-3D1A-4C8E-9F7B-2A1D4E5F6A7B", "", "0b6f5c2e3d1a4c8e9f7b2a1d4e5f6a7b0000"] {
            assert_eq!(create(&tmp.0, bad, "{}", "bg==", 1).unwrap_err().code(), "ERR_INVALID_SETTING", "{bad}");
        }
    }

    #[test]
    fn adopts_the_legacy_database_with_its_data() {
        let tmp = TempDir::new("adopt");
        let legacy = tmp.0.join(LEGACY_DATABASE);
        let mut conn = open_database(&legacy).unwrap();
        initialize_vault(&mut conn, "{\"legacy\":true}", "bg==").unwrap();
        conn.execute(
            "INSERT INTO notes (id, is_ephemeral, created_at, updated_at) VALUES ('n1', 1, 5, 5)",
            [],
        )
        .unwrap();
        drop(conn);

        adopt_legacy_database(&tmp.0, 99).unwrap();
        let vaults = list(&tmp.0).unwrap();
        assert_eq!(vaults.len(), 1);
        assert!(validate_id(&vaults[0].id).is_ok());
        assert!(!legacy.exists());
        let (_, adopted) = open(&tmp.0, &vaults[0].id, 100).unwrap();
        assert_eq!(get_vault_header(&adopted).unwrap().as_deref(), Some("{\"legacy\":true}"));
        let notes: i64 = adopted.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(notes, 1);

        // Running again finds nothing left to adopt.
        adopt_legacy_database(&tmp.0, 101).unwrap();
        assert_eq!(list(&tmp.0).unwrap().len(), 1);
    }

    #[test]
    fn leaves_an_uninitialized_legacy_database_alone() {
        let tmp = TempDir::new("empty");
        drop(open_database(&tmp.0.join(LEGACY_DATABASE)).unwrap());
        adopt_legacy_database(&tmp.0, 1).unwrap();
        assert!(list(&tmp.0).unwrap().is_empty());
        assert!(tmp.0.join(LEGACY_DATABASE).exists());
    }
}
