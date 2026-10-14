use rusqlite::Connection;

/// Embedded migrations in version order. Append new files; never edit or reorder existing entries.
const MIGRATIONS: &[(&str, &str)] = &[
    ("V1__initial_schema", include_str!("../../../../../migrations/V1__initial_schema.sql")),
    (
        "V20261013224803__add_archived_at",
        include_str!("../../../../../migrations/V20261013224803__add_archived_at.sql"),
    ),
    (
        "V20261014200733__add_sync_clocks",
        include_str!("../../../../../migrations/V20261014200733__add_sync_clocks.sql"),
    ),
];

/// Applies pending migrations; `PRAGMA user_version` counts how many have been applied.
///
/// Leading `PRAGMA` lines run outside the transaction because SQLite ignores or rejects
/// `foreign_keys` / `journal_mode` changes inside one. The remaining statements run atomically.
pub fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    run_up_to(conn, MIGRATIONS.len())
}

fn run_up_to(conn: &mut Connection, target: usize) -> rusqlite::Result<()> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let applied = usize::try_from(applied).unwrap_or(0);
    for (index, (_, sql)) in MIGRATIONS.iter().enumerate().take(target).skip(applied) {
        let (preamble, body) = split_pragma_preamble(sql);
        conn.execute_batch(&preamble)?;
        let tx = conn.transaction()?;
        tx.execute_batch(&body)?;
        tx.pragma_update(None, "user_version", migration_number(index))?;
        tx.commit()?;
        // A migration may switch foreign keys off for a table rebuild; always restore them.
        conn.pragma_update(None, "foreign_keys", true)?;
    }
    Ok(())
}

fn migration_number(index: usize) -> i64 {
    i64::try_from(index + 1).unwrap_or(i64::MAX)
}

fn split_pragma_preamble(sql: &str) -> (String, String) {
    let lines: Vec<&str> = sql.lines().collect();
    let split = lines
        .iter()
        .position(|line| {
            let trimmed = line.trim();
            !(trimmed.is_empty() || trimmed.starts_with("--") || trimmed.starts_with("PRAGMA"))
        })
        .unwrap_or(lines.len());
    (lines[..split].join("\n"), lines[split..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn applies_v1_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert_eq!(
            table_names(&conn),
            [
                "app_settings",
                "categories",
                "folders",
                "note_contents",
                "notes",
                "sync_outbox",
                "sync_tombstones"
            ]
        );
        let version: String = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'schema_version'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len().to_string());
        let fk: bool = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0)).unwrap();
        assert!(fk);
    }

    #[test]
    fn is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        run(&mut conn).unwrap();
        let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(applied, migration_number(MIGRATIONS.len() - 1));
    }

    #[test]
    fn enables_wal_on_file_databases() {
        let dir = std::env::temp_dir().join(format!("ankylock-wal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let mut conn = Connection::open(&path).unwrap();
        run(&mut conn).unwrap();
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(mode, "wal");
    }

    #[test]
    fn passes_integrity_checks() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_up_to(&mut conn, 1).unwrap();
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let fk_violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk_violations, 0);
    }

    #[test]
    fn splits_leading_pragmas_only() {
        let (pre, body) = split_pragma_preamble("PRAGMA a = 1;\n-- note\nPRAGMA b = 2;\n\nCREATE TABLE t (x);\nPRAGMA c;");
        assert_eq!(pre, "PRAGMA a = 1;\n-- note\nPRAGMA b = 2;\n");
        assert_eq!(body, "CREATE TABLE t (x);\nPRAGMA c;");
    }

    #[test]
    fn upgrades_to_sync_clocks_and_keeps_them_moving() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        run_up_to(&mut conn, 2).unwrap();
        conn.execute_batch(
            "INSERT INTO folders (id, name_ciphertext, created_at, updated_at) VALUES ('f', 'x', 1, 1);
             INSERT INTO notes (id, is_ephemeral, created_at, updated_at) VALUES ('n', 1, 1, 40);
             INSERT INTO sync_outbox (entity_id, entity_type, encrypted_payload, created_at) VALUES ('n', 'note', x'00', 1);
             INSERT INTO sync_outbox (entity_id, entity_type, encrypted_payload, created_at) VALUES ('n', 'tombstone', x'00', 2);",
        )
        .unwrap();
        run(&mut conn).unwrap();

        let types: Vec<String> = conn
            .prepare("SELECT packet_type FROM sync_outbox ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(types, ["CRDT_DELTA", "TOMBSTONE"]);
        let meta = |conn: &Connection| -> i64 {
            conn.query_row("SELECT meta_updated_at FROM notes WHERE id = 'n'", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(meta(&conn), 40, "backfilled from updated_at");

        // A text edit moves updated_at only; a move moves the metadata clock too.
        conn.execute("UPDATE notes SET updated_at = 50 WHERE id = 'n'", []).unwrap();
        assert_eq!(meta(&conn), 40);
        conn.execute("UPDATE notes SET folder_id = 'f', is_ephemeral = 0, updated_at = 60 WHERE id = 'n'", []).unwrap();
        assert_eq!(meta(&conn), 60);
        // A merge that sets the clock itself keeps its value.
        conn.execute("UPDATE notes SET folder_id = NULL, meta_updated_at = 55 WHERE id = 'n'", []).unwrap();
        assert_eq!(meta(&conn), 55);
        conn.execute("INSERT INTO notes (id, created_at, updated_at) VALUES ('m', 7, 7)", []).unwrap();
        let inserted: i64 = conn.query_row("SELECT meta_updated_at FROM notes WHERE id = 'm'", [], |r| r.get(0)).unwrap();
        assert_eq!(inserted, 7);
    }

    #[test]
    fn upgrades_v1_data_with_archived_at() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        run_up_to(&mut conn, 1).unwrap();
        conn.execute_batch(
            "INSERT INTO folders (id, name_ciphertext, is_archived, created_at, updated_at) VALUES ('old', 'x', 1, 1, 50);
             INSERT INTO folders (id, name_ciphertext, created_at, updated_at) VALUES ('live', 'x', 1, 60);
             INSERT INTO notes (id, folder_id, is_ephemeral, is_archived, created_at, updated_at) VALUES ('n', 'old', 0, 1, 1, 70);",
        )
        .unwrap();

        run(&mut conn).unwrap();

        let archived_at = |table: &str, id: &str| -> Option<i64> {
            conn.query_row(&format!("SELECT archived_at FROM {table} WHERE id = ?1"), [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(archived_at("folders", "old"), Some(50));
        assert_eq!(archived_at("folders", "live"), None);
        assert_eq!(archived_at("notes", "n"), Some(70));
        let version: String = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'schema_version'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len().to_string());
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let fk_violations: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(fk_violations, 0);
    }
}
