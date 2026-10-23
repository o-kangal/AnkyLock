# Contributing to AnkyLock

Thank you for helping! Bug reports, ideas and pull requests are all welcome. For security issues, please follow [`SECURITY.md`](SECURITY.md) instead of opening an issue.

## Getting started

Install Node.js 20+, pnpm 9+, Rust 1.80+ and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then:

```bash
pnpm install --frozen-lockfile
pnpm --filter @ankylock/web dev          # or: pnpm --filter @ankylock/desktop tauri dev
```

The apps run local-only without Google credentials; [`README.md`](README.md#build-from-source) explains how to add them.

## Before you open a pull request

Run, from the repository root:

```bash
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
cargo clippy --workspace --all-targets
cargo test --workspace
```

All of them must pass with no new warnings. Add tests for what you change: the rules a change touches should be covered by a test that would fail without it.

## How the code is written

[`AGENTS.md`](AGENTS.md) holds the engineering rules every change follows, for people and coding agents alike. The ones most often relevant:

- **Never weaken the encryption.** Note text, titles and names are encrypted before they are stored or leave the device; a fresh random IV for every encryption; no plaintext in logs, queues or packets. Read [`docs/security/threat-model.md`](docs/security/threat-model.md) before touching `packages/crypto`, `packages/sync` or `apps/relay`.
- **Text merges go through Yjs**, never last-write-wins.
- **Strict TypeScript**: no `any`; no Node.js modules in `packages/*`; heavy work (encryption, parsing) in Web Workers.
- **No global CSS or UI component libraries**; styles are inline, from the shared tokens.
- **Database changes** go in a new migration in `migrations/`; existing migrations are never edited.
- **English in the source.** Code, comments, commit messages and package error messages are in English; UI text is written in English and translated in `apps/web/src/i18n/` (every key needs a Turkish translation too).
- **Dependencies** are added at exact versions, under licenses compatible with the AGPL-3.0 (`cargo deny check`); run `pnpm notices` to update [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Commit messages follow the conventional style used in the history (`feat:`, `fix:`, `docs:`, …), with a short summary line.

## License of contributions

AnkyLock is licensed under the [GNU AGPL-3.0-or-later](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
