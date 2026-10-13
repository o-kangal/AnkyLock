pub mod migrations;
pub mod pool;

/// In-memory database with all migrations applied and one custom category `cat`.
#[cfg(test)]
pub fn test_conn() -> rusqlite::Connection {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    migrations::run(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO categories (id, name_ciphertext, created_at, updated_at) VALUES ('cat', 'Y2F0', 0, 0)",
        [],
    )
    .unwrap();
    conn
}
