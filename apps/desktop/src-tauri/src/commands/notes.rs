use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::folders::require_writable_folder;
use super::{now_ms, reject_system_category};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub folder_id: Option<String>,
    pub category_id: Option<String>,
    pub is_ephemeral: bool,
    pub is_archived: bool,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Encrypted note body; every field is ciphertext or opaque Yjs bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub note_id: String,
    pub title_ciphertext: String,
    pub content_ciphertext: Vec<u8>,
    pub yjs_state_vector: Vec<u8>,
    pub yjs_updates: Vec<u8>,
    pub updated_at: i64,
}

const NOTE_COLUMNS: &str = "id, folder_id, category_id, is_ephemeral, is_archived, deleted_at, created_at, updated_at";

fn map_note(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        category_id: row.get(2)?,
        is_ephemeral: row.get(3)?,
        is_archived: row.get(4)?,
        deleted_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn find_note(conn: &Connection, id: &str) -> AppResult<Option<Note>> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], map_note).optional()?)
}

fn require_note(conn: &Connection, id: &str) -> AppResult<Note> {
    find_note(conn, id)?.ok_or(AppError::NotFound("Note"))
}

/// Trash is read-only: everything except restore and purge goes through this.
fn require_writable_note(conn: &Connection, id: &str) -> AppResult<Note> {
    let note = require_note(conn, id)?;
    if note.deleted_at.is_some() {
        return Err(AppError::ReadOnlyTrashedEntity);
    }
    Ok(note)
}

fn query_notes(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> AppResult<Vec<Note>> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes WHERE {filter} ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let notes = stmt.query_map(args, map_note)?.collect::<Result<_, _>>()?;
    Ok(notes)
}

/// Notes in a folder, or loose notes when `folder_id` is `None` (BR-HIER-04). Excludes trash.
pub fn list_notes(conn: &Connection, folder_id: Option<&str>) -> AppResult<Vec<Note>> {
    query_notes(conn, "folder_id IS ?1 AND deleted_at IS NULL", [folder_id])
}

pub fn list_trashed_notes(conn: &Connection) -> AppResult<Vec<Note>> {
    query_notes(conn, "deleted_at IS NOT NULL", [])
}

fn update_and_fetch(tx: Transaction<'_>, id: &str, set: &str, args: impl rusqlite::Params) -> AppResult<Note> {
    tx.execute(&format!("UPDATE notes SET {set} WHERE id = ?1"), args)?;
    let note = require_note(&tx, id)?;
    tx.commit()?;
    Ok(note)
}

/// CREATE_TAB: spawns an ephemeral scratchpad (BR-NOTE-01).
pub fn create_note(conn: &mut Connection, id: &str, now: i64) -> AppResult<Note> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO notes (id, is_ephemeral, created_at, updated_at) VALUES (?1, 1, ?2, ?2)",
        params![id, now],
    )?;
    let note = require_note(&tx, id)?;
    tx.commit()?;
    Ok(note)
}

/// ASSIGN_HIERARCHY: files the note under a folder and/or category, organizing scratchpads.
pub fn move_note(
    conn: &mut Connection,
    id: &str,
    folder_id: Option<&str>,
    category_id: Option<&str>,
    now: i64,
) -> AppResult<Note> {
    reject_system_category(category_id)?;
    let tx = conn.transaction()?;
    require_writable_note(&tx, id)?;
    if let Some(folder_id) = folder_id {
        require_writable_folder(&tx, folder_id)?;
    }
    update_and_fetch(
        tx,
        id,
        "folder_id = ?2, category_id = ?3, is_ephemeral = 0, updated_at = ?4",
        params![id, folder_id, category_id, now],
    )
}

pub fn set_note_archived(conn: &mut Connection, id: &str, archived: bool, now: i64) -> AppResult<Note> {
    let tx = conn.transaction()?;
    let note = require_writable_note(&tx, id)?;
    let allowed = if archived {
        !note.is_ephemeral && !note.is_archived
    } else {
        note.is_archived
    };
    if !allowed {
        let action = if archived { "ARCHIVE" } else { "UNARCHIVE" };
        return Err(AppError::InvalidTransition(format!("Cannot {action} note {id} in its current state.")));
    }
    update_and_fetch(tx, id, "is_archived = ?2, updated_at = ?3", params![id, archived, now])
}

/// DELETE: soft-deletes, preserving `folder_id` / `category_id` for restore (BR-LIFE-02).
pub fn trash_note(conn: &mut Connection, id: &str, now: i64) -> AppResult<Note> {
    let tx = conn.transaction()?;
    require_writable_note(&tx, id)?;
    update_and_fetch(tx, id, "deleted_at = ?2, updated_at = ?2", params![id, now])
}

/// RESTORE: clears `deleted_at`. If the former folder was purged, the `ON DELETE SET NULL`
/// foreign key has already reset `folder_id`, placing the note at the All Notes root (BR-LIFE-05).
pub fn restore_note(conn: &mut Connection, id: &str, now: i64) -> AppResult<Note> {
    let tx = conn.transaction()?;
    if require_note(&tx, id)?.deleted_at.is_none() {
        return Err(AppError::InvalidTransition(format!("Note {id} is not in Trash.")));
    }
    update_and_fetch(tx, id, "deleted_at = NULL, is_ephemeral = 0, updated_at = ?2", params![id, now])
}

fn delete_with_tombstone(tx: Transaction<'_>, id: &str, now: i64) -> AppResult<()> {
    tx.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    tx.execute(
        "INSERT OR REPLACE INTO sync_tombstones (entity_id, entity_type, purged_at) VALUES (?1, 'note', ?2)",
        params![id, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// PURGE: hard-deletes a trashed note and records a tombstone in the same transaction.
pub fn purge_note(conn: &mut Connection, id: &str, now: i64) -> AppResult<()> {
    let tx = conn.transaction()?;
    if require_note(&tx, id)?.deleted_at.is_none() {
        return Err(AppError::InvalidTransition(format!("Only notes in Trash can be purged ({id}).")));
    }
    delete_with_tombstone(tx, id, now)
}

/// CLOSE_TAB on an empty, unmodified scratchpad: deletes it without trashing.
/// The caller decides emptiness, since only the client can read the plaintext.
pub fn discard_ephemeral_note(conn: &mut Connection, id: &str, now: i64) -> AppResult<()> {
    let tx = conn.transaction()?;
    if !require_writable_note(&tx, id)?.is_ephemeral {
        return Err(AppError::InvalidTransition(format!("Only scratchpads can be discarded ({id}).")));
    }
    delete_with_tombstone(tx, id, now)
}

pub fn get_note_content(conn: &Connection, note_id: &str) -> AppResult<Option<NoteContent>> {
    Ok(conn
        .query_row(
            "SELECT note_id, title_ciphertext, content_ciphertext, yjs_state_vector, yjs_updates, updated_at
             FROM note_contents WHERE note_id = ?1",
            [note_id],
            |r| {
                Ok(NoteContent {
                    note_id: r.get(0)?,
                    title_ciphertext: r.get(1)?,
                    content_ciphertext: r.get(2)?,
                    yjs_state_vector: r.get(3)?,
                    yjs_updates: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            },
        )
        .optional()?)
}

/// Upserts the encrypted body and bumps the note's `updated_at`. Rejected for trashed notes.
pub fn save_note_content(conn: &mut Connection, content: &NoteContent) -> AppResult<()> {
    let tx = conn.transaction()?;
    require_writable_note(&tx, &content.note_id)?;
    tx.execute(
        "INSERT INTO note_contents
             (note_id, title_ciphertext, content_ciphertext, yjs_state_vector, yjs_updates, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(note_id) DO UPDATE SET
             title_ciphertext = excluded.title_ciphertext,
             content_ciphertext = excluded.content_ciphertext,
             yjs_state_vector = excluded.yjs_state_vector,
             yjs_updates = excluded.yjs_updates,
             updated_at = excluded.updated_at",
        params![
            content.note_id,
            content.title_ciphertext,
            content.content_ciphertext,
            content.yjs_state_vector,
            content.yjs_updates,
            content.updated_at
        ],
    )?;
    tx.execute(
        "UPDATE notes SET updated_at = ?2 WHERE id = ?1",
        params![content.note_id, content.updated_at],
    )?;
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn note_create(db: State<'_, DbPool>, id: String) -> AppResult<Note> {
    create_note(&mut db.conn(), &id, now_ms())
}

#[tauri::command(async)]
pub fn note_get(db: State<'_, DbPool>, id: String) -> AppResult<Option<Note>> {
    find_note(&db.conn(), &id)
}

#[tauri::command(async)]
pub fn note_list(db: State<'_, DbPool>, folder_id: Option<String>) -> AppResult<Vec<Note>> {
    list_notes(&db.conn(), folder_id.as_deref())
}

#[tauri::command(async)]
pub fn note_list_trashed(db: State<'_, DbPool>) -> AppResult<Vec<Note>> {
    list_trashed_notes(&db.conn())
}

#[tauri::command(async)]
pub fn note_move(
    db: State<'_, DbPool>,
    id: String,
    folder_id: Option<String>,
    category_id: Option<String>,
) -> AppResult<Note> {
    move_note(&mut db.conn(), &id, folder_id.as_deref(), category_id.as_deref(), now_ms())
}

#[tauri::command(async)]
pub fn note_set_archived(db: State<'_, DbPool>, id: String, archived: bool) -> AppResult<Note> {
    set_note_archived(&mut db.conn(), &id, archived, now_ms())
}

#[tauri::command(async)]
pub fn note_trash(db: State<'_, DbPool>, id: String) -> AppResult<Note> {
    trash_note(&mut db.conn(), &id, now_ms())
}

#[tauri::command(async)]
pub fn note_restore(db: State<'_, DbPool>, id: String) -> AppResult<Note> {
    restore_note(&mut db.conn(), &id, now_ms())
}

#[tauri::command(async)]
pub fn note_purge(db: State<'_, DbPool>, id: String) -> AppResult<()> {
    purge_note(&mut db.conn(), &id, now_ms())
}

#[tauri::command(async)]
pub fn note_discard_ephemeral(db: State<'_, DbPool>, id: String) -> AppResult<()> {
    discard_ephemeral_note(&mut db.conn(), &id, now_ms())
}

#[tauri::command(async)]
pub fn note_get_content(db: State<'_, DbPool>, note_id: String) -> AppResult<Option<NoteContent>> {
    get_note_content(&db.conn(), &note_id)
}

#[tauri::command(async)]
pub fn note_save_content(db: State<'_, DbPool>, content: NoteContent) -> AppResult<()> {
    save_note_content(&mut db.conn(), &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::folders::create_folder;
    use crate::db::test_conn;

    const T: i64 = 1_776_100_000_000;

    fn code<T: std::fmt::Debug>(result: AppResult<T>) -> &'static str {
        result.unwrap_err().code()
    }

    fn content(note_id: &str, updated_at: i64) -> NoteContent {
        NoteContent {
            note_id: note_id.into(),
            title_ciphertext: "dGl0bGU=".into(),
            content_ciphertext: vec![1, 2, 3],
            yjs_state_vector: vec![0],
            yjs_updates: vec![4, 5],
            updated_at,
        }
    }

    fn tombstones(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sync_tombstones WHERE entity_type = 'note'", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn create_tab_spawns_an_ephemeral_note() {
        let mut conn = test_conn();
        let note = create_note(&mut conn, "n1", T).unwrap();
        assert!(note.is_ephemeral);
        assert_eq!((note.created_at, note.updated_at), (T, T));
        assert_eq!(list_notes(&conn, None).unwrap(), vec![note]);
    }

    #[test]
    fn saves_and_reads_encrypted_content() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        save_note_content(&mut conn, &content("n1", T + 1)).unwrap();
        let mut updated = content("n1", T + 2);
        updated.yjs_updates = vec![9];
        save_note_content(&mut conn, &updated).unwrap();
        assert_eq!(get_note_content(&conn, "n1").unwrap(), Some(updated));
        assert_eq!(find_note(&conn, "n1").unwrap().unwrap().updated_at, T + 2);
    }

    #[test]
    fn move_organizes_a_scratchpad_into_a_folder() {
        let mut conn = test_conn();
        create_folder(&mut conn, "f", None, None, "Zg==", T).unwrap();
        create_note(&mut conn, "n1", T).unwrap();
        let note = move_note(&mut conn, "n1", Some("f"), Some("cat"), T + 1).unwrap();
        assert!(!note.is_ephemeral);
        assert_eq!(note.folder_id.as_deref(), Some("f"));
        assert_eq!(list_notes(&conn, Some("f")).unwrap().len(), 1);
        assert!(list_notes(&conn, None).unwrap().is_empty());
    }

    #[test]
    fn move_rejects_system_categories() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        for id in ["system_all", "system_archive", "system_trash"] {
            assert_eq!(code(move_note(&mut conn, "n1", None, Some(id), T)), "ERR_SYSTEM_CATEGORY_IMMUTABLE");
        }
    }

    #[test]
    fn move_rejects_missing_or_trashed_folders() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        assert_eq!(code(move_note(&mut conn, "n1", Some("ghost"), None, T)), "ERR_NOT_FOUND");
        create_folder(&mut conn, "f", None, None, "Zg==", T).unwrap();
        conn.execute("UPDATE folders SET deleted_at = ?1", [T]).unwrap();
        assert_eq!(code(move_note(&mut conn, "n1", Some("f"), None, T)), "ERR_READ_ONLY_TRASHED_ENTITY");
    }

    #[test]
    fn archive_lifecycle() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        assert_eq!(code(set_note_archived(&mut conn, "n1", true, T)), "ERR_INVALID_TRANSITION");
        move_note(&mut conn, "n1", None, None, T).unwrap();
        assert!(set_note_archived(&mut conn, "n1", true, T).unwrap().is_archived);
        assert_eq!(code(set_note_archived(&mut conn, "n1", true, T)), "ERR_INVALID_TRANSITION");
        assert!(!set_note_archived(&mut conn, "n1", false, T).unwrap().is_archived);
        assert_eq!(code(set_note_archived(&mut conn, "n1", false, T)), "ERR_INVALID_TRANSITION");
    }

    #[test]
    fn trashed_notes_are_read_only() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        let trashed = trash_note(&mut conn, "n1", T + 1).unwrap();
        assert_eq!(trashed.deleted_at, Some(T + 1));
        assert_eq!(code(save_note_content(&mut conn, &content("n1", T))), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(move_note(&mut conn, "n1", None, None, T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(set_note_archived(&mut conn, "n1", true, T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(trash_note(&mut conn, "n1", T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(discard_ephemeral_note(&mut conn, "n1", T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert!(list_notes(&conn, None).unwrap().is_empty());
        assert_eq!(list_trashed_notes(&conn).unwrap().len(), 1);
    }

    #[test]
    fn trash_preserves_pointers_and_restore_keeps_them() {
        let mut conn = test_conn();
        create_folder(&mut conn, "f", None, None, "Zg==", T).unwrap();
        create_note(&mut conn, "n1", T).unwrap();
        move_note(&mut conn, "n1", Some("f"), Some("cat"), T).unwrap();
        let trashed = trash_note(&mut conn, "n1", T).unwrap();
        assert_eq!(trashed.folder_id.as_deref(), Some("f"));
        let restored = restore_note(&mut conn, "n1", T + 1).unwrap();
        assert_eq!(restored.deleted_at, None);
        assert_eq!(restored.folder_id.as_deref(), Some("f"));
        assert_eq!(restored.category_id.as_deref(), Some("cat"));
    }

    #[test]
    fn restore_falls_back_to_root_when_the_folder_was_purged() {
        let mut conn = test_conn();
        create_folder(&mut conn, "f", None, None, "Zg==", T).unwrap();
        create_note(&mut conn, "n1", T).unwrap();
        move_note(&mut conn, "n1", Some("f"), None, T).unwrap();
        trash_note(&mut conn, "n1", T).unwrap();
        conn.execute("DELETE FROM folders WHERE id = 'f'", []).unwrap();
        let restored = restore_note(&mut conn, "n1", T).unwrap();
        assert_eq!(restored.folder_id, None);
        assert!(!restored.is_ephemeral);
    }

    #[test]
    fn restore_requires_a_trashed_note() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        assert_eq!(code(restore_note(&mut conn, "n1", T)), "ERR_INVALID_TRANSITION");
    }

    #[test]
    fn purge_deletes_note_and_content_and_records_a_tombstone() {
        let mut conn = test_conn();
        create_note(&mut conn, "n1", T).unwrap();
        save_note_content(&mut conn, &content("n1", T)).unwrap();
        assert_eq!(code(purge_note(&mut conn, "n1", T)), "ERR_INVALID_TRANSITION");
        trash_note(&mut conn, "n1", T).unwrap();
        purge_note(&mut conn, "n1", T + 9).unwrap();
        assert_eq!(find_note(&conn, "n1").unwrap(), None);
        assert_eq!(get_note_content(&conn, "n1").unwrap(), None);
        assert_eq!(tombstones(&conn), 1);
        assert_eq!(code(purge_note(&mut conn, "n1", T)), "ERR_NOT_FOUND");
    }

    #[test]
    fn discard_removes_only_scratchpads() {
        let mut conn = test_conn();
        create_note(&mut conn, "scratch", T).unwrap();
        discard_ephemeral_note(&mut conn, "scratch", T).unwrap();
        assert_eq!(find_note(&conn, "scratch").unwrap(), None);
        assert_eq!(tombstones(&conn), 1);

        create_note(&mut conn, "kept", T).unwrap();
        move_note(&mut conn, "kept", None, None, T).unwrap();
        assert_eq!(code(discard_ephemeral_note(&mut conn, "kept", T)), "ERR_INVALID_TRANSITION");
    }

    #[test]
    fn app_error_serializes_as_code_and_message() {
        let err = AppError::ReadOnlyTrashedEntity;
        assert_eq!(err.code(), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(err.to_string(), "Notes in Trash are read-only. Restore the note to edit.");
    }
}
