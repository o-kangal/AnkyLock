---
name: next-task
description: Execute the next (or a specified) task from AnkyLock's TASKS.md end to end following the AGENTS.md protocol — pick the first uncompleted task whose dependencies are done, load only its context files and the relevant domain skills, implement the target files, run the task's verification plus repo-wide checks, mark it complete, and report. Use when the user says "next task", "continue the plan", "do task 5", "implement the crypto engine task", or otherwise asks to make progress on the MVP plan.
argument-hint: "[task number — optional]"
---

# Execute a TASKS.md Task

TASKS.md is an ordered MVP plan. Each task is sized to be done and verified in one sitting, and later tasks assume earlier ones are finished as written. So the job is to finish **one** task fully and stop. Don't drift into the next task, and don't hand back a half-verified one.

## 1. Pick the task

- If `$ARGUMENTS` names a task number, use it. Otherwise pick the first task in document order without a status line.
- A completed task has this line directly under its heading. This is the only completion marker. Use it exactly so the next run can find it:
  ```
  - **Status:** ✅ Completed (YYYY-MM-DD)
  ```
- Check the "Dependency Graph & Critical Path" section. If a prerequisite of the chosen task isn't completed, stop and tell the user which one is missing.

## 2. Load context, deliberately small

- Read the task's **Read-Only Context Files**, plus the parts of SPEC.md its business rules point to. AGENTS.md is already in context.
- Load the skills that match the task's domain. They hold the rules the task text only implies:

  | Task touches | Skill |
  |---|---|
  | hierarchy, lifecycle, trash, retention, error codes (Tasks 2, 4, 5, 9, 10, 12) | `ankylock-domain` |
  | encryption, keys, any `*_ciphertext` or outbox write (Tasks 3, 6, 10) | `crypto-audit` |
  | Yjs, outbox, WebSocket, relay, Drive backup (Tasks 6, 7, 10, 12) | `yjs-sync` |
  | SQLite DDL or `migrations/` (Task 4, any schema change) | `sqlite-migration` |
  | Rust ↔ TS IPC commands (Tasks 4, 5, 11) | `tauri-ipc` |
  | editor, tabs, sidebar, Solid stores (Tasks 8, 9, 11) | `memory-check` |

- If a file the task needs to read doesn't exist, check whether its producing task is really complete before inventing its contents.

## 3. Boundary check before writing code

Write a short plan: the files you'll touch and the invariants at risk. Confirm the plan stays inside the task's **Target Files**. If the task genuinely needs a file outside that list (a shared type, a test helper), touch it minimally and name it in the report.

Watch for places where the docs conflict or the plan can't run as written. Known ones today:

- **Dependency installs are denied.** `.claude/settings.json` denies `pnpm add` and `cargo add`. Write dependencies into `package.json` / `Cargo.toml` by hand at exact, current versions (`npm view <pkg> version`), then install.
- **V1 migration is write-once.** The edit deny on `migrations/V1__initial_schema.sql` was lifted so Task 4 can create it verbatim from SPEC §4. After Task 4, remind the user to add `"Edit(migrations/V1__initial_schema.sql)"` back to the deny list. Never edit it once it exists. Don't route around a deny rule with shell redirection.
- **Placeholder crates.** Task 1 created minimal stub crates (`fn main() {}`) for `apps/relay` and `apps/desktop/src-tauri` so the Cargo workspace resolves. Tasks 4 and 7 replace their contents; they're not prior work to preserve.

When you hit a conflict not listed here, prefer SPEC.md over TASKS.md for behavior and AGENTS.md for guardrails, and mention the conflict in the report. Never resolve one by weakening a guardrail (`any`, LWW, plaintext, editing an existing migration, main-thread crypto).

## 4. Implement

Write clean, minimal code: no dead code, no speculative abstractions, no `any`. Write tests for the rules the task names. A task whose verification is `run test` but which adds no tests hasn't been verified.

## 5. Verify

Run, from the repo root:

1. The task's own **Verification** command(s), exactly as written (apart from the lockfile adjustment above).
2. `pnpm -r run typecheck` and `pnpm -r run test` once the workspace exists (Task 1 onward).
3. If Rust changed: `cargo clippy --workspace --all-targets` and `cargo test --workspace`.

If something fails, fix the cause and rerun. The bar is zero errors and zero new warnings. If a failure is outside the task's control (missing system WebKit libraries, no network, a permission deny), stop and report it with the output. Don't mark the task done.

## 6. Mark complete and stop

Add the status line under the task heading. Change nothing else in TASKS.md. Then stop. Don't start the next task even if it looks small.

## 7. Report

```
## Task <N>: <title> — Completed

**Changed files:** <list, with created/modified>
**Schema/migrations:** <new migration files, or "none">
**Verification:**
- `<command>` → pass/fail (<one-line summary>)
**Deviations & conflicts:** <files outside Target Files, doc conflicts resolved and how, or "none">
**Next:** Task <N+1>: <title>
```
