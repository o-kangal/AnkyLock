use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::migrations;
use crate::error::{AppError, AppResult};

/// The open vault's SQLite connection, shared by IPC commands. SQLite allows one writer at a
/// time, so a mutex-guarded connection serializes writes without a connection pool. Each vault
/// has its own database file; opening another vault swaps the connection.
#[derive(Default)]
pub struct DbPool(Mutex<Option<Connection>>);

/// Borrow of the open vault's connection.
pub struct Conn<'a>(MutexGuard<'a, Option<Connection>>);

impl Deref for Conn<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().expect("Conn is only created for an open vault")
    }
}

impl DerefMut for Conn<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.0.as_mut().expect("Conn is only created for an open vault")
    }
}

/// Opens a vault database and brings its schema up to date.
pub fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    // `foreign_keys` is per-connection and must be set on every open.
    conn.pragma_update(None, "foreign_keys", true)?;
    migrations::run(&mut conn)?;
    Ok(conn)
}

impl DbPool {
    fn guard(&self) -> MutexGuard<'_, Option<Connection>> {
        // A poisoned lock only means another command panicked mid-call; SQLite's own
        // transactions keep the data consistent, so the connection remains usable.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Fails with `ERR_VAULT_LOCKED` until a vault has been opened.
    pub fn conn(&self) -> AppResult<Conn<'_>> {
        let guard = self.guard();
        if guard.is_none() {
            return Err(AppError::VaultLocked);
        }
        Ok(Conn(guard))
    }

    /// Closes the open vault, if any; storage commands fail with `ERR_VAULT_LOCKED` until the next open.
    pub fn close(&self) {
        *self.guard() = None;
    }

    /// Makes `conn` the open vault, closing the previous one.
    pub fn replace(&self, conn: Connection) {
        *self.guard() = Some(conn);
    }
}
