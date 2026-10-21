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

## App icons

The sources are `apps/desktop/src-tauri/icons/app-icon.svg` and `app-icon-maskable.svg` (full-bleed, for the PWA). To regenerate every size after editing them:

```bash
cd apps/desktop
pnpm exec tauri icon src-tauri/icons/app-icon.svg            # desktop: .ico, .icns, PNGs
pnpm exec tauri icon src-tauri/icons/app-icon.svg -o /tmp/web -p 192 -p 512
pnpm exec tauri icon src-tauri/icons/app-icon-maskable.svg -o /tmp/maskable -p 512
# then copy /tmp/web/{192x192,512x512}.png to apps/web/public/icons/icon-{192,512}.png
# and /tmp/maskable/512x512.png to apps/web/public/icons/icon-maskable-512.png
# (delete the generated icons/android and icons/ios: mobile is out of MVP scope)
```

On Linux (GNOME/Wayland) the dock takes an app's icon from a `.desktop` entry matching the window's `StartupWMClass`, so `tauri dev` shows a generic icon until one exists. Installed packages ship that entry (`StartupWMClass=ankylock-desktop`). For development, copy `icons/128x128.png`, `icons/128x128@2x.png` and `icons/icon.png` to `~/.local/share/icons/hicolor/{128x128,256x256,512x512}/apps/ankylock-desktop.png` and create `~/.local/share/applications/ankylock-desktop.desktop` (named after the window's app id) with `Icon=ankylock-desktop`, `StartupWMClass=ankylock-desktop` and `NoDisplay=true`. GNOME caches icons by path, so after regenerating the icons copy them again and run `gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor`; a new icon may only show after logging out and in.
