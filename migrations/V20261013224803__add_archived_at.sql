-- migrations/V20261013224803__add_archived_at.sql
-- Purpose: record when an item was archived, so unarchiving a folder only restores the items
-- archived together with it (items archived on their own stay archived), mirroring how
-- deleted_at groups a trash cascade. is_archived stays the source of truth for the state.
-- Never edit this file after it ships; append a new migration instead.

ALTER TABLE folders ADD COLUMN archived_at INTEGER NULL;
ALTER TABLE notes ADD COLUMN archived_at INTEGER NULL;

-- Already archived rows get their last update time; NULL for everything else.
UPDATE folders SET archived_at = updated_at WHERE is_archived = 1;
UPDATE notes SET archived_at = updated_at WHERE is_archived = 1;

UPDATE app_settings SET value = '2' WHERE key = 'schema_version';
