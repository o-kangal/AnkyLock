---
name: tauri-ipc
description: Create or change a type-safe Tauri v2 IPC command end to end in AnkyLock — Rust #[tauri::command] with Result<T, AppError>, registration in the invoke handler, capability permissions, the matching TypeScript types in packages/core, and the binding in tauriSqliteAdapter. Use whenever a feature needs the desktop frontend to call Rust (SQLite queries, keychain, filesystem, OS integration), when adding a method to IStorageEngine that the desktop adapter must back, or when the user runs /tauri-ipc <command>.
argument-hint: "<command name or capability, e.g. move_folder>"
---

# Tauri v2 IPC Command Bridge

Target: `$ARGUMENTS`

An IPC command is a contract between two languages, so it fails at the seams: argument names in the wrong case, an error shape the TS side doesn't expect, or a capability that was never granted. The command then fails at runtime even though both sides compile. Build all layers in one change and check each seam.

## Steps

1. **Read first.** `packages/core` (entity types, error codes) and `packages/storage/src/interfaces/IStorageEngine.ts`. If the command backs an `IStorageEngine` method, the signature is already decided there. Match it instead of inventing a new one. If the command touches hierarchy or lifecycle, load the `ankylock-domain` skill. If it touches encrypted fields, load `crypto-audit`.

2. **Rust command** in `apps/desktop/src-tauri/src/commands/<area>.rs`:
   ```rust
   #[tauri::command]
   pub async fn move_folder(
       state: tauri::State<'_, DbPool>,
       folder_id: String,
       new_parent_id: Option<String>,
   ) -> Result<Folder, AppError> { ... }
   ```
   - Return `Result<T, AppError>` always. `AppError` implements `serde::Serialize` as `{ code: "ERR_…", message: "…" }`, and `code` uses the same strings as the TS error union. This lets the frontend branch on `code` instead of parsing messages.
   - No `unwrap()`/`expect()` on anything derived from input or I/O. A panic in a command kills the call without a usable error.
   - Do multi-statement writes (validation + update, purge + tombstone) in one `rusqlite` transaction.
   - Blocking SQLite work goes through `tauri::async_runtime::spawn_blocking` (or the pool's blocking API) so the async runtime isn't stalled.
   - Arguments arrive as ciphertext strings or bytes for encrypted fields. Rust never decrypts. The desktop host stores what it's given.

3. **Register** the command in `tauri::generate_handler![...]` in `main.rs` (or `lib.rs`, wherever the builder lives).

4. **Permissions.** Tauri v2 denies by default. Custom app commands need an entry in the app's permission set: `src-tauri/permissions/*.toml` with `commands.allow = ["move_folder"]`, or the build-script `AppManifest` command list. Then reference that permission in `src-tauri/capabilities/default.json`. Grant the narrowest permission that works, and don't add `core:default`-style wildcards just to make it pass.

5. **TypeScript types** in `packages/core`: argument and result types, with branded ids where they exist. No `any`. Validate the result shape with a type guard, because IPC returns `unknown` at runtime.

6. **Adapter binding** in `packages/storage/src/adapters/tauriSqliteAdapter.ts`:
   ```ts
   import { invoke } from '@tauri-apps/api/core';
   const raw: unknown = await invoke('move_folder', { folderId, newParentId });
   ```
   Tauri converts Rust `snake_case` arguments to **camelCase** keys on the JS side by default. Sending `folder_id` fails with "missing required key folderId". Catch the rejection and map `{ code }` into the core error type.

   If the web adapter needs the same capability, implement it in `webOpfsAdapter.ts` with an identical signature. The two adapters must stay interchangeable.

7. **Tests.** Add a Rust unit test for the command's core logic. Factor it into a plain function that takes a `&Connection` so it can be tested without a Tauri runtime. Cover at least one error path that returns the expected `code`.

8. **Verify** (from the repo root):
   ```bash
   cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
   cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
   pnpm --filter @ankylock/storage run typecheck
   ```
   Report each command's result. If one can't run yet (for example, the crate doesn't exist yet), say so rather than skipping it silently.
