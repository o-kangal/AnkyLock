# TASKS.md - AnkyLock MVP Implementation Plan

## Plan Architecture & Prerequisites
- Execution Strategy: Monorepo setup -> Core types & Crypto -> Storage adapters & SQLite migrations -> Sync relay & CRDT pipeline -> CodeMirror 6 UI & Tree -> Tauri integration & E2E verification.
- Prerequisites: Node.js 20+, pnpm 9+, Rust 1.80+ with `wasm32-unknown-unknown` target, and native WebKit dependencies installed.

---

## Ordered Task Breakdown

### Task 1: Monorepo Workspace & Configuration Setup
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Setup
- **Read-Only Context Files:** `AGENTS.md`
- **Target Files (Create/Modify):**
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - `Cargo.toml`
  - `.gitignore`
- **Step-by-Step Instructions:**
  1. Configure `pnpm-workspace.yaml` declaring packages: `apps/*` and `packages/*`.
  2. Setup root `package.json` with scripts for `typecheck`, `lint`, `test`, and `build` using pnpm recursive filters (`-r`).
  3. Initialize base TypeScript configuration with strict mode (`strict: true`, `noImplicitAny: true`, `exactOptionalPropertyTypes: true`).
  4. Setup root `Cargo.toml` workspace declaring `apps/desktop/src-tauri` and `apps/relay`.
- **Verification:**
``` bash
pnpm install && pnpm install --frozen-lockfile && cargo check --workspace
``` 

---

### Task 2: Core Domain Types, Enums & State Machine Contracts
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Schema/Types
- **Read-Only Context Files:** `AGENTS.md`
- **Target Files (Create/Modify):**
  - `packages/core/package.json`
  - `packages/core/src/constants.ts`
  - `packages/core/src/types/entities.ts`
  - `packages/core/src/types/crypto.ts`
  - `packages/core/src/state/noteLifecycle.ts`
  - `packages/core/src/index.ts`
- **Step-by-Step Instructions:**
  1. Define singleton constants in `constants.ts`: `SYSTEM_ALL = 'system_all'`, `SYSTEM_ARCHIVE = 'system_archive'`, `SYSTEM_TRASH = 'system_trash'`, `DEFAULT_RETENTION_DAYS = 28`, `MAX_FOLDER_DEPTH = 3`.
  2. Define strictly-typed entity interfaces in `entities.ts`: `Category`, `Folder`, `Note`, `NoteContent`, and `SyncOutboxEntry`. Prevent `any`.
  3. Define `EncryptedPayload` interface in `crypto.ts`: `{ iv: string; ciphertext: string; tag: string }`.
  4. Implement `noteLifecycle.ts` pure transition reducer enforcing rules: `EPHEMERAL` -> `ORGANIZED` -> `ARCHIVED` -> `TRASHED` -> `PURGED`. Block invalid transitions (e.g., editing `TRASHED` note).
- **Verification:**
``` bash
pnpm --filter @ankylock/core run build && pnpm --filter @ankylock/core run test
``` 

---

### Task 3: Zero-Knowledge Client Cryptography Engine
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/core/src/types/crypto.ts`
- **Target Files (Create/Modify):**
  - `packages/crypto/package.json`
  - `packages/crypto/src/kdf.ts`
  - `packages/crypto/src/cipher.ts`
  - `packages/crypto/src/vaultKey.ts`
  - `packages/crypto/src/index.ts`
  - `packages/crypto/tests/crypto.test.ts`
- **Step-by-Step Instructions:**
  1. Implement PBKDF2 key derivation in `kdf.ts` (SHA-256, 100,000 iterations) generating 256-bit AES-GCM CryptoKey.
  2. Implement `encryptPayload` and `decryptPayload` in `cipher.ts` using native Web Crypto API (`crypto.subtle.encrypt` / `decrypt`) returning hex/base64-encoded IV, ciphertext, and tag.
  3. Implement `vaultKey.ts` managing Master Encryption Key (MEK) state in memory without exposing raw key bytes to global scope.
  4. Write unit tests in `crypto.test.ts` verifying round-trip encryption/decryption and integrity checks.
- **Verification:**
``` bash
pnpm --filter @ankylock/crypto run test
``` 

---

### Task 4: Database DDL & Rust SQLite Storage Manager
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Schema/Types & Backend/Service
- **Read-Only Context Files:** `AGENTS.md`, `packages/core/src/types/entities.ts`
- **Target Files (Create/Modify):**
  - `migrations/V1__initial_schema.sql`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/src/db/migrations.rs`
  - `apps/desktop/src-tauri/src/db/pool.rs`
  - `apps/desktop/src-tauri/src/commands/notes.rs`
  - `apps/desktop/src-tauri/src/commands/folders.rs`
  - `apps/desktop/src-tauri/src/main.rs`
- **Step-by-Step Instructions:**
  1. Author `migrations/V1__initial_schema.sql` implementing tables: `categories`, `folders`, `notes`, `note_contents`, `sync_outbox`, `sync_tombstones`, `app_settings` with specified partial indexes.
  2. Configure `rusqlite` with bundled SQLite in `apps/desktop/src-tauri/Cargo.toml` and embed migrations using `include_str!`.
  3. Implement Tauri IPC commands in `commands/notes.rs` and `commands/folders.rs` for atomic queries and updates.
  4. Implement cycle detection validation in `folders.rs` ensuring folder parenting depth never exceeds 3 levels and never references a descendant.
- **Verification:**
``` bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
``` 

---

### Task 5: Storage Adapter Abstraction & Web OPFS / IndexedDB Driver
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/core/src/types/entities.ts`
- **Target Files (Create/Modify):**
  - `packages/storage/package.json`
  - `packages/storage/src/interfaces/IStorageEngine.ts`
  - `packages/storage/src/adapters/tauriSqliteAdapter.ts`
  - `packages/storage/src/adapters/webOpfsAdapter.ts`
  - `packages/storage/src/index.ts`
  - `packages/storage/tests/storage.test.ts`
- **Step-by-Step Instructions:**
  1. Define `IStorageEngine` interface with CRUD methods for notes, folders, categories, and sync queues.
  2. Implement `tauriSqliteAdapter.ts` routing calls through Tauri IPC invoke (`@tauri-apps/api/core`).
  3. Implement `webOpfsAdapter.ts` persisting SQLite WASM or Origin Private File System / IndexedDB fallback for the browser.
  4. Ensure both adapters expose identical async signatures so UI and sync engines remain platform-agnostic.
- **Verification:**
``` bash
pnpm --filter @ankylock/storage run test
``` 

---

### Task 6: Yjs CRDT Protocol & Outbox Synchronization Pipeline
- **Status:** ✅ Completed (2026-10-13)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/core/src/types/entities.ts`, `packages/crypto/src/cipher.ts`
- **Target Files (Create/Modify):**
  - `packages/sync/package.json`
  - `packages/sync/src/crdt/docManager.ts`
  - `packages/sync/src/crdt/deltaPacker.ts`
  - `packages/sync/src/queue/outboxQueue.ts`
  - `packages/sync/src/client/blindWebSocketClient.ts`
  - `packages/sync/src/index.ts`
  - `packages/sync/tests/crdt.test.ts`
- **Step-by-Step Instructions:**
  1. Implement `docManager.ts` creating and maintaining `Y.Doc` instances for active tabs.
  2. Implement `deltaPacker.ts`: listen to `doc.on('update')`, debounce at 150 ms, encrypt delta bytes with AES-256-GCM, and produce opaque sync packets.
  3. Implement `outboxQueue.ts`: write unsent encrypted packets to `sync_outbox` table when offline; drain queue sequentially on reconnection.
  4. Implement `blindWebSocketClient.ts`: maintain persistent TLS WebSocket connection with auto-reconnect and heartbeat ping/pong.
- **Verification:**
``` bash
pnpm --filter @ankylock/sync run test
``` 

---

### Task 7: Stateless Rust Axum Blind Relay WebSocket Server
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Backend/Service
- **Read-Only Context Files:** `AGENTS.md`
- **Target Files (Create/Modify):**
  - `apps/relay/Cargo.toml`
  - `apps/relay/src/config.rs`
  - `apps/relay/src/auth.rs`
  - `apps/relay/src/hub.rs`
  - `apps/relay/src/ws.rs`
  - `apps/relay/src/main.rs`
  - `apps/relay/tests/relay_test.rs`
- **Step-by-Step Instructions:**
  1. Setup Axum, Tokio, and `tokio-tungstenite` in `apps/relay/Cargo.toml`.
  2. Implement `auth.rs`: validate Google OAuth JWT or workspace session token; extract `account_id` without reading payload contents.
  3. Implement `hub.rs`: manage in-memory broadcast channels (Tokio `broadcast::channel` or Redis Pub/Sub adapter) keyed by `account_id`.
  4. Implement `ws.rs`: forward incoming binary WebSocket frames directly to other clients belonging to the same `account_id` without deserialization.
- **Verification:**
``` bash
cargo test --manifest-path apps/relay/Cargo.toml
``` 

---

### Task 8: CodeMirror 6 Virtualized Scratchpad Editor Component
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/core/src/types/entities.ts`, `packages/sync/src/crdt/docManager.ts`
- **Target Files (Create/Modify):**
  - `packages/editor/package.json`
  - `packages/editor/src/extensions/theme.ts`
  - `packages/editor/src/extensions/yjsBinding.ts`
  - `packages/editor/src/components/CodeMirrorView.tsx`
  - `packages/editor/src/index.ts`
- **Step-by-Step Instructions:**
  1. Build CodeMirror 6 extension suite in `theme.ts` (minimalist Notepad++ light/dark palette, virtual line padding, font configurations).
  2. Wire `y-codemirror.next` binding in `yjsBinding.ts` linking editor text model directly to active tab's `Y.Text`.
  3. Implement `CodeMirrorView.tsx` in Solid.js: ensure editor DOM instance mounts only when active; unmount when tab changes while preserving Yjs state in memory.
  4. Capture input events to derive title from the first 40 characters of line 1 without blocking the UI thread.
- **Verification:**
``` bash
pnpm --filter @ankylock/editor run typecheck
``` 

---

### Task 9: Tree Navigation, Drag-and-Drop & Tab Manager
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/core/src/constants.ts`, `packages/core/src/state/noteLifecycle.ts`
- **Target Files (Create/Modify):**
  - `apps/web/src/components/sidebar/Sidebar.tsx`
  - `apps/web/src/components/sidebar/CategoryList.tsx`
  - `apps/web/src/components/sidebar/FolderTree.tsx`
  - `apps/web/src/components/sidebar/NoteItem.tsx`
  - `apps/web/src/components/tabs/TabBar.tsx`
  - `apps/web/src/stores/workspaceStore.ts`
  - `apps/web/src/dnd/dragDropManager.ts`
- **Step-by-Step Instructions:**
  1. Implement `workspaceStore.ts` using Solid.js signals/stores to manage categories, folders, open tabs, and active tab index.
  2. Implement `TabBar.tsx`: support instant tab creation (`Untitled-N`), tab close, and drag reordering.
  3. Implement `CategoryList.tsx` rendering immutable system categories (`All Notes`, `Archive`, `Trash`) and custom categories.
  4. Implement `FolderTree.tsx` with native drag-and-drop (`dragDropManager.ts`): validate max depth (3 levels) and prevent dropping a folder into itself or its descendants.
- **Verification:**
``` bash
pnpm --filter @ankylock/web run typecheck && pnpm --filter @ankylock/web run test
``` 

---

### Task 10: Retention Purge Worker & Google Drive Snapshot Client
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/core/src/constants.ts`, `packages/storage/src/interfaces/IStorageEngine.ts`
- **Target Files (Create/Modify):**
  - `packages/sync/src/workers/retentionWorker.ts`
  - `packages/sync/src/backup/googleDriveClient.ts`
  - `packages/sync/src/backup/snapshotScheduler.ts`
  - `packages/sync/tests/retention.test.ts`
- **Step-by-Step Instructions:**
  1. Implement `retentionWorker.ts`: query `notes` and `folders` where `deleted_at IS NOT NULL AND retention_days > 0 AND deleted_at + retention_days * 86400000 < now_ms` (SPEC BR-LIFE-04, all timestamps UTC ms); execute atomic hard-delete and register tombstones.
  2. Add safety check: if user reduces retention days, trigger explicit confirmation flag before purging records.
  3. Implement `googleDriveClient.ts` uploading client-encrypted database snapshots to `drive.appdata` hidden space via Google REST API.
  4. Implement `snapshotScheduler.ts` executing snapshot export every 24 hours or on idle network state.
- **Verification:**
``` bash
pnpm --filter @ankylock/sync run test
``` 

---

### Task 10b: Folder Trash & Archive Lifecycle (Soft-Delete, Restore, Purge & Cascading Archive)
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Backend/Service & Frontend/UI
- **Read-Only Context Files:** `SPEC.md` (§2.3, §3), `packages/core/src/state/noteLifecycle.ts`, `packages/storage/src/interfaces/IStorageEngine.ts`, `packages/sync/src/workers/retentionWorker.ts`
- **Target Files (Create/Modify):**
  - `packages/core/src/state/folderLifecycle.ts`
  - `packages/storage/src/interfaces/IStorageEngine.ts`
  - `packages/storage/src/adapters/tauriSqliteAdapter.ts`
  - `packages/storage/src/adapters/webIndexedDbAdapter.ts`
  - `packages/storage/tests/contract.ts`
  - `apps/desktop/src-tauri/src/commands/folders.rs`
  - `apps/desktop/src-tauri/src/main.rs`
  - `packages/sync/src/workers/retentionWorker.ts`
  - `packages/sync/tests/retention.test.ts`
  - `apps/web/src/stores/workspaceStore.ts`
  - `apps/web/src/components/sidebar/treeRows.ts`
- **Step-by-Step Instructions:**
  1. Define folder trash and archive rules as pure functions in `folderLifecycle.ts`. Archiving a folder sets `is_archived = 1` on the folder and recursively on every live descendant subfolder and note (BR-LIFE-01); unarchiving clears it on the folder and its descendants, which then reappear in their original hierarchy. Trash rules: trashing a folder sets `deleted_at` on the folder and cascades the same timestamp to every live descendant subfolder and note, preserving `parent_id` / `category_id` (BR-LIFE-02). Restoring a folder clears `deleted_at` on the folder and only on descendants that carry the same timestamp, so items trashed separately stay in Trash. Restore falls back to the All Notes root when the former parent folder or category was purged (BR-LIFE-05).
  2. Add `archiveFolder`, `unarchiveFolder`, `trashFolder`, `restoreFolder`, `purgeFolder` and `listTrashedFolders` to `IStorageEngine`; implement them atomically in both adapters and as Rust IPC commands (validation + cascade in one transaction). Purging a folder hard-deletes it with its trashed descendants and their contents and records a tombstone for every purged entity. Trashed folders stay read-only (`ERR_READ_ONLY_TRASHED_ENTITY`).
  3. Extend the retention worker to purge expired trashed folders with the same BR-LIFE-04 predicate and emit TOMBSTONE packets for them; include them in the retention-change confirmation count.
  4. Show archived folders in the Archive view and trashed folders in the Trash view, and add archive/unarchive/trash/restore actions to the workspace store; the contract test suite must cover archive cascade, trash cascade, partial restore, orphan fallback and purge for both adapters.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
``` 

---

### Task 11: Tauri v2 Desktop App Integration & IPC Wiring
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Frontend/UI & Backend/Service
- **Read-Only Context Files:** `apps/desktop/src-tauri/src/main.rs`, `apps/web/src/stores/workspaceStore.ts`
- **Target Files (Create/Modify):**
  - `apps/desktop/src/index.tsx`
  - `apps/desktop/src/App.tsx`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `apps/desktop/src-tauri/capabilities/default.json`
  - `apps/web/src/components/sidebar/ContextMenu.tsx`
- **Step-by-Step Instructions:**
  1. Configure `tauri.conf.json` defining window properties (frameless/custom titlebar, initial size: 1200x800, minimal webview overhead).
  2. Declare IPC command permissions in `capabilities/default.json` for storage and keychain commands.
  3. Wire `tauriSqliteAdapter` into root Solid.js provider in `apps/desktop/src/App.tsx`.
  4. Verify native drag-and-drop and global shortcuts (Cmd/Ctrl+N, Cmd/Ctrl+W, Cmd/Ctrl+Tab).
  5. Add a sidebar context menu (`ContextMenu.tsx`, shared with the web app) exposing the workspace store actions: archive/unarchive, trash/restore and purge for folders and notes, rename and new subfolder for folders. Show only the actions valid for the item's state (e.g. restore/purge in Trash) and surface rejected actions' error messages.
- **Verification:**
``` bash
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml && pnpm --filter @ankylock/desktop run build
``` 

---

### Task 11b: Web SPA Entry, ServiceWorker & PWA Manifest
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `apps/web/src/index.ts`, `apps/desktop/src/App.tsx`
- **Target Files (Create/Modify):**
  - `apps/web/index.html`
  - `apps/web/vite.config.ts`
  - `apps/web/src/main.tsx`
  - `apps/web/src/App.tsx`
  - `apps/web/src/serviceWorker.ts`
  - `apps/web/public/manifest.webmanifest`
  - `apps/web/package.json`
- **Step-by-Step Instructions:**
  1. Add a Vite + `vite-plugin-solid` setup with `dev` and `build` scripts so `pnpm --filter @ankylock/web dev` works.
  2. Implement `App.tsx` composing `Sidebar`, `TabBar` and `CodeMirrorView` around `WebIndexedDbAdapter`, the crypto worker (`createWorkerSealer`) and the sync `DocManager`, mirroring the desktop wiring from Task 11.
  3. Register a ServiceWorker that caches the app shell for offline use; it must never cache or inspect API or relay traffic.
  4. Provide a PWA manifest (name, icons, `display: standalone`) so the app is installable.
- **Verification:**
``` bash
pnpm --filter @ankylock/web run typecheck && pnpm --filter @ankylock/web run test && pnpm --filter @ankylock/web run build
``` 

---

### Task 11c: Desktop Google Sign-In (OAuth 2.0 + PKCE) & Sync/Backup Activation
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Backend/Service & Frontend/UI
- **Read-Only Context Files:** `SPEC.md` (§1.1, §2.4, §7), `packages/sync/src/client/blindWebSocketClient.ts`, `packages/sync/src/backup/snapshotScheduler.ts`, `apps/web/src/runtime/createRuntime.ts`
- **Target Files (Create/Modify):**
  - `packages/sync/src/auth/googleAuth.ts`
  - `apps/desktop/src-tauri/src/commands/oauth.rs`
  - `apps/desktop/src-tauri/src/main.rs`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/web/src/components/SignInButton.tsx`
  - `packages/sync/tests/googleAuth.test.ts`
- **Step-by-Step Instructions:**
  1. Implement the OAuth 2.0 authorization-code flow with PKCE for desktop: open the system browser and receive the code on a loopback redirect handled by a Rust IPC command (web sign-in is Task 11d). Request only `openid`, `email` and `https://www.googleapis.com/auth/drive.appdata`.
  2. Keep tokens in memory (refresh token in the OS keychain on desktop) and refresh before expiry; never derive or store key material from OAuth credentials (BR-SEC-03).
  3. After sign-in, start the `BlindWebSocketClient` (fresh ID token on every connect), the `OutboxQueue` drain on reconnect, the delta packer for open docs and the snapshot scheduler; sign-out stops them while local editing keeps working.
  4. Surface auth, quota and network status as a non-intrusive status bar badge (SPEC §7).
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
``` 

---

### Task 11d: Web Google Sign-In (Google Identity Services)
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `apps/web/src/runtime/createRuntime.ts`, `packages/sync/src/auth/googleAuth.ts`, `apps/relay/src/auth.rs`
- **Target Files (Create/Modify):**
  - `apps/web/src/auth/webGoogleAuth.ts`
  - `apps/web/src/App.tsx`
  - `apps/web/vite.config.ts`
  - `apps/web/tests/webGoogleAuth.test.ts`
- **Step-by-Step Instructions:**
  1. Use a separate Google OAuth client of type "Web application" (Desktop clients only allow loopback redirects). Obtain the ID token with Sign In With Google and a `drive.appdata` access token with the GIS token client; no refresh token is kept in the browser.
  2. Implement the same `AuthProvider` interface as the desktop flow so the shared runtime starts sync and backup unchanged.
  3. Add the web client id to the relay's accepted audiences and widen the production CSP `connect-src` for Google and the relay.
- **Verification:**
``` bash
pnpm --filter @ankylock/web run typecheck && pnpm --filter @ankylock/web run test && pnpm --filter @ankylock/web run build
``` 

---

### Task 11e: Offline Catch-Up & Hierarchy Sync
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Backend/Service
- **Read-Only Context Files:** `SPEC.md` (§5.2, §7), `packages/sync/src/queue/outboxQueue.ts`, `packages/sync/src/backup/snapshot.ts`
- **Target Files (Create/Modify):**
  - `migrations/V<timestamp>__add_outbox_packet_type.sql`
  - `packages/sync/src/queue/outboxQueue.ts`
  - `packages/sync/src/hierarchy/hierarchySync.ts`
  - `packages/sync/src/catchup/catchUp.ts`
  - `packages/sync/tests/catchUp.test.ts`
- **Step-by-Step Instructions:**
  1. The relay keeps no history, so a device that was closed misses updates sent meanwhile. On sign-in and reconnect, catch up by merging the latest Drive snapshot's Yjs states into local notes (CRDT merge, never LWW) and creating notes that only exist remotely.
  2. Add `packet_type` to `sync_outbox` (new migration plus IndexedDB upgrade) so HIERARCHY_MUTATION packets can be queued, and sync folder/category create, rename, move, archive and trash as encrypted HIERARCHY_MUTATION packets, re-validated on apply (cyclic results are detached to the root, SPEC §7).
  3. Cover two devices editing offline at different times, hierarchy moves on both sides and the distributed circular move case in tests.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && cargo test --workspace
``` 

---

### Task 11f: UI Polish (Status Bar, Backup Progress, Title Bar Logo, Web Shortcuts, Sync Now, Folder Categories)
- **Status:** ✅ Completed (2026-10-15)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `apps/web/src/components/SyncStatusBar.tsx`, `apps/desktop/src/TitleBar.tsx`, `packages/sync/src/backup/snapshotScheduler.ts`
- **Target Files (Create/Modify):**
  - `apps/web/src/components/SyncStatusBar.tsx`
  - `packages/sync/src/backup/snapshotScheduler.ts`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/desktop/src/TitleBar.tsx`
  - `apps/web/tests/sync.test.tsx`
- **Step-by-Step Instructions:**
  1. ✅ Done early (2026-10-14). Make the status bar taller (about 28 px with comfortable padding) so its buttons sit clear of the frameless window's bottom resize edge; clicking "Sign in with Google" must never start a window resize.
  2. Report backups in progress: add a `running` state to `BackupStatus` (emitted when a snapshot export/upload starts) and show a small spinner with "Backing up…" in the status bar until it finishes.
  3. Show the app logo (from `src-tauri/icons/app-icon.svg`, about 16 px) before the "AnkyLock" title in the desktop title bar, keeping it part of the drag region.
  4. Browsers reserve Ctrl+N/T/W for their own tabs and never pass them to the page. On the web, bind new-note and the other reserved shortcuts to alternatives (e.g. Alt+N), keep Ctrl+N on desktop, and show the platform's shortcut in hints such as "Press Ctrl+N".
  5. Add a "Sync now" icon left of the backup status: it runs the Drive catch-up and a backup immediately and spins while they run (shared with the "Backing up…" indicator of step 2).
  6. Allow dragging a folder onto a category: a new storage operation (Rust command and IndexedDB) moves the folder to that category with its whole subtree (subfolders and the notes filed in them), a subfolder dropped on a category moves to the root of it, and the change is published to other devices like other cascading folder operations. Replace the "Folders cannot be moved between categories yet" rule in `canDrop`.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm --filter @ankylock/desktop run build
``` 

---

### Task 11g: Vault Identity & Multiple Local Vaults
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Full-Stack
- **Read-Only Context Files:** `SPEC.md` (§2.4), `packages/crypto/src/vaultKey.ts`, `packages/storage/src/interfaces/IStorageEngine.ts`, `apps/relay/src/hub.rs`
- **Target Files (Create/Modify):**
  - `packages/crypto/src/vaultKey.ts`
  - `packages/storage/src/interfaces/IStorageEngine.ts`
  - `packages/storage/src/adapters/webIndexedDbAdapter.ts`
  - `packages/storage/src/adapters/tauriSqliteAdapter.ts`
  - `apps/desktop/src-tauri/src/commands/settings.rs`
  - `apps/desktop/src-tauri/src/main.rs`
  - `apps/web/src/components/UnlockScreen.tsx`
  - `apps/web/src/runtime/createRuntime.ts`
  - `packages/sync/src/client/blindWebSocketClient.ts`
  - `apps/relay/src/hub.rs`
  - `apps/relay/src/ws.rs`
- **Step-by-Step Instructions:**
  1. Give every vault a random `vaultId` (UUID) stored in its header, and an encrypted vault name chosen at creation. Vaults are fully isolated: own salt, own key, own data.
  2. Keep one database per vault on each device (desktop `ankylock-<vaultId>.db`, web one IndexedDB database per vault) plus a small plaintext registry of the vaults on this device (id and creation time only). Adopt an existing single-vault database as the first entry of the registry.
  3. Replace the first-run screen with a vault picker: the vaults on this device, "Create new vault" and "Use my existing vault" (the latter is implemented in Task 11h). Allow locking the current vault and switching to another one.
  4. Scope the relay fan-out to `(account, vaultId)` (connect to `/ws/<vaultId>`), so devices on different vaults of the same Google account never receive each other's packets.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && cargo clippy --workspace --all-targets && cargo test --workspace
``` 

---

### Task 11h: Open an Existing Vault from Google Drive
- **Status:** ✅ Completed (2026-10-14)
- **Type:** Full-Stack
- **Read-Only Context Files:** `SPEC.md` (§2.4, §7), `packages/sync/src/backup/snapshot.ts`, `packages/sync/src/backup/snapshotScheduler.ts`
- **Target Files (Create/Modify):**
  - `packages/sync/src/backup/googleDriveClient.ts`
  - `packages/sync/src/backup/snapshot.ts`
  - `packages/sync/src/backup/snapshotScheduler.ts`
  - `packages/sync/src/backup/vaultCatalog.ts`
  - `apps/web/src/components/UnlockScreen.tsx`
  - `apps/web/src/runtime/createRuntime.ts`
  - `packages/sync/tests/vaultCatalog.test.ts`
- **Step-by-Step Instructions:**
  1. Store each vault in Drive `appDataFolder` as `vault-<vaultId>.header.json` (written once, never overwritten) and one snapshot per device, `vault-<vaultId>.snapshot-<deviceId>.bin`, so devices never overwrite each other's backups. Never upload a header when Drive already holds a different one for that vault id.
  2. "Use my existing vault": sign in with Google, list the vaults found in Drive (creation time and last backup only; names stay encrypted), let the user pick one and enter its passphrase (verified against the header's key check), then merge all of that vault's snapshots into a new local database via Yjs and start sync.
  3. Show the decrypted vault name once unlocked. A wrong passphrase must leave nothing on disk.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test
``` 

---

### Task 11i: Vault Management (Rename & Delete)
- **Status:** ✅ Completed (2026-10-15)
- **Type:** Full-Stack
- **Read-Only Context Files:** `packages/sync/src/backup/vaultCatalog.ts`, `apps/web/src/components/UnlockScreen.tsx`
- **Target Files (Create/Modify):**
  - `packages/sync/src/backup/vaultCatalog.ts`
  - `apps/web/src/components/VaultSettings.tsx`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/web/tests/vaultManagement.test.tsx`
- **Step-by-Step Instructions:**
  1. Rename the open vault: re-encrypt the name and update the header copy in Drive (the only header field that may change).
  2. Remove a vault from this device only (delete its local database; Drive copy kept), or delete it everywhere (also remove its Drive header and snapshots) behind an explicit confirmation that names the consequences.
  3. Devices that open a vault deleted elsewhere stop syncing it and offer to keep it as a local-only vault.
  4. Clean up Drive: remove the pre-vault-id files from Task 11c (`ankylock-snapshot.v1.bin`, `ankylock-vault-header.v1.json`), which nothing reads any more.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test
``` 

---

### Task 11j: Editor Word Wrap
- **Status:** ✅ Completed (2026-10-15)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/editor/src/components/CodeMirrorView.tsx`, `apps/web/src/keyboard/shortcuts.ts`, `apps/web/src/components/SyncStatusBar.tsx`
- **Target Files (Create/Modify):**
  - `packages/editor/src/components/CodeMirrorView.tsx`
  - `packages/editor/src/extensions/wordWrap.ts`
  - `apps/web/src/preferences/devicePreferences.ts`
  - `apps/web/src/keyboard/shortcuts.ts`
  - `apps/web/src/components/Workspace.tsx`
  - `apps/web/src/components/SyncStatusBar.tsx`
  - `apps/web/tests/wordWrap.test.tsx`
- **Step-by-Step Instructions:**
  1. Add a word-wrap preference stored per device for all vaults (a UI preference with no content, so neither synced nor encrypted). Until the user chooses, wrapping is off, except on narrow screens (under 600 px wide, e.g. the mobile PWA) where it starts on.
  2. Toggle CodeMirror line wrapping through a compartment, without remounting the editor. Wrapped continuation lines align with the line's own indentation; line numbers appear only at the start of logical lines.
  3. Toggle with Alt+Z on desktop and web (browsers leave it to the page), and with a status bar button labeled "Wrap (Alt+Z)" that shows its state (`aria-pressed`).
  4. Test the default for wide and narrow screens, persistence across reloads, the shortcut and the button.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 11k: Narrow Screens & Touch (Mobile PWA Layout)
- **Status:** ✅ Completed (2026-10-15)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `apps/web/src/components/Workspace.tsx`, `apps/web/src/components/sidebar/ContextMenu.tsx`, `apps/web/src/components/SyncStatusBar.tsx`, `apps/web/src/preferences/devicePreferences.ts`
- **Target Files (Create/Modify):**
  - `apps/web/index.html`
  - `apps/web/src/components/Workspace.tsx`
  - `apps/web/src/components/sidebar/Sidebar.tsx`
  - `apps/web/src/components/sidebar/ContextMenu.tsx`
  - `apps/web/src/components/sidebar/MoveToPicker.tsx`
  - `apps/web/src/components/tabs/TabBar.tsx`
  - `apps/web/src/components/SyncStatusBar.tsx`
  - `packages/editor/src/extensions/theme.ts`
  - `apps/web/tests/narrowLayout.test.tsx`
- **Step-by-Step Instructions:**
  1. Below 600 px (the breakpoint word wrap uses), the sidebar becomes a drawer: hidden by default, opened with a ☰ button at the start of the tab bar, sliding over the editor. It closes when a note or folder is chosen, on a tap outside it and on Escape. Wider layouts stay as they are.
  2. Add "Move to…" to the note and folder menus on every screen size: a picker of folders and categories that applies the same rules as drag-and-drop (depth, cycles, categories). On touch screens the menu opens with a long press and with a "⋯" button on each row, since HTML5 drag-and-drop does not work there.
  3. Shorten the status bar on narrow screens: the vault menu stays, the sync state becomes a short label, Sign out moves into the vault menu, Wrap and Sync now become icon buttons (with accessible names), and the backup shows only its time. Nothing may overflow.
  4. Make the layout fit phones: `100dvh` instead of `100vh`, safe-area insets (`viewport-fit=cover`) for notched screens, touch targets of at least 40 px, a horizontally scrolling tab bar, and 16 px text in the editor and inputs on narrow screens so iOS does not zoom on focus.
  5. Test the drawer, "Move to…" and the shortened status bar in jsdom, and check the layout in WebKitGTK at 375 × 700 (no horizontal overflow, editor and status bar both visible).
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 12b: Peer Catch-Up on Connect (Sync Handshake)
- **Status:** ✅ Completed (2026-10-16)
- **Type:** Backend/Service
- **Read-Only Context Files:** `SPEC.md` (§5.2), `packages/sync/src/engine/syncEngine.ts`, `packages/sync/src/hierarchy/hierarchySync.ts`
- **Target Files (Create/Modify):**
  - `packages/core/src/types/entities.ts`
  - `packages/sync/src/protocol/frame.ts`
  - `packages/sync/src/engine/peerSync.ts`
  - `packages/sync/src/engine/syncEngine.ts`
  - `packages/sync/src/hierarchy/hierarchySync.ts`
  - `packages/sync/tests/peerSync.test.ts`
  - `SPEC.md`
- **Step-by-Step Instructions:**
  1. Found by Task 12: the relay keeps no history, so when two devices edit offline and reconnect one after the other, the first one's queued packets reach nobody, and the second device only sees them after the first one's next Drive backup.
  2. On every (re)connect, a device sends a sealed `SYNC_REQUEST` with the Yjs state vector of each note it holds (stored vectors are plaintext clock metadata, so building it decrypts nothing).
  3. Every online device answers with what the requester lacks: Yjs diffs as `CRDT_DELTA` packets (decrypting only notes that are ahead), and its hierarchy records with its tombstones as one `HIERARCHY_MUTATION`. Requests and answers are sent directly, never queued.
  4. Add `SYNC_REQUEST` to the frame envelope in SPEC §5.2; the relay forwards it like any other frame.
  5. Test both reconnect orders, notes only one side has, purges, and that answers decrypt only notes that are ahead; the concurrent offline edit scenario of Task 12 must pass as written.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test
``` 

---

### Task 12: End-to-End State Machine & Cross-Device Sync Verification
- **Status:** ✅ Completed (2026-10-16)
- **Type:** Testing
- **Read-Only Context Files:** `AGENTS.md`
- **Target Files (Create/Modify):**
  - `tests/e2e/scratchpadSync.test.ts`
  - `tests/e2e/folderHierarchy.test.ts`
  - `tests/e2e/retentionLifecycle.test.ts`
  - `vitest.config.ts`
- **Step-by-Step Instructions:**
  1. Implement `scratchpadSync.test.ts`: simulate two connected clients via mock relay; write unsaved text on Client 1; verify decrypted text arrives on Client 2 without manual save.
  2. Implement `folderHierarchy.test.ts`: test edge cases including circular parenting rejection, loose note moves, and cascading folder archival.
  3. Implement `retentionLifecycle.test.ts`: trash note -> verify read-only lock -> advance virtual time 29 days -> trigger purge worker -> verify entity is deleted.
- **Verification:**
``` bash
pnpm run test && pnpm run typecheck
``` 

---

### Task 12c: Light/Dark Theme & Sidebar Row Styling
- **Status:** ✅ Completed (2026-10-20)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/editor/src/extensions/theme.ts`, `apps/web/src/preferences/devicePreferences.ts`, `apps/web/src/components/sidebar/styles.ts`
- **Target Files (Create/Modify):**
  - `apps/web/src/preferences/devicePreferences.ts`
  - `apps/web/src/theme/colorScheme.ts`
  - `apps/web/index.html`
  - `apps/web/src/components/Workspace.tsx`
  - `apps/web/src/components/UnlockScreen.tsx`
  - `apps/web/src/components/VaultSettings.tsx`
  - `apps/web/src/components/SyncStatusBar.tsx`
  - `apps/web/src/components/sidebar/styles.ts`
  - `apps/web/src/components/sidebar/{CategoryList,FolderTree,NoteItem}.tsx`
  - `apps/desktop/src/TitleBar.tsx`
  - `packages/editor/src/extensions/theme.ts`
  - `apps/web/tests/colorScheme.test.tsx`
- **Step-by-Step Instructions:**
  1. Found in manual testing: the editor follows the OS light/dark setting while the rest of the app is always light.
  2. Add a theme preference stored per device for all vaults (System, Light, Dark; default System), like word wrap. System follows `prefers-color-scheme` live.
  3. Define every app color as a token for both schemes (inline style tokens, no global CSS file) and use them everywhere: workspace, sidebar, tabs, status bar, popovers and menus, vault settings, the unlock screen, the desktop title bar and the editor. Apply the scheme before first paint so a dark setup never flashes light; keep `color-scheme` and the PWA `theme-color` in step.
  4. Put the selector in the status bar next to Wrap (an icon button on narrow screens) and in the vault menu.
  5. Give sidebar rows (categories, folders, notes) visible borders with clear hover, focus and selected states in both schemes, keeping the 40 px touch targets of narrow screens.
  6. Test the default, persistence, live System changes and the selector; check both schemes in WebKitGTK at desktop and 375 px widths.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 12d: Clickable Links in the Editor
- **Status:** ✅ Completed (2026-10-20)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/editor/src/components/CodeMirrorView.tsx`, `apps/desktop/src-tauri/capabilities/default.json`
- **Target Files (Create/Modify):**
  - `packages/editor/src/extensions/links.ts`
  - `packages/editor/src/components/CodeMirrorView.tsx`
  - `apps/web/src/components/Workspace.tsx`
  - `apps/desktop/src/App.tsx`
  - `apps/desktop/src-tauri/capabilities/default.json`
  - `packages/editor/tests/links.test.ts`
- **Step-by-Step Instructions:**
  1. Decorate `http(s)://` URLs in the visible viewport only (no full-document scan), styled as links in both themes.
  2. Hovering a link shows "Ctrl+Click to open" (⌘+Click on macOS). A plain click keeps placing the cursor; Ctrl/⌘+click opens the link. On touch screens, tapping a link shows a small "Open link" button.
  3. Opening goes through a callback the app supplies: the system browser on desktop (opener plugin, `http`/`https` only), a new tab with `noopener,noreferrer` on the web. Other schemes (`javascript:`, `file:`…) are never opened.
  4. Test detection, the modifier rule, the scheme allowlist and that a plain click edits.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 12e: Periodic Drive Backup & Close Guard
- **Status:** ✅ Completed (2026-10-20)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/sync/src/backup/snapshotScheduler.ts`, `apps/web/src/runtime/createRuntime.ts`
- **Target Files (Create/Modify):**
  - `packages/sync/src/backup/snapshotScheduler.ts`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/web/src/components/AnkyLockApp.tsx`
  - `apps/desktop/src/App.tsx`
  - `apps/desktop/src-tauri/capabilities/default.json`
  - `packages/sync/tests/snapshotScheduler.test.ts`
  - `apps/web/tests/closeGuard.test.ts`
- **Step-by-Step Instructions:**
  1. Track whether the vault changed since the last successful backup (note text, hierarchy, settings).
  2. While signed in, back up every 5 minutes, but only when something changed, and also when the vault is locked. Keep the manual Backup now. Never block local saves or sync; failures keep showing in the status bar.
  3. Desktop: when the window is closed with unbacked changes, back up first (showing "Backing up…"), then close. If it fails or takes longer than about 10 seconds, ask "Quit anyway" or "Wait".
  4. Web: with unbacked changes, show the browser's standard leave-page warning (browsers choose its text) and start a backup in the background. Without changes, or when not signed in to Drive, no warning.
  5. Test the dirty tracking, skipped runs without changes, the lock backup and both close paths.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 12f: Export (Note, Folder, Vault) with Optional Zip Password
- **Status:** ✅ Completed (2026-10-20)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `packages/storage/src/interfaces/IStorageEngine.ts`, `apps/web/src/components/sidebar/ContextMenu.tsx`
- **Target Files (Create/Modify):**
  - `apps/web/src/export/exportNotes.ts`
  - `apps/web/src/export/exportWorker.ts`
  - `apps/web/src/components/ExportDialog.tsx`
  - `apps/web/src/components/sidebar/ContextMenu.tsx`
  - `apps/web/src/components/VaultSettings.tsx`
  - `apps/desktop/src/App.tsx`
  - `apps/desktop/src-tauri/src/commands/export.rs`
  - `apps/web/tests/exportNotes.test.ts`
- **Step-by-Step Instructions:**
  1. Export a single note as a file named after its title (`.txt`, or `.md` when the title says so). Export a folder (with its subfolders) or the whole vault as a `.zip` that keeps the category and folder structure as directories. Include archived items, exclude Trash.
  2. Before every export, warn that the files leave AnkyLock's protection, and ask for confirmation.
  3. Offer "Protect with a password (AES-256)", off by default: the zip is encrypted with WinZip AES-256 (never the weak legacy ZipCrypto), and a protected single note comes as a zip too. Ask for the password twice (at least 8 characters) and say plainly that opening it needs a tool such as 7-Zip (the built-in Windows and macOS zip tools usually cannot) and that file and folder names inside stay readable.
  4. Make file names safe and unique on every OS: strip reserved characters, avoid reserved names, and add ` (2)` for duplicates.
  5. Decrypt and build the zip in a Web Worker. Save with the native save dialog on desktop and as a download on the web. Nothing leaves the device.
  6. Test the names, the structure, Trash exclusion, that a protected zip opens only with its password, and that nothing is exported without confirmation.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build && bash .claude/skills/crypto-audit/scripts/scan.sh apps/web/src/export
``` 

---

### Task 12g: Delete All Drive Data (Leave AnkyLock)
- **Status:** ✅ Completed (2026-10-20)
- **Type:** Backend/Service
- **Read-Only Context Files:** `packages/sync/src/backup/vaultCatalog.ts`, `packages/sync/src/backup/googleDriveClient.ts`, `apps/desktop/src-tauri/src/commands/oauth.rs`
- **Target Files (Create/Modify):**
  - `packages/sync/src/backup/vaultCatalog.ts`
  - `packages/sync/src/auth/googleAuth.ts`
  - `apps/web/src/auth/webGoogleAuth.ts`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/web/src/components/VaultSettings.tsx`
  - `packages/sync/tests/vaultCatalog.test.ts`
- **Step-by-Step Instructions:**
  1. Add "Delete all Drive data" to a danger zone in the settings. It explains that every vault's headers and every device's backups on Drive will be deleted, while data on this device stays. Confirm by typing `DELETE`.
  2. Stop sync and backups first, delete every AnkyLock file in the app folder (all vaults), check the folder is empty, then revoke the Google grant (desktop and web) and sign out.
  3. If deletion stops partway, report what remains and let the user retry; never revoke before the files are gone. Other devices see the vaults as deleted on Drive (11i), not as broken.
  4. Test full deletion, a partial failure with retry, and the order of revoke and sign-out.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
``` 

---

### Task 13: Production Release (Web, Relay & Desktop Distribution)
- **Type:** DevOps/Release
- **Read-Only Context Files:** `AGENTS.md`, `README.md`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/web/vite.config.ts`, `apps/relay/src/config.rs`
- **Target Files (Create/Modify):**
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
  - `apps/relay/Dockerfile`
  - `apps/web/public/privacy.html`
  - `apps/web/public/terms.html`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `README.md`
- **Step-by-Step Instructions:**
  1. Decide the hosting with the user before writing deployment config: the web PWA on `ankylock.com` (with `www.ankylock.com` redirecting to it, DNS on Cloudflare) and the relay on a subdomain such as `relay.ankylock.com` over `wss://` with TLS.
  2. Containerize the stateless relay (small image, non-root, `/healthz` probe) and configure its production client ids, bind address and frame limit through the environment only.
  3. Build the web app with the production relay URL and a strict CSP; serve it with long-lived caching for hashed assets and no caching for `sw.js` and `index.html`.
  4. Publish the Google OAuth consent screen for production: privacy policy and terms pages, the authorized domain `ankylock.com`, and verification of the requested scopes (`openid email drive.appdata`).
  5. Ship signed desktop builds from CI for Linux (AppImage, deb, rpm), Windows (signed MSI/NSIS) and macOS (signed and notarized DMG), and enable the Tauri updater with a signing key kept only in CI secrets.
  6. Add CI for every push (typecheck, lint, tests, clippy, cargo test, crypto scan) and a tagged release workflow; document the release steps and the required secrets in `README.md`. Settle the license before the first public release.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build && cargo test --workspace
``` 

---

## Dependency Graph & Critical Path

``` text
Task 1 (Workspace & Config)
   │
   ├──► Task 2 (Core Types & Enums)
   │       │
   │       ├──► Task 3 (Crypto Engine)
   │       │       │
   │       │       └──► Task 6 (Yjs CRDT & Outbox Pipeline)
   │       │               │
   │       │               └──► Task 7 (Rust Axum Blind Relay)
   │       │
   │       └──► Task 4 (SQLite DDL & Rust Manager)
   │               │
   │               └──► Task 5 (Storage Adapters)
   │
   ├──► Task 8 (CodeMirror 6 Editor) ──┐
   │                                    ▼
   └──► Task 9 (Tree Navigation & Tabs UI)
           │
           ├──► Task 10 (Retention Purge & Drive Backup)
           │       │
           │       └──► Task 10b (Folder Trash & Archive Lifecycle)
           │
           └──► Task 11 (Tauri Desktop App Wiring)
                   │
                   ├──► Task 11b (Web SPA Entry & PWA)
                   │
                   ├──► Task 11c (Google Sign-In & Sync/Backup Activation)
                   │       ├──► Task 11g (Vault Identity & Multiple Local Vaults)
                   │       │       └──► Task 11h (Open an Existing Vault from Drive)
                   │       │               ├──► Task 11d (Web Google Sign-In)
                   │       │               └──► Task 11i (Vault Management)
                   │       ├──► Task 11e (Offline Catch-Up & Hierarchy Sync)
                   │       └──► Task 11f (UI Polish)
                   │               ├──► Task 11j (Editor Word Wrap)
                   │               └──► Task 11k (Narrow Screens & Touch)
                   │
                   ├──► Task 12b (Peer Catch-Up on Connect)
                   └──► Task 12 (E2E Verification & Hardening)
                           ├──► Task 12c (Light/Dark Theme & Sidebar Rows)
                           │       └──► Task 12d (Clickable Links)
                           ├──► Task 12e (Periodic Backup & Close Guard)
                           ├──► Task 12f (Export with Optional Zip Password)
                           ├──► Task 12g (Delete All Drive Data)
                           └──► Task 13 (Production Release, after 12c–12g)
``` 
