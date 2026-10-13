PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE categories (
    id TEXT PRIMARY KEY NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE folders (
    id TEXT PRIMARY KEY NOT NULL,
    category_id TEXT NULL,
    parent_id TEXT NULL,
    name_ciphertext TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    folder_id TEXT NULL,
    category_id TEXT NULL,
    is_ephemeral INTEGER NOT NULL DEFAULT 1,
    is_archived INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE note_contents (
    note_id TEXT PRIMARY KEY NOT NULL,
    title_ciphertext TEXT NOT NULL,
    content_ciphertext BLOB NOT NULL,
    yjs_state_vector BLOB NOT NULL,
    yjs_updates BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'folder', 'category', 'tombstone')),
    encrypted_payload BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE sync_tombstones (
    entity_id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'folder', 'category')),
    purged_at INTEGER NOT NULL
);

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

INSERT INTO app_settings (key, value) VALUES
    ('trash_retention_days', '28'),
    ('schema_version', '1');

CREATE INDEX idx_notes_folder ON notes(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_category ON notes(category_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_trash ON notes(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_folders_trash ON folders(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_folders_parent ON folders(parent_id);
