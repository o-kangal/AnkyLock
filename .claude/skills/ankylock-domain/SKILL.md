---
name: ankylock-domain
description: AnkyLock business rules for the note/folder/category hierarchy, the note lifecycle state machine (EPHEMERAL → ORGANIZED → ARCHIVED → TRASHED → PURGED), soft-delete, trash retention and purge, restore fallback, and the canonical error codes. Use this whenever you write or review code that creates, moves, archives, trashes, restores or purges notes, folders or categories — packages/core types and reducers, IStorageEngine adapters, Rust folders.rs/notes.rs commands, sidebar drag-and-drop, the retention worker, or e2e tests for any of these — even if the task only mentions "move a folder" or "delete a note".
---

# AnkyLock Domain Rules

SPEC.md is the source of truth. This skill condenses the rules that are easy to get subtly wrong, explains why they exist, and fixes the names (constants, error codes) so every package uses the same ones. If SPEC.md and this file ever disagree, follow SPEC.md and tell the user that this skill is stale.

The same rules are enforced in up to four places: the `packages/core` reducer, the Rust IPC commands (`apps/desktop/src-tauri`), the web storage adapter and the sidebar drag-and-drop. Keep them in agreement. Put the logic once as a pure function in `packages/core`. TypeScript layers call it. Rust re-implements it and is tested against the same cases. Business rules belong in core, not in UI components.

## Canonical names

Define these once in `packages/core/src/constants.ts` and import them everywhere else:

| Constant | Value |
|---|---|
| `SYSTEM_ALL` / `SYSTEM_ARCHIVE` / `SYSTEM_TRASH` | `'system_all'`, `'system_archive'`, `'system_trash'` |
| `DEFAULT_RETENTION_DAYS` | `28` |
| `MAX_FOLDER_DEPTH` | `3` |
| `TITLE_FALLBACK_LENGTH` | `40` |
| `MAX_NOTE_PLAINTEXT_BYTES` | `10 * 1024 * 1024` |
| `SYNC_DEBOUNCE_MS` | `150` |

Error codes are string literals in a single union type, and Rust's `AppError` must serialize to the same strings:

- `ERR_CIRCULAR_HIERARCHY`: a folder would be moved into itself or a descendant
- `ERR_MAX_DEPTH_EXCEEDED`: the operation would produce a folder at depth > 3
- `ERR_SYSTEM_CATEGORY_IMMUTABLE`: rename, delete, reorder or reparent of a system category
- `ERR_READ_ONLY_TRASHED_ENTITY`: any content or metadata edit on a trashed entity
- `ERR_INVALID_TRANSITION`: a forbidden state transition
- `ERR_CATEGORY_NAME_INVALID` / `ERR_CATEGORY_NAME_DUPLICATE`: BR-HIER-02
- `ERR_NOTE_TOO_LARGE`: BR-NOTE-04
- `ERR_NOT_FOUND` / `ERR_STORAGE`: missing row / SQLite failure (Rust storage layer)

SPEC.md names only the circular, depth and trashed codes. The others are the convention used here. If the user picks different names, update this list.

## Hierarchy

**Depth is about the whole subtree, not just the moved node.** The common bug: you move folder `X` under target `T` and check only `depth(T) + 1 <= 3`. But `X` may have its own children. The correct check is:

```
depth(T) + 1 + height(X) <= MAX_FOLDER_DEPTH
```

Here `depth(root-level folder) = 1` and `height(leaf) = 0`. Creating a folder is the special case `height = 0`. Moving to the root (`parent_id = NULL`) means `depth(T) = 0`.

**Cycle detection runs before the write.** Walk up from `T` through `parent_id`. If you reach `X`, reject with `ERR_CIRCULAR_HIERARCHY`. Use a visited set while walking. Corrupted or remotely merged data can already contain a cycle, and an unguarded walk would loop forever. In Rust, do the check and the `UPDATE` in the same transaction so a concurrent move can't slip between them.

**Distributed cycles (sync).** Two offline devices can each make a move that is valid locally and together form a cycle. When remote hierarchy mutations are applied, run the visited-set check over the assembled graph. Detach the cyclic folder to the root of All Notes (`parent_id = NULL`, `category_id = NULL`). Don't reject it, because the remote mutation has already happened. This is the one place where the code repairs a cycle instead of throwing.

**System categories are views, not rows** (decided 2026-10-13). `system_all` shows every live note, `system_archive` shows `is_archived = 1`, and `system_trash` shows `deleted_at IS NOT NULL`. They have no `categories` rows: V1 can't seed them because `name_ciphertext` is required, and their labels are fixed UI constants anyway. The UI draws them from `SYSTEM_CATEGORY_IDS`. A `category_id` / `categoryId` must never be a system id. Assigning one, or renaming, deleting or reparenting one, throws `ERR_SYSTEM_CATEGORY_IMMUTABLE`. The guard lives in `isSystemCategoryId` (TS) and `reject_system_category` (Rust). Never use a `WHERE id NOT IN (...)` filter that silently skips them: the caller must learn that the operation was refused.

**Custom category names**: trim, then require 1–50 characters, unique case-insensitive. Names are stored encrypted (`name_ciphertext`), so the database cannot enforce uniqueness. Check against the decrypted in-memory list on the client before encrypting.

**Loose notes** (`folder_id = NULL`) are valid and not an error state.

## Lifecycle state machine

State is derived from columns, not stored as an enum:

| State | Condition |
|---|---|
| `EPHEMERAL` | `is_ephemeral = 1 AND deleted_at IS NULL` |
| `ORGANIZED` | `is_ephemeral = 0 AND is_archived = 0 AND deleted_at IS NULL` |
| `ARCHIVED` | `is_archived = 1 AND deleted_at IS NULL` |
| `TRASHED` | `deleted_at IS NOT NULL` |
| `PURGED` | row no longer exists; a `sync_tombstones` row does |

Allowed transitions (SPEC §3). Anything not listed throws `ERR_INVALID_TRANSITION`:

| From | Action | To | Side effects |
|---|---|---|---|
| none | `CREATE_TAB` | EPHEMERAL | UUIDv4, `is_ephemeral = 1`, persisted immediately with no dialog |
| EPHEMERAL | `ASSIGN_HIERARCHY` | ORGANIZED | `is_ephemeral = 0`, set `folder_id` and/or `category_id` |
| EPHEMERAL | `CLOSE_TAB` (empty and unmodified) | PURGED | physical delete, no trash. A tab that was edited and then cleared is *modified*, so it does not qualify. |
| ORGANIZED | `ARCHIVE` | ARCHIVED | `is_archived = 1`; for folders, cascade to all descendants (BR-LIFE-01) |
| ARCHIVED | `UNARCHIVE` | ORGANIZED | `is_archived = 0` |
| EPHEMERAL / ORGANIZED / ARCHIVED | `DELETE` | TRASHED | `deleted_at = Date.now()` (UTC ms). **Keep** `folder_id`, `parent_id` and `category_id`. |
| TRASHED | `RESTORE` | ORGANIZED or ARCHIVED | clear `deleted_at`; the `is_archived` flag decides the target state; apply the orphan fallback |
| TRASHED | `PURGE` / `EXPIRE` | PURGED | delete the row and insert a `sync_tombstones` row in the same transaction |

These are explicitly forbidden: TRASHED → `EDIT_CONTENT` (throws `ERR_READ_ONLY_TRASHED_ENTITY`), PURGED → anything, ARCHIVED → EPHEMERAL.

Write the reducer as a pure function `(state, action) => Result`. No I/O and no `Date.now()` inside it: pass the timestamp in. Then tests can control time and the Rust and TS versions can share test vectors.

**Trash is read-only everywhere, not just in the editor.** Rename, move, archive and content edits on a trashed entity are all rejected. The editor shows exactly: `Notes in Trash are read-only. Restore the note to edit.`

**Orphan restore (BR-LIFE-05).** On restore, if `folder_id` / `parent_id` points to a folder that was purged **or is itself still in Trash**, set it to `NULL`, and if `category_id` points to a purged category, set that to `NULL`. The item lands at the root of All Notes. A trashed parent is treated like a missing one because the tree renders from live roots, so a live item under a trashed folder would be invisible. (Changed in Task 10b; earlier versions kept the pointer.)

## Folder archive and trash (Task 10b)

- **Archive (BR-LIFE-01):** cascades `is_archived = 1` to every live descendant folder and note. Unarchive clears it on the whole subtree and is rejected while the parent folder is still archived.
- **Trash (BR-LIFE-02):** stamps **one** `deleted_at` on the folder and every live descendant folder and note, keeping their pointers. Restore clears `deleted_at` only on items carrying that same timestamp, so things trashed separately stay in Trash.
- **Purge:** deletes the folder, its subtree and the notes inside, with a tombstone per entity. Any live leftover under a trashed folder is first moved to the root, so SQLite's `ON DELETE CASCADE` on `folders.parent_id` can never take a live folder with it.
- Pure checks live in `packages/core/src/state/folderLifecycle.ts`; SQL subtree queries use a recursive CTE with `UNION`, which terminates on cyclic data.

## Retention and purge

All timestamps are **UTC epoch milliseconds** (`INTEGER`). The purge predicate is exactly:

```sql
deleted_at IS NOT NULL
AND :retention_days > 0
AND deleted_at + :retention_days * 86400000 < :now_ms
```

TASKS.md Task 10 shortens this to `deleted_at + retention_days < now()`. That mixes days with milliseconds and would purge almost nothing. Use the SPEC form above.

- `retention_days` is read from `app_settings.trash_retention_days`. Valid values are `0` (manual purge only, never auto-purge) or `1..=365`.
- The purge runs at boot and every 24 h. It runs off the main thread: in a worker on web, in Rust on desktop.
- Each purged entity gets a tombstone and a sync outbox entry (`entity_type = 'tombstone'`) so other devices purge it too.
- **Where it lives (Task 10):** `validateRetentionDays` and `planRetentionChange` in core; `purgeExpiredNotes`, `changeTrashRetention` and `startRetentionWorker` in `packages/sync/src/workers/retentionWorker.ts`; the setting via `IStorageEngine.get/setTrashRetentionDays` (`ERR_INVALID_SETTING` on bad values). Folders have no trash flow yet, so only notes are purged.
- **Shortening retention needs confirmation.** If the new value would immediately purge rows the old value kept, the settings change returns a "needs confirmation" result with the count. It doesn't purge until the user confirms. Model this as data (`{ kind: 'confirm_required', affected: number }`), not a UI-only check. Then the worker can't bypass it.

## Titles and size

- Display title: if there is no explicit title, use the first line trimmed and cut to 40 characters. If that's empty, show `Untitled-N`. This is derived on the client from plaintext and never stored in plaintext.
- `Untitled-N` numbering: N is the lowest positive integer not used by a currently open ephemeral tab. SPEC.md doesn't define this; it's the convention used here.
- Reject plaintext over 10 MB (measured in UTF-8 bytes, not string length) before encryption, with `ERR_NOTE_TOO_LARGE`.

## Testing these rules

Every rule above has a negative case worth a test: a depth overflow caused by subtree height, a self-move, a move into a grandchild, a pre-existing cycle in the data, a system category rename, an edit on trashed content, retention `0` never purging, the boundary millisecond of the purge predicate, restore with a purged parent vs. a trashed parent, and the retention-shortening confirmation. The Gherkin scenarios in SPEC §6 are the minimum acceptance set. Use their exact error strings.
