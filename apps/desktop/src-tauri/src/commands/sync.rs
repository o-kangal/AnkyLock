use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::categories::Category;
use super::folders::Folder;
use super::notes::Note;
use crate::db::pool::DbPool;
use crate::error::AppResult;

/// A purged entity; it never comes back from another device's records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub entity_id: String,
    pub entity_type: String,
    pub purged_at: i64,
}

/// Category, folder and note records from another device (a hierarchy packet or a snapshot).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteRecords {
    pub categories: Vec<Category>,
    pub folders: Vec<Folder>,
    pub notes: Vec<Note>,
}

pub fn list_tombstones(conn: &Connection) -> AppResult<Vec<Tombstone>> {
    let mut stmt = conn.prepare("SELECT entity_id, entity_type, purged_at FROM sync_tombstones")?;
    let rows = stmt
        .query_map([], |r| Ok(Tombstone { entity_id: r.get(0)?, entity_type: r.get(1)?, purged_at: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn local_clock(tx: &Transaction<'_>, sql: &str, id: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row(sql, [id], |r| r.get(0)).optional()
}

/// Merges another device's records: a record wins unless the local clock is newer (`updated_at`
/// for categories and folders, `meta_updated_at` for notes, whose `updated_at` also moves on text
/// edits). On equal clocks the incoming record wins, so a device's own quick succession of changes
/// (create, then move within one millisecond) arrives intact; packets come in order. Purged ids stay purged. References to rows that don't exist here become NULL, so a
/// merge never fails on order. Text is not touched: it merges through Yjs.
pub fn merge_records(conn: &mut Connection, records: &RemoteRecords) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.pragma_update(None, "defer_foreign_keys", true)?;
    let purged: HashSet<String> = list_tombstones(&tx)?.into_iter().map(|t| t.entity_id).collect();

    for c in records.categories.iter().filter(|c| !c.is_system && !purged.contains(&c.id)) {
        match local_clock(&tx, "SELECT updated_at FROM categories WHERE id = ?1", &c.id)? {
            Some(local) if local > c.updated_at => {}
            Some(_) => {
                tx.execute(
                    "UPDATE categories SET sort_order = ?2, name_ciphertext = ?3, updated_at = ?4 WHERE id = ?1",
                    params![c.id, c.sort_order, c.name_ciphertext, c.updated_at],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO categories (id, is_system, sort_order, name_ciphertext, created_at, updated_at)
                     VALUES (?1, 0, ?2, ?3, ?4, ?5)",
                    params![c.id, c.sort_order, c.name_ciphertext, c.created_at, c.updated_at],
                )?;
            }
        }
    }

    for f in records.folders.iter().filter(|f| !purged.contains(&f.id)) {
        match local_clock(&tx, "SELECT updated_at FROM folders WHERE id = ?1", &f.id)? {
            Some(local) if local > f.updated_at => {}
            Some(_) => {
                tx.execute(
                    "UPDATE folders SET category_id = ?2, parent_id = ?3, name_ciphertext = ?4, is_archived = ?5,
                         archived_at = ?6, deleted_at = ?7, updated_at = ?8 WHERE id = ?1",
                    params![f.id, f.category_id, f.parent_id, f.name_ciphertext, f.is_archived, f.archived_at, f.deleted_at, f.updated_at],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO folders (id, category_id, parent_id, name_ciphertext, is_archived, archived_at, deleted_at, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![f.id, f.category_id, f.parent_id, f.name_ciphertext, f.is_archived, f.archived_at, f.deleted_at, f.created_at, f.updated_at],
                )?;
            }
        }
    }

    for n in records.notes.iter().filter(|n| !purged.contains(&n.id)) {
        match local_clock(&tx, "SELECT meta_updated_at FROM notes WHERE id = ?1", &n.id)? {
            Some(local) if local > n.meta_updated_at => {}
            Some(_) => {
                tx.execute(
                    "UPDATE notes SET folder_id = ?2, category_id = ?3, is_ephemeral = ?4, is_archived = ?5,
                         archived_at = ?6, deleted_at = ?7, meta_updated_at = ?8, updated_at = MAX(updated_at, ?9)
                     WHERE id = ?1",
                    params![n.id, n.folder_id, n.category_id, n.is_ephemeral, n.is_archived, n.archived_at, n.deleted_at, n.meta_updated_at, n.updated_at],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO notes (id, folder_id, category_id, is_ephemeral, is_archived, archived_at, deleted_at, created_at, updated_at, meta_updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![n.id, n.folder_id, n.category_id, n.is_ephemeral, n.is_archived, n.archived_at, n.deleted_at, n.created_at, n.updated_at, n.meta_updated_at],
                )?;
            }
        }
    }

    tx.execute_batch(
        "UPDATE folders SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM folders);
         UPDATE folders SET category_id = NULL WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM categories);
         UPDATE notes SET folder_id = NULL WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM folders);
         UPDATE notes SET category_id = NULL WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM categories);",
    )?;
    tx.commit()?;
    Ok(())
}

/// Moves folders to the root without touching their clocks: a repair every device computes the
/// same way from the same records (cycles and depth after concurrent moves, SPEC §7).
pub fn detach_folders(conn: &mut Connection, ids: &[String]) -> AppResult<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("UPDATE folders SET parent_id = NULL WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_list_tombstones(db: State<'_, DbPool>) -> AppResult<Vec<Tombstone>> {
    list_tombstones(&*db.conn()?)
}

#[tauri::command(async)]
pub fn sync_merge_records(db: State<'_, DbPool>, records: RemoteRecords) -> AppResult<()> {
    merge_records(&mut *db.conn()?, &records)
}

#[tauri::command(async)]
pub fn sync_detach_folders(db: State<'_, DbPool>, ids: Vec<String>) -> AppResult<()> {
    detach_folders(&mut *db.conn()?, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::folders::list_folders;
    use crate::commands::notes::{create_note, find_note, purge_note, trash_note};
    use crate::db::test_conn;

    fn folder(id: &str, parent: Option<&str>, updated_at: i64) -> Folder {
        Folder {
            id: id.into(),
            category_id: None,
            parent_id: parent.map(Into::into),
            name_ciphertext: format!("{id}=="),
            is_archived: false,
            archived_at: None,
            deleted_at: None,
            created_at: 1,
            updated_at,
        }
    }

    fn note(id: &str, folder: Option<&str>, meta: i64) -> Note {
        Note {
            id: id.into(),
            folder_id: folder.map(Into::into),
            category_id: None,
            is_ephemeral: false,
            is_archived: false,
            archived_at: None,
            deleted_at: None,
            created_at: 1,
            updated_at: meta,
            meta_updated_at: meta,
        }
    }

    #[test]
    fn newer_records_win_and_older_ones_are_ignored() {
        let mut conn = test_conn();
        merge_records(&mut conn, &RemoteRecords { folders: vec![folder("a", None, 10)], ..Default::default() }).unwrap();
        let mut renamed = folder("a", None, 20);
        renamed.name_ciphertext = "bmV3".into();
        let mut stale = folder("a", None, 15);
        stale.name_ciphertext = "b2xk".into();
        merge_records(&mut conn, &RemoteRecords { folders: vec![renamed, stale], ..Default::default() }).unwrap();
        assert_eq!(list_folders(&conn).unwrap()[0].name_ciphertext, "bmV3");
    }

    #[test]
    fn note_metadata_follows_its_own_clock_not_text_edits() {
        let mut conn = test_conn();
        merge_records(
            &mut conn,
            &RemoteRecords { folders: vec![folder("f", None, 1)], notes: vec![note("n", Some("f"), 10)], ..Default::default() },
        )
        .unwrap();
        // Text edited here later: updated_at moves, the metadata clock does not.
        conn.execute("UPDATE notes SET updated_at = 99 WHERE id = 'n'", []).unwrap();
        // Another device moved the note to the root at 20: newer metadata, older text edit.
        merge_records(&mut conn, &RemoteRecords { notes: vec![note("n", None, 20)], ..Default::default() }).unwrap();
        let merged = find_note(&conn, "n").unwrap().unwrap();
        assert_eq!((merged.folder_id, merged.meta_updated_at, merged.updated_at), (None, 20, 99));
    }

    #[test]
    fn purged_entities_stay_purged_and_dangling_references_clear() {
        let mut conn = test_conn();
        create_note(&mut conn, "gone", 1).unwrap();
        trash_note(&mut conn, "gone", 2).unwrap();
        purge_note(&mut conn, "gone", 3).unwrap();
        merge_records(
            &mut conn,
            &RemoteRecords {
                folders: vec![folder("child", Some("missing-parent"), 5)],
                notes: vec![note("gone", None, 50), note("orphan", Some("missing-folder"), 5)],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(find_note(&conn, "gone").unwrap().is_none());
        assert_eq!(find_note(&conn, "orphan").unwrap().unwrap().folder_id, None);
        assert_eq!(list_folders(&conn).unwrap()[0].parent_id, None);
        assert_eq!(list_tombstones(&conn).unwrap().len(), 1);
    }

    #[test]
    fn detaches_folders_without_moving_their_clocks() {
        let mut conn = test_conn();
        merge_records(
            &mut conn,
            &RemoteRecords { folders: vec![folder("p", None, 1), folder("c", Some("p"), 7)], ..Default::default() },
        )
        .unwrap();
        detach_folders(&mut conn, &["c".into()]).unwrap();
        let c = list_folders(&conn).unwrap().into_iter().find(|f| f.id == "c").unwrap();
        assert_eq!((c.parent_id, c.updated_at), (None, 7));
    }
}
