use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::State;

use super::{now_ms, reject_system_category};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};

/// A user-defined category. System categories are views and have no rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub is_system: bool,
    pub sort_order: i64,
    pub name_ciphertext: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const CATEGORY_COLUMNS: &str = "id, is_system, sort_order, name_ciphertext, created_at, updated_at";

fn map_category(row: &Row<'_>) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get(0)?,
        is_system: row.get(1)?,
        sort_order: row.get(2)?,
        name_ciphertext: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub(crate) fn require_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let sql = format!("SELECT {CATEGORY_COLUMNS} FROM categories WHERE id = ?1");
    conn.query_row(&sql, [id], map_category)
        .optional()?
        .ok_or(AppError::NotFound("Category"))
}

pub fn list_categories(conn: &Connection) -> AppResult<Vec<Category>> {
    let sql = format!("SELECT {CATEGORY_COLUMNS} FROM categories ORDER BY sort_order, created_at");
    let mut stmt = conn.prepare(&sql)?;
    let categories = stmt.query_map([], map_category)?.collect::<Result<_, _>>()?;
    Ok(categories)
}

/// Appends a category at the end of the sort order. Name rules (BR-HIER-02) are checked by
/// the client before encryption; the host only sees ciphertext.
pub fn create_category(conn: &mut Connection, id: &str, name_ciphertext: &str, now: i64) -> AppResult<Category> {
    reject_system_category(Some(id))?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO categories (id, sort_order, name_ciphertext, created_at, updated_at)
         VALUES (?1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories), ?2, ?3, ?3)",
        params![id, name_ciphertext, now],
    )?;
    let category = require_category(&tx, id)?;
    tx.commit()?;
    Ok(category)
}

pub fn rename_category(conn: &mut Connection, id: &str, name_ciphertext: &str, now: i64) -> AppResult<Category> {
    reject_system_category(Some(id))?;
    let tx = conn.transaction()?;
    require_category(&tx, id)?;
    tx.execute(
        "UPDATE categories SET name_ciphertext = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name_ciphertext, now],
    )?;
    let category = require_category(&tx, id)?;
    tx.commit()?;
    Ok(category)
}

/// Deletes a category; its notes and folders fall back to no category (`ON DELETE SET NULL`).
pub fn delete_category(conn: &mut Connection, id: &str, now: i64) -> AppResult<()> {
    reject_system_category(Some(id))?;
    let tx = conn.transaction()?;
    require_category(&tx, id)?;
    tx.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    tx.execute(
        "INSERT OR REPLACE INTO sync_tombstones (entity_id, entity_type, purged_at) VALUES (?1, 'category', ?2)",
        params![id, now],
    )?;
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn category_list(db: State<'_, DbPool>) -> AppResult<Vec<Category>> {
    list_categories(&db.conn())
}

#[tauri::command(async)]
pub fn category_create(db: State<'_, DbPool>, id: String, name_ciphertext: String) -> AppResult<Category> {
    create_category(&mut db.conn(), &id, &name_ciphertext, now_ms())
}

#[tauri::command(async)]
pub fn category_rename(db: State<'_, DbPool>, id: String, name_ciphertext: String) -> AppResult<Category> {
    rename_category(&mut db.conn(), &id, &name_ciphertext, now_ms())
}

#[tauri::command(async)]
pub fn category_delete(db: State<'_, DbPool>, id: String) -> AppResult<()> {
    delete_category(&mut db.conn(), &id, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::folders::{create_folder, find_folder};
    use crate::db::test_conn;

    const T: i64 = 1_776_100_000_000;

    fn code<T: std::fmt::Debug>(result: AppResult<T>) -> &'static str {
        result.unwrap_err().code()
    }

    #[test]
    fn creates_categories_in_sort_order() {
        let mut conn = test_conn(); // seeds `cat` at sort_order 0
        let work = create_category(&mut conn, "work", "d29yaw==", T).unwrap();
        assert_eq!(work.sort_order, 1);
        assert!(!work.is_system);
        let ids: Vec<String> = list_categories(&conn).unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["cat", "work"]);
    }

    #[test]
    fn renames_a_category() {
        let mut conn = test_conn();
        let renamed = rename_category(&mut conn, "cat", "bmV3", T + 1).unwrap();
        assert_eq!((renamed.name_ciphertext.as_str(), renamed.updated_at), ("bmV3", T + 1));
        assert_eq!(code(rename_category(&mut conn, "ghost", "eA==", T)), "ERR_NOT_FOUND");
    }

    #[test]
    fn delete_detaches_folders_and_records_a_tombstone() {
        let mut conn = test_conn();
        create_folder(&mut conn, "f", None, Some("cat"), "Zg==", T).unwrap();
        delete_category(&mut conn, "cat", T).unwrap();
        assert!(list_categories(&conn).unwrap().is_empty());
        assert_eq!(find_folder(&conn, "f").unwrap().unwrap().category_id, None);
        let tombstones: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_tombstones WHERE entity_type = 'category'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombstones, 1);
    }

    #[test]
    fn system_categories_are_immutable() {
        let mut conn = test_conn();
        for id in ["system_all", "system_archive", "system_trash"] {
            assert_eq!(code(create_category(&mut conn, id, "eA==", T)), "ERR_SYSTEM_CATEGORY_IMMUTABLE");
            assert_eq!(code(rename_category(&mut conn, id, "eA==", T)), "ERR_SYSTEM_CATEGORY_IMMUTABLE");
            assert_eq!(code(delete_category(&mut conn, id, T)), "ERR_SYSTEM_CATEGORY_IMMUTABLE");
        }
    }
}
