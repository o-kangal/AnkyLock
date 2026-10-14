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

### Task 11f: UI Polish (Status Bar, Backup Progress, Title Bar Logo)
- **Type:** Frontend/UI
- **Read-Only Context Files:** `apps/web/src/components/SyncStatusBar.tsx`, `apps/desktop/src/TitleBar.tsx`, `packages/sync/src/backup/snapshotScheduler.ts`
- **Target Files (Create/Modify):**
  - `apps/web/src/components/SyncStatusBar.tsx`
  - `packages/sync/src/backup/snapshotScheduler.ts`
  - `apps/web/src/runtime/createRuntime.ts`
  - `apps/desktop/src/TitleBar.tsx`
  - `apps/web/tests/sync.test.tsx`
- **Step-by-Step Instructions:**
  1. Make the status bar taller (about 28 px with comfortable padding) so its buttons sit clear of the frameless window's bottom resize edge; clicking "Sign in with Google" must never start a window resize.
  2. Report backups in progress: add a `running` state to `BackupStatus` (emitted when a snapshot export/upload starts) and show a small spinner with "Backing up…" in the status bar until it finishes.
  3. Show the app logo (from `src-tauri/icons/app-icon.svg`, about 16 px) before the "AnkyLock" title in the desktop title bar, keeping it part of the drag region.
- **Verification:**
``` bash
pnpm -r run typecheck && pnpm -r run test && pnpm --filter @ankylock/desktop run build
``` 

---

### Task 12: End-to-End State Machine & Cross-Device Sync Verification
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
                   │       ├──► Task 11d (Web Google Sign-In)
                   │       ├──► Task 11e (Offline Catch-Up & Hierarchy Sync)
                   │       └──► Task 11f (UI Polish)
                   │
                   └──► Task 12 (E2E Verification & Hardening)
``` 
