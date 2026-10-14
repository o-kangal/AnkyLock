use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::State;

use super::now_ms;
use crate::db::pool::DbPool;
use crate::error::AppResult;

/// A queued sync packet. The payload is already encrypted by the client; the host never decrypts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub id: i64,
    pub entity_id: String,
    pub entity_type: String,
    #[serde(with = "crate::b64")]
    pub encrypted_payload: Vec<u8>,
    pub created_at: i64,
}

fn map_entry(row: &Row<'_>) -> rusqlite::Result<OutboxEntry> {
    Ok(OutboxEntry {
        id: row.get(0)?,
        entity_id: row.get(1)?,
        entity_type: row.get(2)?,
        encrypted_payload: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// `entity_type` is constrained by the schema's CHECK to note / folder / category / tombstone.
pub fn enqueue_outbox(
    conn: &Connection,
    entity_id: &str,
    entity_type: &str,
    encrypted_payload: &[u8],
    now: i64,
) -> AppResult<OutboxEntry> {
    conn.execute(
        "INSERT INTO sync_outbox (entity_id, entity_type, encrypted_payload, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![entity_id, entity_type, encrypted_payload, now],
    )?;
    Ok(OutboxEntry {
        id: conn.last_insert_rowid(),
        entity_id: entity_id.to_owned(),
        entity_type: entity_type.to_owned(),
        encrypted_payload: encrypted_payload.to_vec(),
        created_at: now,
    })
}

/// Oldest entries first so the queue drains in insertion order.
pub fn list_outbox(conn: &Connection, limit: u32) -> AppResult<Vec<OutboxEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, entity_id, entity_type, encrypted_payload, created_at FROM sync_outbox ORDER BY id LIMIT ?1",
    )?;
    let entries = stmt.query_map([limit], map_entry)?.collect::<Result<_, _>>()?;
    Ok(entries)
}

/// Removes entries after they were sent successfully.
pub fn delete_outbox(conn: &mut Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM sync_outbox WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxInput {
    entity_id: String,
    entity_type: String,
    #[serde(with = "crate::b64")]
    encrypted_payload: Vec<u8>,
}

#[tauri::command(async)]
pub fn outbox_enqueue(db: State<'_, DbPool>, entry: OutboxInput) -> AppResult<OutboxEntry> {
    enqueue_outbox(
        &*db.conn()?,
        &entry.entity_id,
        &entry.entity_type,
        &entry.encrypted_payload,
        now_ms(),
    )
}

#[tauri::command(async)]
pub fn outbox_list(db: State<'_, DbPool>, limit: u32) -> AppResult<Vec<OutboxEntry>> {
    list_outbox(&*db.conn()?, limit)
}

#[tauri::command(async)]
pub fn outbox_delete(db: State<'_, DbPool>, ids: Vec<i64>) -> AppResult<()> {
    delete_outbox(&mut *db.conn()?, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_conn;

    const T: i64 = 1_776_100_000_000;

    #[test]
    fn enqueues_lists_in_order_and_deletes() {
        let mut conn = test_conn();
        let first = enqueue_outbox(&conn, "n1", "note", &[1, 2, 3], T).unwrap();
        let second = enqueue_outbox(&conn, "f1", "folder", &[4], T + 1).unwrap();
        enqueue_outbox(&conn, "n2", "tombstone", &[5], T + 2).unwrap();

        let listed = list_outbox(&conn, 2).unwrap();
        assert_eq!(listed, vec![first.clone(), second]);

        delete_outbox(&mut conn, &[first.id]).unwrap();
        let remaining: Vec<String> = list_outbox(&conn, 10).unwrap().into_iter().map(|e| e.entity_id).collect();
        assert_eq!(remaining, ["f1", "n2"]);
    }

    #[test]
    fn rejects_unknown_entity_types() {
        let conn = test_conn();
        assert_eq!(enqueue_outbox(&conn, "x", "user", &[1], T).unwrap_err().code(), "ERR_STORAGE");
    }

    #[test]
    fn payload_crosses_ipc_as_base64() {
        let conn = test_conn();
        let entry = enqueue_outbox(&conn, "n1", "note", &[0xde, 0xad, 0xbe, 0xef], T).unwrap();
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["encryptedPayload"], "3q2+7w==");
        assert_eq!(json["entityType"], "note");

        let input: OutboxInput =
            serde_json::from_str(r#"{"entityId":"n1","entityType":"note","encryptedPayload":"3q2+7w=="}"#).unwrap();
        assert_eq!(input.encrypted_payload, [0xde, 0xad, 0xbe, 0xef]);
        assert!(serde_json::from_str::<OutboxInput>(
            r#"{"entityId":"n1","entityType":"note","encryptedPayload":"%%%"}"#
        )
        .is_err());
    }
}
