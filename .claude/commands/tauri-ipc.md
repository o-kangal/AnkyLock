Create a type-safe Tauri v2 IPC command bridge for: $ARGUMENTS
1. Implement the #[tauri::command] function in apps/desktop/src-tauri/src/commands/ with explicit Result<T, AppError> return types.
2. Register the command in apps/desktop/src-tauri/src/main.rs invoke_handler.
3. Verify permissions in apps/desktop/src-tauri/capabilities/default.json.
4. Add the matching TypeScript interface in packages/core and bind the invoke call inside packages/storage/src/adapters/tauriSqliteAdapter.ts.
5. Run cargo check and pnpm --filter @ankylock/storage run typecheck.