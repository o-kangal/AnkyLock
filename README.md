# AnkyLock

Local-first, zero-knowledge end-to-end encrypted developer scratchpad and notes manager with instant cross-device sync.

- **Desktop:** Tauri v2 (Linux, macOS, Windows)
- **Web:** Solid.js PWA
- **Editor:** CodeMirror 6
- **Sync:** Yjs CRDT over a stateless Rust (Axum) blind WebSocket relay, with encrypted Google Drive backups
- **Crypto:** AES-256-GCM via the Web Crypto API — the server only ever sees ciphertext

> Status: early development. See [`TASKS.md`](TASKS.md) for the MVP plan and [`SPEC.md`](SPEC.md) for the functional specification.

## Repository layout

```
apps/
  desktop/   Tauri v2 shell (src-tauri: Rust host, SQLite, keychain)
  web/       Solid.js SPA / PWA
  relay/     Rust blind WebSocket relay
packages/
  core/      Domain models and business rules
  crypto/    Web Crypto wrappers (AES-256-GCM, PBKDF2)
  editor/    CodeMirror 6 setup
  storage/   Storage engine interface and adapters
  sync/      Yjs providers, outbox queue, WebSocket client
migrations/  SQL schema migrations
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- Rust 1.80+ with the `wasm32-unknown-unknown` target
- Tauri system dependencies: https://v2.tauri.app/start/prerequisites/

## Commands

Run from the repository root:

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Desktop dev | `pnpm --filter @ankylock/desktop tauri dev` |
| Web dev | `pnpm --filter @ankylock/web dev` |
| Relay dev | `cargo run --manifest-path apps/relay/Cargo.toml` |
| Type check | `pnpm -r run typecheck` |
| Lint | `pnpm -r run lint && cargo clippy --workspace --all-targets` |
| Tests | `pnpm -r run test && cargo test --workspace` |
| Build | `pnpm -r run build && pnpm --filter @ankylock/desktop tauri build` |
