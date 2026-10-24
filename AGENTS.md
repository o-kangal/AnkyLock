# AGENTS.md - Engineering Constraints & Agent Context

## System & Architecture Overview
- **Product:** AnkyLock — Local-first, Zero-Knowledge E2EE developer scratchpad & notes manager with instant cross-device sync.
- **Desktop Shell:** Tauri v2 (Rust 1.80+) executing OS native WebViews (WebKitGTK, WebView2, WKWebView).
- **Web UI & State:** TypeScript 5.5+, Solid.js, Vite. Zero Virtual-DOM overhead, fine-grained signals.
- **Editor Core:** CodeMirror 6 (DOM line-virtualized, headless state in workers).
- **CRDT & Sync:** Yjs binary protocol (`Y.Doc`, `y-codemirror.next`). Hot sync via Rust Axum WebSocket Blind Relay; cold backup via Google Drive AppData (`drive.appdata`).
- **Cryptography:** Zero-Knowledge AES-256-GCM via native Web Crypto API (`SubtleCrypto`). The server never processes or persists plaintext metadata or content.
- **Primary Language Invariant:** All source code, interfaces, comments, database schemas, commit messages and error messages in packages must be written strictly in **English (en-US)**. UI strings are written in English in the source and translated in locale dictionaries (English and Turkish, `apps/web/src/i18n/`); never hard-code a translated string in a component.

---

## Directory Layout & Domain Boundaries

```
.
├── apps/
│   ├── desktop/             # Tauri v2 container (src-tauri Rust host + frontend binding)
│   │   └── src-tauri/       # Native IPC commands, rusqlite manager, OS keychain integration
│   ├── web/                 # Solid.js SPA entrypoint, ServiceWorker, PWA manifest, OPFS driver
│   ├── relay/               # Rust (Axum + Tokio) stateless blind WebSocket fanout node
│   └── site/                # Static landing site (ankylock.com), pre-rendered HTML in English and Turkish
├── packages/
│   ├── core/                # Domain models, state machines (XState/signals), business rules
│   ├── crypto/              # WebCrypto wrappers: AES-256-GCM, PBKDF2 key derivation, IV handling
│   ├── editor/              # CodeMirror 6 setup, keybindings, virtual viewport extensions
│   ├── storage/             # IStorageEngine interfaces: SQLite (Desktop IPC) & OPFS/IndexedDB (Web)
│   └── sync/                # Yjs providers, binary delta packing, outbox queue, WebSocket client
├── migrations/              # SQLite and PostgreSQL schema DDL files
└── package.json             # Root pnpm workspace configuration
```

---

## Deterministic CLI Commands

Always run these commands from the repository root:

- **Install Dependencies:** `pnpm install --frozen-lockfile`
- **Development (Desktop):** `pnpm --filter @ankylock/desktop tauri dev`
- **Development (Web):** `pnpm --filter @ankylock/web dev`
- **Development (Relay):** `cargo run --manifest-path apps/relay/Cargo.toml`
- **Type Check:** `pnpm -r run typecheck`
- **Linter & Formatter:** `pnpm -r run lint && cargo clippy --workspace --all-targets`
- **Unit & Integration Tests:** `pnpm -r run test`
- **Rust Backend Tests:** `cargo test --workspace`
- **Production Build:** `pnpm -r run build && pnpm --filter @ankylock/desktop tauri build`

---

## Architectural Invariants & Data Rules

1. **Entity State Machine & Hierarchy:**
   - System categories (`system_all`, `system_archive`, `system_trash`) are immutable singletons. NEVER delete, rename, or reparent them.
   - Folders can nest up to **3 levels deep**. Never allow circular parenting (`parent_id` cycle detection is mandatory before write).
   - Scratchpads (`Untitled-N`) spawn with `is_ephemeral = 1`. They must persist to local storage instantly without prompt dialogs.
2. **Soft-Delete Lifecycle:**
   - Trashing an entity sets `deleted_at = UTC_TIMESTAMP` and preserves previous `parent_id` and `category_id`.
   - Default retention is **28 days**. The hard-delete background worker purges records where `deleted_at + retention_days < now()`.
   - Entities in `system_trash` are strictly read-only.
3. **Cryptographic Security (Zero-Knowledge):**
   - Plaintext titles, folder names, category labels, and note bodies must NEVER be sent over the wire or stored unencrypted in sync queues.
   - Every mutation payload must follow: `{ iv: Uint8Array(12), ciphertext: Uint8Array, tag: Uint8Array(16) }`.
   - Google OAuth tokens are strictly for AuthN and Drive file access; NEVER derive the Master Encryption Key from OAuth credentials.
4. **Memory & UI Virtualization:**
   - CodeMirror 6 DOM instances are mounted ONLY for the actively focused tab. Background tabs must hold headless Yjs state documents only.
   - Left navigation trees must use virtual scrolling for note and folder listings exceeding 50 items.

---

## Hard Guardrails (Agent Prohibitions)

- **DO NOT** use TypeScript `any`. Use strict schemas, branded types, or `unknown` with type guards.
- **DO NOT** import Node.js native modules (`fs`, `path`, `crypto`) in shared frontend packages (`packages/*`) or in any code an app ships to the browser. Use Tauri IPC or Web APIs. Only an app's own `tests/` and root `vite.config.ts`/`vitest.config.ts` run in Node. ESLint, the crypto scan and `pnpm build:check` (which fails when Vite externalizes a Node module from any bundle, workers included) enforce this.
- **DO NOT** use Monaco Editor or Electron packages under any circumstances.
- **DO NOT** introduce global CSS files or UI component libraries (e.g., MUI, AntD). Use utility classes or headless Solid primitives. The one exception is the static landing site `apps/site`, which keeps its styles in a single stylesheet (`src/styles/site.css`) so its CSP can forbid inline styles; the apps themselves stay without global CSS.
- **DO NOT** execute blocking CPU tasks (encryption, delta parsing, syntax detection) on the main thread. Delegate all heavy operations to Dedicated Web Workers.
- **DO NOT** modify existing SQLite migration files in `migrations/`. Always append a new versioned migration script (`V<timestamp>__description.sql`).
- **DO NOT** implement Last-Write-Wins (LWW) overrides for text conflicts. All text merges must pass through Yjs CRDT binary updates.

---

## Agent Task Execution Protocol

When executing an assigned task, you must follow this loop deterministically:

1. **Context Discovery:** Read relevant interfaces in `packages/core` and `packages/storage` before modifying implementation code.
2. **Plan & Boundary Check:** Verify that the proposed changes respect the 3-level folder limit, memory constraints, and encryption layers.
3. **Implementation:** Write clean, minimal, functional TypeScript or idiomatic Rust. Never add dead code or premature abstractions.
4. **Verification Step:** Run `pnpm -r run typecheck` and `pnpm -r run test`. If Rust was modified, run `cargo clippy` and `cargo test`.
5. **Report:** Succinctly summarize changed files, verification results, and any schema/migration additions.