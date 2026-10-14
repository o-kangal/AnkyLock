-- migrations/V20261014200733__add_sync_clocks.sql
-- Created: 2026-10-14T20:07:33Z
-- Purpose: what multi-device sync needs from the schema (Task 11e).
--   1. sync_outbox.packet_type: hierarchy changes are queued as HIERARCHY_MUTATION packets,
--      which entity_type alone cannot tell apart from content deltas.
--   2. notes.meta_updated_at: when a note's place or lifecycle (folder, category, ephemeral,
--      archived, trashed) last changed. updated_at also moves on every text edit, so it cannot
--      decide which device's metadata is newer; text itself always merges through Yjs.
-- Never edit this file after it ships; append a new migration instead.

ALTER TABLE sync_outbox ADD COLUMN packet_type TEXT NOT NULL DEFAULT 'CRDT_DELTA'
    CHECK (packet_type IN ('CRDT_DELTA', 'HIERARCHY_MUTATION', 'TOMBSTONE'));
UPDATE sync_outbox SET packet_type = 'TOMBSTONE' WHERE entity_type = 'tombstone';

ALTER TABLE notes ADD COLUMN meta_updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE notes SET meta_updated_at = updated_at;

-- The clock follows metadata changes on its own, so no write path can forget it. A write that
-- sets meta_updated_at itself (merging another device's record) is left alone.
CREATE TRIGGER notes_meta_clock_insert AFTER INSERT ON notes
WHEN NEW.meta_updated_at = 0
BEGIN
    UPDATE notes SET meta_updated_at = NEW.updated_at WHERE id = NEW.id;
END;

CREATE TRIGGER notes_meta_clock_update AFTER UPDATE ON notes
WHEN NEW.meta_updated_at = OLD.meta_updated_at
    AND (NEW.folder_id IS NOT OLD.folder_id
        OR NEW.category_id IS NOT OLD.category_id
        OR NEW.is_ephemeral IS NOT OLD.is_ephemeral
        OR NEW.is_archived IS NOT OLD.is_archived
        OR NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN
    UPDATE notes SET meta_updated_at = NEW.updated_at WHERE id = NEW.id;
END;

UPDATE app_settings SET value = '3' WHERE key = 'schema_version';
