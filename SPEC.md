# SPEC.md - AnkyLock Functional & Technical Specification (MVP)

## 1. Scope & Boundaries

### 1.1 In-Scope (MVP)
- **Language Invariant:** All source code, comments, database identifiers, UI labels, system categories, and error messages must be strictly in **English (en-US)**.
- **Client Targets:** Desktop (Tauri v2: Linux, macOS, Windows) and Web (PWA: Chromium, Firefox, WebKit).
- **Editor Core:** CodeMirror 6 with viewport line virtualization and instant scratchpad tabs (`Untitled-N`) requiring zero manual save actions.
- **Local-First Persistence:** Embedded SQLite (`rusqlite`) on Desktop and OPFS / IndexedDB on Web with full offline read/write support.
- **Zero-Knowledge E2EE:** Client-side AES-256-GCM encryption via native Web Crypto API (`SubtleCrypto`). Server and cloud storage layers process opaque ciphertext only.
- **Real-Time Ephemeral Sync:** Yjs CRDT binary delta streaming over WebSocket via a stateless Rust Axum Blind Relay, synchronizing both organized notes and unsaved scratchpad tabs across authenticated devices.
- **Cold Vault Backup:** Periodic encrypted full-database snapshots and passphrase-protected Master Key recovery blobs uploaded to Google Drive `appDataFolder`.
- **Taxonomy & Organization:**
  - Immutable System Categories: `All Notes` (`system_all`), `Archive` (`system_archive`), `Trash` (`system_trash`).
  - User-defined Custom Categories (CRUD).
  - Hierarchical Folders (up to 3 levels deep; attached to a category or workspace root) plus loose unfiled notes.
  - Native desktop Drag-and-Drop for note and folder hierarchy reassignment.
- **Soft-Delete & Retention Lifecycle:** Trashed items remain read-only in `Trash` for a default of **28 days** (user-configurable) before automated background hard-delete purge.

### 1.2 Out-of-Scope (Phase 2+)
- Multi-language localization (i18n).
- Native mobile wrappers (iOS/Android store builds).
- Programming language auto-detection, syntax highlighting themes, and code beautifiers/formatters.
- Rich-text (WYSIWYG), media/file attachments, and PDF export.
- Multi-user shared workspaces or public note URLs.

---

## 2. Business Rules & Validations

### 2.1 Notes & Ephemeral Scratchpads
- **BR-NOTE-01 (Instant Persistence):** Opening a new tab spawns an `EPHEMERAL` note (`is_ephemeral = 1`) with a generated UUIDv4 and persists buffer changes immediately to local storage without save dialogs.
- **BR-NOTE-02 (Real-Time Delta Dispatch):** When authenticated and online, keystrokes are debounced at **150 ms**, converted into Yjs binary updates, encrypted with AES-256-GCM, and pushed to the Blind Relay. Remote peers apply deltas to open tabs or background state immediately.
- **BR-NOTE-03 (Dynamic Title Fallback):** If no explicit title is set, the UI derives the display title from the first 40 characters of line 1 (trimmed). If line 1 is empty, it displays `Untitled-N`.
- **BR-NOTE-04 (Size Limit):** Maximum plaintext payload per note is **10 MB**.

### 2.2 Hierarchy & Taxonomy
- **BR-HIER-01 (System Category Immutability):** `system_all`, `system_archive`, and `system_trash` are immutable singletons. Attempts to rename, delete, reorder, or reparent them must throw a domain validation error.
- **BR-HIER-02 (Custom Category Constraints):** Custom category names must be 1–50 characters after trimming whitespace and unique (case-insensitive) across the workspace.
- **BR-HIER-03 (Folder Depth Limit):** Folders may nest up to a maximum depth of **3 levels** (`Root Folder -> Level 2 -> Level 3`). Any operation exceeding depth 3 must be rejected.
- **BR-HIER-04 (Loose Notes):** Notes may reside directly under a category or workspace root (`folder_id = NULL`).
- **BR-HIER-05 (Acyclic Enforcement):** A folder must never be moved into itself or any of its descendants. Cycle detection must run prior to committing any `parent_id` mutation.

### 2.3 Archival & Trash Lifecycle
- **BR-LIFE-01 (Cascading Archive):** Archiving a folder sets `is_archived = 1` on the folder and recursively cascades `is_archived = 1` to all descendant subfolders and notes.
- **BR-LIFE-02 (Soft-Delete Mutation):** Deleting a note or folder transitions it to `TRASHED` by setting `deleted_at = UTC_TIMESTAMP_MS` while preserving its `parent_id` and `category_id` pointers for potential restoration.
- **BR-LIFE-03 (Configurable Retention):** Default trash retention is **28 days**. Users may configure this value between `1` and `365` days, or set it to `0` (Manual Purge Only).
- **BR-LIFE-04 (Automated Hard-Delete Purge):** On application boot and every 24 hours, the purge worker deletes all records where `deleted_at IS NOT NULL AND retention_days > 0 AND (deleted_at + retention_days * 86400000) < now()`, emitting tombstones to the sync queue.
- **BR-LIFE-05 (Orphan Restoration Fallback):** Restoring a trashed item clears `deleted_at`. If its former parent folder or category was permanently purged, `folder_id` and `category_id` reset to `NULL` and the item is placed at the root of `All Notes`.

### 2.4 Cryptographic & Zero-Knowledge Rules
- **BR-SEC-01 (Blind Wire & Storage):** Plaintext note titles, note bodies, folder names, and category names must never be transmitted over WebSocket/HTTPS or written unencrypted to `sync_outbox`.
- **BR-SEC-02 (Fresh IV Requirement):** Every AES-256-GCM encryption call must generate a fresh, cryptographically random 12-byte Initialization Vector (`iv`) via `crypto.getRandomValues`.
- **BR-SEC-03 (Key Separation):** Google OAuth tokens are used strictly for identity verification and Google Drive API authorization. The Master Encryption Key (MEK) is derived independently via PBKDF2 / Argon2id or shared via device-to-device QR handshake.

---

## 3. State Transitions & Lifecycle

``` text
 [Create Tab] ──► EPHEMERAL (Untitled-N, is_ephemeral = 1)
                       │
          ┌────────────┴────────────────────────┐
          │ (Assign Folder/Category)            │ (Delete Action)
          ▼                                     ▼
   ORGANIZED (is_ephemeral = 0) ──────────► TRASHED (deleted_at != NULL, Read-Only)
          │                                     │
          │ (Archive Action)                    ├─────────────────────────┐
          ▼                                     │ (Restore Action)        │ (Purge / Expired)
       ARCHIVED (is_archived = 1) ──────────────┘                         ▼
          │                                                            PURGED (Physical Delete)
          └── (Unarchive Action) ──► ORGANIZED
``` 

| Source State | Action Trigger | Target State | Guard Conditions & Side Effects |
| :--- | :--- | :--- | :--- |
| `None` | `CREATE_TAB` | `EPHEMERAL` | Generates UUIDv4, sets `is_ephemeral = 1`, mounts active editor. |
| `EPHEMERAL` | `ASSIGN_HIERARCHY` | `ORGANIZED` | Sets `is_ephemeral = 0`, assigns `folder_id` or `category_id`. |
| `EPHEMERAL` | `CLOSE_TAB` (Empty) | `PURGED` | If plaintext length is 0 and unmodified, deletes record without trashing. |
| `ORGANIZED` | `ARCHIVE` | `ARCHIVED` | Sets `is_archived = 1`; removes from `All Notes` view. |
| `ARCHIVED` | `UNARCHIVE` | `ORGANIZED` | Sets `is_archived = 0`; restores visibility in original hierarchy. |
| `EPHEMERAL` / `ORGANIZED` / `ARCHIVED` | `DELETE` | `TRASHED` | Sets `deleted_at = UTC_NOW()`; enforces read-only lock in editor. |
| `TRASHED` | `RESTORE` | `ORGANIZED` / `ARCHIVED` | Clears `deleted_at`; falls back to `All Notes` root if parent no longer exists. |
| `TRASHED` | `PURGE` / `EXPIRE` | `PURGED` | Deletes row from database; inserts entry into `sync_tombstones`. |

**Forbidden Transitions:**
- `TRASHED` -> `EDIT_CONTENT` (Must throw `ERR_READ_ONLY_TRASHED_ENTITY`).
- `PURGED` -> `*` (Irreversible).
- `ARCHIVED` -> `EPHEMERAL` (Disallowed).

---

## 4. Database DDL Specification (`migrations/V1__initial_schema.sql`)

Local agents must use this exact DDL when creating `migrations/V1__initial_schema.sql`:

``` sql
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
``` 

---

## 5. Cryptographic & Wire Protocol Specification

### 5.1 Encrypted Field Encoding (`*_ciphertext`)
All encrypted text fields and binary blobs must follow this deterministic binary layout (or Base64 representation for TEXT columns):
- **Bytes `0..12` (12 bytes):** Random Initialization Vector (`iv`).
- **Bytes `12..N-16`:** AES-256-GCM encrypted payload (`ciphertext`).
- **Bytes `N-16..N` (16 bytes):** GCM Authentication Tag (`tag`).

### 5.2 Blind Relay WebSocket Frame Envelope
Binary frames exchanged between clients and the Rust Axum Blind Relay must conform to:
``` json
{
  "protocol_version": 1,
  "packet_type": "CRDT_DELTA | HIERARCHY_MUTATION | TOMBSTONE",
  "entity_id": "uuid-v4",
  "sender_device_id": "uuid-v4",
  "timestamp_ms": 1776100000000,
  "encrypted_envelope": "<base64(iv + ciphertext + tag)>"
}
``` 

---

## 6. Acceptance Criteria (BDD / Gherkin)

``` gherkin
Feature: Real-Time Ephemeral Scratchpad Synchronization

  Scenario: Unsaved scratchpad tab replicates across devices in real time
    Given the user is authenticated on "Desktop Client A" and "Web Client B" with the same Master Key
    And "Desktop Client A" opens a new unsaved tab labeled "Untitled-1"
    When the user types "const secret = 42;" into "Untitled-1" on "Desktop Client A"
    Then "Desktop Client A" persists the update to local SQLite and dispatches an AES-256-GCM encrypted Yjs delta
    And "Web Client B" receives the delta via WebSocket, decrypts it, and displays "const secret = 42;" inside "Untitled-1"

  Scenario: Concurrent offline scratchpad edits merge without data loss
    Given "Desktop Client A" and "Web Client B" are both offline
    And "Desktop Client A" inserts "Line A" into "Untitled-1"
    And "Web Client B" inserts "Line B" into "Untitled-1"
    When both clients reconnect to the Blind Relay
    Then Yjs CRDT state vectors reconcile both encrypted update streams
    And both clients display "Line A" and "Line B" deterministically without creating duplicate conflicted files

Feature: Hierarchy Validation and Drag-and-Drop

  Scenario: Rejecting circular folder parenting
    Given folder "Alpha" contains child folder "Beta"
    When the user drags folder "Alpha" and drops it onto folder "Beta"
    Then the storage engine rejects the mutation with error "ERR_CIRCULAR_HIERARCHY"
    And the UI reverts "Alpha" to its previous position

  Scenario: Rejecting folder nesting deeper than 3 levels
    Given a 3-level folder path "Level1 / Level2 / Level3" exists
    When the user attempts to create or drop folder "Level4" inside "Level3"
    Then the operation is rejected with error "ERR_MAX_DEPTH_EXCEEDED"

Feature: Trash Retention and Automated Purge

  Scenario: Read-only enforcement on trashed notes
    Given note "Config_Backup" is in the "TRASHED" state
    When the user selects "Config_Backup" in the "Trash" view and attempts to type in the editor
    Then the editor blocks the input and displays "Notes in Trash are read-only. Restore the note to edit."

  Scenario: Confirmation before shortening retention window
    Given "trash_retention_days" is set to "28" and Trash contains notes deleted 10 days ago
    When the user changes "trash_retention_days" to "7"
    Then the system prompts for confirmation before purging records older than 7 days
``` 

---

## 7. Edge Cases & Mitigations

| Scenario / Risk | Trigger Condition | Required System Behavior |
| :--- | :--- | :--- |
| **Split-Brain Offline Edits** | Two devices edit the same note offline and reconnect simultaneously. | Never apply Last-Write-Wins (LWW). Merge binary updates via Yjs CRDT (`Y.applyUpdate`). |
| **Distributed Circular Folder Move** | Offline Device A moves Folder 1 into Folder 2; offline Device B moves Folder 2 into Folder 1. | On sync graph assembly, run `visited_set` cycle detection. Detach the cyclic folder and place it at the root of `All Notes`. |
| **Parent Purged Before Child Restore** | User restores a trashed note whose parent folder was already hard-deleted. | Detect missing `folder_id` foreign key target, set `folder_id = NULL`, and restore note to `All Notes` root. |
| **DOM Memory Bloat (100+ Tabs)** | User keeps 100+ scratchpad tabs open simultaneously. | Mount CodeMirror 6 `EditorView` DOM node **only** for the focused tab. Keep inactive tabs as headless `Y.Doc` buffers. |
| **Google Drive Quota / Auth Failure** | Cold snapshot upload fails with HTTP 401 or 403 (storage full). | Do not block local saves or WebSocket relay sync. Surface non-intrusive status bar warning badge. |
| **Missing Master Key on New Device** | User signs in with Google OAuth on a new device before completing QR key exchange or entering passphrase. | Enter **Locked Vault Mode**: buffer incoming encrypted deltas in SQLite, keep UI locked until MEK is provided. |