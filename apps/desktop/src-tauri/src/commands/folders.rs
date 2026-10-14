use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::State;

use super::categories::require_category;
use super::{now_ms, reject_system_category};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};

/// Mirrors `MAX_FOLDER_DEPTH` in `packages/core/src/constants.ts`.
pub const MAX_FOLDER_DEPTH: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub category_id: Option<String>,
    pub parent_id: Option<String>,
    pub name_ciphertext: String,
    pub is_archived: bool,
    /// When this item was archived; unarchiving a folder restores only items with its timestamp.
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const FOLDER_COLUMNS: &str =
    "id, category_id, parent_id, name_ciphertext, is_archived, deleted_at, created_at, updated_at, archived_at";

fn map_folder(row: &Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        category_id: row.get(1)?,
        parent_id: row.get(2)?,
        name_ciphertext: row.get(3)?,
        is_archived: row.get(4)?,
        archived_at: row.get(8)?,
        deleted_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(crate) fn find_folder(conn: &Connection, id: &str) -> AppResult<Option<Folder>> {
    let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], map_folder).optional()?)
}

/// Loads a folder that may receive children or be edited: it must exist and not be trashed.
pub(crate) fn require_writable_folder(conn: &Connection, id: &str) -> AppResult<Folder> {
    let folder = find_folder(conn, id)?.ok_or(AppError::NotFound("Folder"))?;
    if folder.deleted_at.is_some() {
        return Err(AppError::ReadOnlyTrashedEntity);
    }
    Ok(folder)
}

/// Depth of `id` (a root-level folder is 1). Walks `parent_id` with a visited set so
/// corrupted or remotely merged cyclic data fails instead of looping forever.
/// If `moving` is reached on the way up, the move would create a cycle.
fn depth_of(conn: &Connection, id: &str, moving: Option<&str>) -> AppResult<usize> {
    let mut visited = HashSet::new();
    let mut current = Some(id.to_owned());
    while let Some(folder_id) = current {
        if Some(folder_id.as_str()) == moving || !visited.insert(folder_id.clone()) {
            return Err(AppError::CircularHierarchy);
        }
        current = conn
            .query_row("SELECT parent_id FROM folders WHERE id = ?1", [&folder_id], |r| r.get(0))
            .optional()?
            .flatten();
    }
    Ok(visited.len())
}

/// Height of the subtree under `id` (a leaf is 0), including trashed descendants because
/// restoring them would bring them back under this folder. Capped at `MAX_FOLDER_DEPTH`,
/// which is already too tall to move anywhere.
fn subtree_height(conn: &Connection, id: &str) -> AppResult<usize> {
    let height: i64 = conn.query_row(
        "WITH RECURSIVE sub(id, level) AS (
             SELECT id, 0 FROM folders WHERE id = ?1
             UNION ALL
             SELECT f.id, sub.level + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
             WHERE sub.level < ?2
         )
         SELECT MAX(level) FROM sub",
        params![id, MAX_FOLDER_DEPTH as i64],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(height).unwrap_or(MAX_FOLDER_DEPTH))
}

pub fn list_folders(conn: &Connection) -> AppResult<Vec<Folder>> {
    let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE deleted_at IS NULL ORDER BY created_at");
    let mut stmt = conn.prepare(&sql)?;
    let folders = stmt.query_map([], map_folder)?.collect::<Result<_, _>>()?;
    Ok(folders)
}

/// Creates a folder. A subfolder always inherits its parent's category.
pub fn create_folder(
    conn: &mut Connection,
    id: &str,
    parent_id: Option<&str>,
    category_id: Option<&str>,
    name_ciphertext: &str,
    now: i64,
) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    let category_id = match parent_id {
        Some(parent_id) => {
            let parent = require_writable_folder(&tx, parent_id)?;
            if depth_of(&tx, parent_id, None)? + 1 > MAX_FOLDER_DEPTH {
                return Err(AppError::MaxDepthExceeded);
            }
            parent.category_id
        }
        None => {
            reject_system_category(category_id)?;
            if let Some(category_id) = category_id {
                require_category(&tx, category_id)?;
            }
            category_id.map(str::to_owned)
        }
    };
    tx.execute(
        "INSERT INTO folders (id, category_id, parent_id, name_ciphertext, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, category_id, parent_id, name_ciphertext, now],
    )?;
    let folder = find_folder(&tx, id)?.ok_or(AppError::NotFound("Folder"))?;
    tx.commit()?;
    Ok(folder)
}

/// Reparents a folder (BR-HIER-03, BR-HIER-05). Validation and update share one transaction.
pub fn move_folder(conn: &mut Connection, id: &str, new_parent_id: Option<&str>, now: i64) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    require_writable_folder(&tx, id)?;
    let parent_depth = match new_parent_id {
        Some(parent_id) => {
            require_writable_folder(&tx, parent_id)?;
            depth_of(&tx, parent_id, Some(id))?
        }
        None => 0,
    };
    if parent_depth + 1 + subtree_height(&tx, id)? > MAX_FOLDER_DEPTH {
        return Err(AppError::MaxDepthExceeded);
    }
    tx.execute(
        "UPDATE folders SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, new_parent_id, now],
    )?;
    let folder = find_folder(&tx, id)?.ok_or(AppError::NotFound("Folder"))?;
    tx.commit()?;
    Ok(folder)
}

pub fn rename_folder(conn: &mut Connection, id: &str, name_ciphertext: &str, now: i64) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    require_writable_folder(&tx, id)?;
    tx.execute(
        "UPDATE folders SET name_ciphertext = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name_ciphertext, now],
    )?;
    let folder = find_folder(&tx, id)?.ok_or(AppError::NotFound("Folder"))?;
    tx.commit()?;
    Ok(folder)
}

/// Every folder id in the subtree rooted at `?1`, the root included. `UNION` (not `UNION ALL`)
/// deduplicates rows, so the recursion terminates even on cyclic data.
const SUBTREE: &str =
    "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)";

/// Everything a folder purge removed, mirroring `PurgedEntities` in `packages/core`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct PurgedEntities {
    pub folders: Vec<String>,
    pub notes: Vec<String>,
}

fn require_folder(conn: &Connection, id: &str) -> AppResult<Folder> {
    find_folder(conn, id)?.ok_or(AppError::NotFound("Folder"))
}

fn column_ids(conn: &Connection, sql: &str, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids)
}

pub fn list_trashed_folders(conn: &Connection) -> AppResult<Vec<Folder>> {
    let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let folders = stmt.query_map([], map_folder)?.collect::<Result<_, _>>()?;
    Ok(folders)
}

/// BR-LIFE-01: archiving cascades `is_archived` (stamped with one `archived_at`) to every live,
/// not yet archived descendant. Unarchiving clears only items carrying the folder's `archived_at`,
/// so items archived on their own stay archived. Not allowed under a still-archived parent.
pub fn set_folder_archived(conn: &mut Connection, id: &str, archived: bool, now: i64) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    let folder = require_folder(&tx, id)?;
    if folder.deleted_at.is_some() {
        return Err(AppError::ReadOnlyTrashedEntity);
    }
    if folder.is_archived == archived {
        let state = if archived { "already archived" } else { "not archived" };
        return Err(AppError::InvalidTransition(format!("Folder {id} is {state}.")));
    }
    if !archived {
        if let Some(parent) = folder.parent_id.as_deref().map(|p| find_folder(&tx, p)).transpose()?.flatten() {
            if parent.is_archived {
                return Err(AppError::InvalidTransition("Unarchive the parent folder first.".into()));
            }
        }
    }
    if archived {
        for (table, key) in [("folders", "id"), ("notes", "folder_id")] {
            tx.execute(
                &format!(
                    "{SUBTREE} UPDATE {table} SET is_archived = 1, archived_at = ?2, updated_at = ?2 \
                     WHERE {key} IN sub AND deleted_at IS NULL AND is_archived = 0"
                ),
                params![id, now],
            )?;
        }
    } else {
        for (table, key) in [("folders", "id"), ("notes", "folder_id")] {
            tx.execute(
                &format!(
                    "{SUBTREE} UPDATE {table} SET is_archived = 0, archived_at = NULL, updated_at = ?3 \
                     WHERE {key} IN sub AND deleted_at IS NULL AND is_archived = 1 AND archived_at IS ?2"
                ),
                params![id, folder.archived_at, now],
            )?;
        }
    }
    let folder = require_folder(&tx, id)?;
    tx.commit()?;
    Ok(folder)
}

/// BR-LIFE-02: stamps one `deleted_at` on the folder and every live descendant folder and note,
/// keeping their pointers for restore.
pub fn trash_folder(conn: &mut Connection, id: &str, now: i64) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    require_writable_folder(&tx, id)?;
    tx.execute(
        &format!("{SUBTREE} UPDATE folders SET deleted_at = ?2, updated_at = ?2 WHERE id IN sub AND deleted_at IS NULL"),
        params![id, now],
    )?;
    tx.execute(
        &format!("{SUBTREE} UPDATE notes SET deleted_at = ?2, updated_at = ?2 WHERE folder_id IN sub AND deleted_at IS NULL"),
        params![id, now],
    )?;
    let folder = require_folder(&tx, id)?;
    tx.commit()?;
    Ok(folder)
}

/// Restores the folder and only the descendants trashed together with it (same `deleted_at`).
/// BR-LIFE-05: a purged or trashed parent sends the folder to the root; a purged category is dropped.
pub fn restore_folder(conn: &mut Connection, id: &str, now: i64) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    let folder = require_folder(&tx, id)?;
    let Some(trashed_at) = folder.deleted_at else {
        return Err(AppError::InvalidTransition(format!("Folder {id} is not in Trash.")));
    };
    let parent_is_live = match folder.parent_id.as_deref() {
        Some(parent) => find_folder(&tx, parent)?.is_some_and(|p| p.deleted_at.is_none()),
        None => false,
    };
    let category_exists = match folder.category_id.as_deref() {
        Some(category) => {
            tx.query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", [category], |r| r.get::<_, i64>(0))? > 0
        }
        None => false,
    };
    tx.execute(
        &format!("{SUBTREE} UPDATE folders SET deleted_at = NULL, updated_at = ?3 WHERE id IN sub AND deleted_at = ?2"),
        params![id, trashed_at, now],
    )?;
    tx.execute(
        &format!("{SUBTREE} UPDATE notes SET deleted_at = NULL, updated_at = ?3 WHERE folder_id IN sub AND deleted_at = ?2"),
        params![id, trashed_at, now],
    )?;
    tx.execute(
        "UPDATE folders SET parent_id = ?2, category_id = ?3 WHERE id = ?1",
        params![
            id,
            folder.parent_id.filter(|_| parent_is_live),
            folder.category_id.filter(|_| category_exists)
        ],
    )?;
    let folder = require_folder(&tx, id)?;
    tx.commit()?;
    Ok(folder)
}

/// Hard-deletes a trashed folder with its subtree and the notes inside, writing a tombstone for
/// every purged entity. Live items found under trashed folders are first moved to the root so
/// `ON DELETE CASCADE` can never take them along.
pub fn purge_folder(conn: &mut Connection, id: &str, now: i64) -> AppResult<PurgedEntities> {
    let tx = conn.transaction()?;
    if require_folder(&tx, id)?.deleted_at.is_none() {
        return Err(AppError::InvalidTransition(format!("Only folders in Trash can be purged ({id}).")));
    }
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE folders SET parent_id = NULL WHERE id IN sub AND deleted_at IS NULL \
             AND parent_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL)"
        ),
        [id],
    )?;
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE notes SET folder_id = NULL WHERE folder_id IN sub AND deleted_at IS NULL \
             AND folder_id IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL)"
        ),
        [id],
    )?;
    let purged = PurgedEntities {
        folders: column_ids(&tx, &format!("{SUBTREE} SELECT id FROM sub"), id)?,
        notes: column_ids(&tx, &format!("{SUBTREE} SELECT id FROM notes WHERE folder_id IN sub"), id)?,
    };
    for (table, entity_type, ids) in [("notes", "note", &purged.notes), ("folders", "folder", &purged.folders)] {
        for entity in ids {
            tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [entity])?;
            tx.execute(
                "INSERT OR REPLACE INTO sync_tombstones (entity_id, entity_type, purged_at) VALUES (?1, ?2, ?3)",
                params![entity, entity_type, now],
            )?;
        }
    }
    tx.commit()?;
    Ok(purged)
}

#[tauri::command(async)]
pub fn folder_list(db: State<'_, DbPool>) -> AppResult<Vec<Folder>> {
    list_folders(&*db.conn()?)
}

#[tauri::command(async)]
pub fn folder_create(
    db: State<'_, DbPool>,
    id: String,
    parent_id: Option<String>,
    category_id: Option<String>,
    name_ciphertext: String,
) -> AppResult<Folder> {
    create_folder(
        &mut *db.conn()?,
        &id,
        parent_id.as_deref(),
        category_id.as_deref(),
        &name_ciphertext,
        now_ms(),
    )
}

#[tauri::command(async)]
pub fn folder_move(db: State<'_, DbPool>, id: String, new_parent_id: Option<String>) -> AppResult<Folder> {
    move_folder(&mut *db.conn()?, &id, new_parent_id.as_deref(), now_ms())
}

#[tauri::command(async)]
pub fn folder_rename(db: State<'_, DbPool>, id: String, name_ciphertext: String) -> AppResult<Folder> {
    rename_folder(&mut *db.conn()?, &id, &name_ciphertext, now_ms())
}

#[tauri::command(async)]
pub fn folder_list_trashed(db: State<'_, DbPool>) -> AppResult<Vec<Folder>> {
    list_trashed_folders(&*db.conn()?)
}

#[tauri::command(async)]
pub fn folder_set_archived(db: State<'_, DbPool>, id: String, archived: bool) -> AppResult<Folder> {
    set_folder_archived(&mut *db.conn()?, &id, archived, now_ms())
}

#[tauri::command(async)]
pub fn folder_trash(db: State<'_, DbPool>, id: String) -> AppResult<Folder> {
    trash_folder(&mut *db.conn()?, &id, now_ms())
}

#[tauri::command(async)]
pub fn folder_restore(db: State<'_, DbPool>, id: String) -> AppResult<Folder> {
    restore_folder(&mut *db.conn()?, &id, now_ms())
}

#[tauri::command(async)]
pub fn folder_purge(db: State<'_, DbPool>, id: String) -> AppResult<PurgedEntities> {
    purge_folder(&mut *db.conn()?, &id, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_conn;

    const T: i64 = 1_776_100_000_000;

    fn create(conn: &mut Connection, id: &str, parent: Option<&str>) -> AppResult<Folder> {
        create_folder(conn, id, parent, None, "c2VhbGVk", T)
    }

    /// Builds `Level1 / Level2 / Level3`.
    fn three_levels(conn: &mut Connection) {
        create(conn, "l1", None).unwrap();
        create(conn, "l2", Some("l1")).unwrap();
        create(conn, "l3", Some("l2")).unwrap();
    }

    fn code<T: std::fmt::Debug>(result: AppResult<T>) -> &'static str {
        result.unwrap_err().code()
    }

    #[test]
    fn creates_root_and_nested_folders() {
        let mut conn = test_conn();
        let root = create_folder(&mut conn, "root", None, Some("cat"), "bmFtZQ==", T).unwrap();
        assert_eq!(root.category_id.as_deref(), Some("cat"));
        assert_eq!(root.parent_id, None);
        let child = create_folder(&mut conn, "child", Some("root"), Some("ignored"), "bmFtZQ==", T).unwrap();
        assert_eq!(child.category_id.as_deref(), Some("cat"), "subfolders inherit the parent's category");
        assert_eq!(list_folders(&conn).unwrap().len(), 2);
    }

    #[test]
    fn rejects_system_categories() {
        let mut conn = test_conn();
        let result = create_folder(&mut conn, "f", None, Some("system_all"), "Zg==", T);
        assert_eq!(code(result), "ERR_SYSTEM_CATEGORY_IMMUTABLE");
    }

    #[test]
    fn rejects_creating_a_fourth_level() {
        let mut conn = test_conn();
        three_levels(&mut conn);
        assert_eq!(code(create(&mut conn, "l4", Some("l3"))), "ERR_MAX_DEPTH_EXCEEDED");
    }

    #[test]
    fn rejects_moving_a_folder_into_its_own_child() {
        // SPEC §6: Alpha contains Beta; dropping Alpha onto Beta fails.
        let mut conn = test_conn();
        create(&mut conn, "alpha", None).unwrap();
        create(&mut conn, "beta", Some("alpha")).unwrap();
        assert_eq!(code(move_folder(&mut conn, "alpha", Some("beta"), T)), "ERR_CIRCULAR_HIERARCHY");
        assert_eq!(find_folder(&conn, "alpha").unwrap().unwrap().parent_id, None, "position is unchanged");
    }

    #[test]
    fn rejects_moving_a_folder_into_itself_or_a_grandchild() {
        let mut conn = test_conn();
        three_levels(&mut conn);
        assert_eq!(code(move_folder(&mut conn, "l1", Some("l1"), T)), "ERR_CIRCULAR_HIERARCHY");
        assert_eq!(code(move_folder(&mut conn, "l1", Some("l3"), T)), "ERR_CIRCULAR_HIERARCHY");
    }

    #[test]
    fn depth_check_counts_the_moved_subtree() {
        // Moving a 2-level subtree under a level-2 folder would produce depth 4.
        let mut conn = test_conn();
        three_levels(&mut conn);
        create(&mut conn, "a", None).unwrap();
        create(&mut conn, "a-child", Some("a")).unwrap();
        assert_eq!(code(move_folder(&mut conn, "a", Some("l2"), T)), "ERR_MAX_DEPTH_EXCEEDED");
        // A leaf fits under level 2.
        create(&mut conn, "leaf", None).unwrap();
        let moved = move_folder(&mut conn, "leaf", Some("l2"), T + 1).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some("l2"));
        assert_eq!(moved.updated_at, T + 1);
    }

    #[test]
    fn moves_a_folder_to_the_root() {
        let mut conn = test_conn();
        three_levels(&mut conn);
        assert_eq!(move_folder(&mut conn, "l2", None, T).unwrap().parent_id, None);
    }

    #[test]
    fn detects_preexisting_cycles_without_looping() {
        let mut conn = test_conn();
        create(&mut conn, "x", None).unwrap();
        create(&mut conn, "y", Some("x")).unwrap();
        conn.execute("UPDATE folders SET parent_id = 'y' WHERE id = 'x'", []).unwrap();
        create(&mut conn, "z", None).unwrap();
        assert_eq!(code(move_folder(&mut conn, "z", Some("y"), T)), "ERR_CIRCULAR_HIERARCHY");
        assert_eq!(code(create(&mut conn, "w", Some("x"))), "ERR_CIRCULAR_HIERARCHY");
    }

    #[test]
    fn trashed_folders_are_read_only() {
        let mut conn = test_conn();
        create(&mut conn, "trashed", None).unwrap();
        create(&mut conn, "other", None).unwrap();
        conn.execute("UPDATE folders SET deleted_at = ?1 WHERE id = 'trashed'", [T]).unwrap();
        assert_eq!(code(rename_folder(&mut conn, "trashed", "bmV3", T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(move_folder(&mut conn, "trashed", None, T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(move_folder(&mut conn, "other", Some("trashed"), T)), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(code(create(&mut conn, "child", Some("trashed"))), "ERR_READ_ONLY_TRASHED_ENTITY");
        assert_eq!(list_folders(&conn).unwrap().len(), 1);
    }

    #[test]
    fn missing_folders_are_not_found() {
        let mut conn = test_conn();
        assert_eq!(code(move_folder(&mut conn, "ghost", None, T)), "ERR_NOT_FOUND");
        assert_eq!(code(create(&mut conn, "child", Some("ghost"))), "ERR_NOT_FOUND");
        assert_eq!(code(create_folder(&mut conn, "f", None, Some("ghost"), "Zg==", T)), "ERR_NOT_FOUND");
    }

    #[test]
    fn renames_a_folder() {
        let mut conn = test_conn();
        create(&mut conn, "f", None).unwrap();
        let renamed = rename_folder(&mut conn, "f", "bmV3", T + 5).unwrap();
        assert_eq!(renamed.name_ciphertext, "bmV3");
        assert_eq!(renamed.updated_at, T + 5);
    }

    mod lifecycle {
        use super::*;
        use crate::commands::notes::{create_note, find_note, move_note, restore_note, trash_note};

        /// cat ─ a ─ b, with note `na` in `a` and `nb` in `b`.
        fn tree(conn: &mut Connection) {
            create_folder(conn, "a", None, Some("cat"), "YQ==", T).unwrap();
            create_folder(conn, "b", Some("a"), None, "Yg==", T).unwrap();
            for (note, folder) in [("na", "a"), ("nb", "b")] {
                create_note(conn, note, T).unwrap();
                move_note(conn, note, Some(folder), None, T).unwrap();
            }
        }

        fn folder(conn: &Connection, id: &str) -> Folder {
            find_folder(conn, id).unwrap().unwrap()
        }

        #[test]
        fn archive_cascades_and_unarchive_reverses_it() {
            let mut conn = test_conn();
            tree(&mut conn);
            set_folder_archived(&mut conn, "a", true, T + 1).unwrap();
            assert!(folder(&conn, "b").is_archived);
            assert!(find_note(&conn, "nb").unwrap().unwrap().is_archived);
            assert_eq!(code(set_folder_archived(&mut conn, "b", false, T)), "ERR_INVALID_TRANSITION");
            assert_eq!(code(set_folder_archived(&mut conn, "a", true, T)), "ERR_INVALID_TRANSITION");

            set_folder_archived(&mut conn, "a", false, T + 2).unwrap();
            assert!(!folder(&conn, "b").is_archived);
            assert!(!find_note(&conn, "na").unwrap().unwrap().is_archived);
        }

        #[test]
        fn unarchive_keeps_items_archived_on_their_own() {
            let mut conn = test_conn();
            tree(&mut conn);
            crate::commands::notes::set_note_archived(&mut conn, "nb", true, T + 1).unwrap();
            set_folder_archived(&mut conn, "a", true, T + 2).unwrap();
            assert_eq!(find_note(&conn, "nb").unwrap().unwrap().archived_at, Some(T + 1));
            set_folder_archived(&mut conn, "a", false, T + 3).unwrap();
            assert!(!folder(&conn, "b").is_archived);
            assert!(find_note(&conn, "nb").unwrap().unwrap().is_archived, "archived separately before");
            assert!(!find_note(&conn, "na").unwrap().unwrap().is_archived);
        }

        #[test]
        fn trash_cascades_one_timestamp_and_makes_the_subtree_read_only() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_folder(&mut conn, "a", T + 5).unwrap();
            assert_eq!(folder(&conn, "b").deleted_at, Some(T + 5));
            assert_eq!(find_note(&conn, "nb").unwrap().unwrap().deleted_at, Some(T + 5));
            assert_eq!(folder(&conn, "b").parent_id.as_deref(), Some("a"));
            assert_eq!(code(trash_folder(&mut conn, "a", T)), "ERR_READ_ONLY_TRASHED_ENTITY");
            assert_eq!(code(set_folder_archived(&mut conn, "a", true, T)), "ERR_READ_ONLY_TRASHED_ENTITY");
            assert_eq!(list_trashed_folders(&conn).unwrap().len(), 2);
        }

        #[test]
        fn restore_brings_back_only_what_was_trashed_together() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_note(&mut conn, "nb", T + 1).unwrap();
            trash_folder(&mut conn, "a", T + 2).unwrap();
            restore_folder(&mut conn, "a", T + 3).unwrap();
            assert_eq!(folder(&conn, "b").deleted_at, None);
            assert_eq!(find_note(&conn, "na").unwrap().unwrap().deleted_at, None);
            assert_eq!(find_note(&conn, "nb").unwrap().unwrap().deleted_at, Some(T + 1), "trashed separately");
            assert_eq!(code(restore_folder(&mut conn, "a", T)), "ERR_INVALID_TRANSITION");
        }

        #[test]
        fn restore_moves_to_root_when_the_parent_is_still_trashed() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_folder(&mut conn, "a", T + 1).unwrap();
            let restored = restore_folder(&mut conn, "b", T + 2).unwrap();
            assert_eq!((restored.parent_id, restored.deleted_at), (None, None));
            assert_eq!(find_note(&conn, "nb").unwrap().unwrap().deleted_at, None);
        }

        #[test]
        fn restore_drops_a_purged_category() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_folder(&mut conn, "a", T).unwrap();
            conn.execute("DELETE FROM categories WHERE id = 'cat'", []).unwrap();
            assert_eq!(restore_folder(&mut conn, "a", T).unwrap().category_id, None);
        }

        #[test]
        fn restoring_a_note_into_a_trashed_folder_moves_it_to_the_root() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_folder(&mut conn, "a", T).unwrap();
            let note = restore_note(&mut conn, "na", T + 1).unwrap();
            assert_eq!((note.folder_id, note.deleted_at), (None, None));
        }

        #[test]
        fn purge_removes_the_subtree_and_writes_tombstones() {
            let mut conn = test_conn();
            tree(&mut conn);
            assert_eq!(code(purge_folder(&mut conn, "a", T)), "ERR_INVALID_TRANSITION");
            trash_folder(&mut conn, "a", T).unwrap();
            let purged = purge_folder(&mut conn, "a", T + 9).unwrap();
            assert_eq!(purged.folders.len(), 2);
            assert_eq!(purged.notes.len(), 2);
            assert!(find_folder(&conn, "b").unwrap().is_none());
            assert!(find_note(&conn, "nb").unwrap().is_none());
            let tombstones: i64 = conn.query_row("SELECT COUNT(*) FROM sync_tombstones", [], |r| r.get(0)).unwrap();
            assert_eq!(tombstones, 4);
        }

        #[test]
        fn purge_never_takes_live_items_along() {
            let mut conn = test_conn();
            tree(&mut conn);
            trash_folder(&mut conn, "a", T).unwrap();
            // Simulate a live leftover under the trashed tree (e.g. merged from another device).
            conn.execute("UPDATE notes SET deleted_at = NULL WHERE id = 'nb'", []).unwrap();
            let purged = purge_folder(&mut conn, "a", T).unwrap();
            assert!(!purged.notes.contains(&"nb".to_string()));
            assert_eq!(find_note(&conn, "nb").unwrap().unwrap().folder_id, None);
        }
    }
}
