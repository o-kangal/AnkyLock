use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::State;

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
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const FOLDER_COLUMNS: &str =
    "id, category_id, parent_id, name_ciphertext, is_archived, deleted_at, created_at, updated_at";

fn map_folder(row: &Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        category_id: row.get(1)?,
        parent_id: row.get(2)?,
        name_ciphertext: row.get(3)?,
        is_archived: row.get(4)?,
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

#[tauri::command(async)]
pub fn folder_list(db: State<'_, DbPool>) -> AppResult<Vec<Folder>> {
    list_folders(&db.conn())
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
        &mut db.conn(),
        &id,
        parent_id.as_deref(),
        category_id.as_deref(),
        &name_ciphertext,
        now_ms(),
    )
}

#[tauri::command(async)]
pub fn folder_move(db: State<'_, DbPool>, id: String, new_parent_id: Option<String>) -> AppResult<Folder> {
    move_folder(&mut db.conn(), &id, new_parent_id.as_deref(), now_ms())
}

#[tauri::command(async)]
pub fn folder_rename(db: State<'_, DbPool>, id: String, name_ciphertext: String) -> AppResult<Folder> {
    rename_folder(&mut db.conn(), &id, &name_ciphertext, now_ms())
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
    }

    #[test]
    fn renames_a_folder() {
        let mut conn = test_conn();
        create(&mut conn, "f", None).unwrap();
        let renamed = rename_folder(&mut conn, "f", "bmV3", T + 5).unwrap();
        assert_eq!(renamed.name_ciphertext, "bmV3");
        assert_eq!(renamed.updated_at, T + 5);
    }
}
