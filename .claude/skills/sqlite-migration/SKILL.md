---
name: sqlite-migration
description: Add a database schema change to AnkyLock the safe way — append a new versioned migration (V<timestamp>__description.sql) instead of editing existing ones, keep user-content columns as *_ciphertext, wire it into the Rust migration runner and the web adapter, bump schema_version, and test upgrade from the previous version. Use whenever a task needs a new table, column, index, constraint or seed row, touches migrations/, or changes how SQLite/OPFS data is shaped — even if the user just says "add a field to notes".
argument-hint: "<short description, e.g. add_note_pinning>"
---

# Adding a Database Migration

Existing installs already ran every migration in `migrations/`. If you edit one, fresh installs and upgraded installs end up with different schemas, and nothing reports it. So a migration is never edited. Every change, including a fix to a bad earlier migration, is a new file that moves the schema forward.

`migrations/V1__initial_schema.sql` is special: its content is fixed by SPEC.md §4. Task 4 creates it verbatim, and after that nothing touches it. `.claude/settings.json` denies edits to it.

## Steps

1. **Read the current schema.** Read every file in `migrations/` in version order and form the effective schema. Don't rely on SPEC.md §4 alone, because later migrations may have changed it.

2. **Create the file** with the helper, which picks a UTC timestamp version:
   ```bash
   bash .claude/skills/sqlite-migration/scripts/new_migration.sh add_note_pinning
   ```
   This creates `migrations/V<YYYYMMDDHHMMSS>__add_note_pinning.sql` with a header. Versions sort numerically, so `V1` sorts before any timestamp. Use lowercase snake_case for the description.

3. **Write the DDL.** Follow these rules:
   - **Encrypt content.** Any column holding user-authored text (titles, names, bodies, labels, tags) is named `*_ciphertext` and holds base64(iv‖ct‖tag) in TEXT or raw bytes in BLOB. Never add a plaintext `title`, `name` or `tag` column, even "just for search". Server-side search over plaintext is out of scope by design.
   - **Timestamps** are `INTEGER` UTC epoch milliseconds.
   - **Ids** are `TEXT` UUIDv4.
   - **Booleans** are `INTEGER NOT NULL DEFAULT 0` with values 0 or 1.
   - SQLite's `ALTER TABLE` is limited. To change a column type or constraint, use the 12-step rebuild: create `new_x`, `INSERT … SELECT`, drop `x`, rename, recreate indexes. Run it with `PRAGMA foreign_keys=OFF` around it and `PRAGMA foreign_key_check` afterwards.
   - Give new columns on existing tables a `DEFAULT` (or allow `NULL`) so existing rows stay valid.
   - Bump the version as the last statement: `UPDATE app_settings SET value = '<n>' WHERE key = 'schema_version';`, where `<n>` is the next integer. The integer counts migrations and is not the timestamp.
   - Seed rows for system singletons use `INSERT OR IGNORE` so re-running is harmless.

4. **Wire it in.**
   - Desktop: add the file to the embedded list in `apps/desktop/src-tauri/src/db/migrations.rs` (`include_str!("../../../../migrations/V…sql")`, with the path relative to that `.rs` file). The runner applies files in version order, each in its own transaction, and records which ones it applied.
   - Web: the OPFS/IndexedDB adapter must apply the same change. If it uses SQLite WASM, it runs the same SQL. If it uses IndexedDB, add the matching object store or index change in its `onupgradeneeded` version step.
   - Types: update `packages/core` entity types and both storage adapters in the same change.

5. **Postgres?** AGENTS.md mentions PostgreSQL DDL, but the relay is stateless and stores nothing. Only add a Postgres migration if the task explicitly introduces server-side persistence. Even then it may hold only ciphertext and routing metadata.

6. **Test the upgrade path, not only a fresh install.** Write a Rust test that applies migrations up to the previous version, inserts representative rows, applies the new one, and asserts both that the data survived and that the new schema is in place. Also run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

7. **Verify:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` and `pnpm -r run typecheck`. In the final report, list the new migration file explicitly. AGENTS.md asks for schema changes to be called out.
