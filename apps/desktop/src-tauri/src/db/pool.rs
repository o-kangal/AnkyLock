use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::migrations;

/// Single SQLite connection shared by IPC commands. SQLite allows one writer at a time,
/// so a mutex-guarded connection serializes writes without a connection pool.
pub struct DbPool(Mutex<Connection>);

impl DbPool {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut conn = Connection::open(path)?;
        // `foreign_keys` is per-connection and must be set on every open.
        conn.pragma_update(None, "foreign_keys", true)?;
        migrations::run(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another command panicked mid-call; SQLite's own
        // transactions keep the data consistent, so the connection remains usable.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
