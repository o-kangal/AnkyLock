# Security Review, October 2026 (Task 13b)

A review before the repository becomes public, against the [threat model](threat-model.md). It covered the git history, dependencies, the crypto core, the sync protocol, XSS and CSP, sign-in, the Tauri host, exports, the ServiceWorker and the relay.

## Automated checks

| Check | Tool | Result |
|---|---|---|
| Secrets in the whole history (55 commits) and the working tree | gitleaks 8.28 (`.gitleaks.toml`) | Clean. Only the relay's test-only RSA keys were reported; they are allow-listed because only the test JWKS trusts them. Ignored local files (`.env.local`, `target/`) are not part of the repository. |
| npm dependencies | `pnpm audit` | No known vulnerabilities. |
| Rust dependencies | `cargo audit` | One vulnerability, fixed (finding 6); 0 left. |
| Rust licenses, sources, bans | `cargo deny check` (`deny.toml`) | All licenses compatible with AGPL-3.0-or-later; crates from crates.io only. |
| Crypto patterns | `.claude/skills/crypto-audit/scripts/scan.sh` | Leads reviewed by hand; no violation (`Math.random` only for reconnect jitter and the logo). |

## Findings

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | **Relay routing fields were not authenticated.** `packet_type` and `entity_id` travel in the clear and the receiver trusted them. A hostile relay could apply one note's update to another note, and replay a single purge (`TOMBSTONE`, whose payload is only `{"entityType":"note"}`) under every note id it had seen, deleting the user's notes for good. | Payloads are sealed with `packetContext(packet_type, entity_id)` as AES-GCM additional data; the receiver opens with the same context, so a rewritten frame fails to open and is dropped. Protocol version 2; version 1 frames are refused. Tests: a relay that rewrites ids can neither purge another note nor move edits (`packages/sync/tests/syncEngine.test.ts`). |
| 2 | Medium | **PBKDF2 at 100,000 iterations**, below OWASP's current 600,000 for PBKDF2-HMAC-SHA256. | New vaults use 600,000. Vaults created before still open (floor 100,000); re-keying them is listed under Later in TASKS.md. |
| 3 | Low | **No upper bound on the iteration count** read from a vault header: a header replaced in Drive could make unlocking hang. | Counts above 10,000,000 (or not a safe integer) are refused as malformed. |
| 4 | Medium | **Short passphrases**: 8 characters allowed, while anyone with the Drive header can guess offline. | At least 12 characters for new vaults, checked in the form and in the runtime; a hint suggests a few words; a warning flags easy guesses (repeats, sequences, common passwords) without blocking. |
| 5 | Low | **Desktop CSP**: `object-src`, `base-uri` and `form-action` were unrestricted, `worker-src` allowed `blob:`, and the local development relay was allowed in release builds. | `object-src`, `base-uri`, `form-action` and `frame-src` are `'none'`; `worker-src 'self'` (no worker is built from a blob; same on the web); the development relay moved to `devCsp`. Test: `apps/desktop/tests/csp.test.ts`. |
| 6 | Medium | **RUSTSEC-2023-0071 (Marvin attack) in `rsa`**, pulled in by the relay's JWT library. The relay only verifies signatures with Google's public keys, so it was not exploitable as used. | The JWT library now uses aws-lc-rs instead of RustCrypto; `rsa` is no longer in the dependency tree. |
| 7 | Low | **Relay resources**: a channel could buffer 256 frames of up to 14 MB (3.5 GB), with no limit on connections per account and no idle timeout. | 32 frames per channel, 8 connections per account (close 1008), connections silent for 60 s are closed (4002); all configurable. Tests in `apps/relay/tests/relay_test.rs`. |

## Reviewed and accepted

- **Unmaintained or unsound crates in Tauri's Linux stack** (`proc-macro-error` via the GTK 3 macros; `zbus_names`, `zvariant`, `zvariant_derive` via D-Bus for the opener plugin and the keychain; glib's unsound `VariantStrIter`). AnkyLock does not call the affected APIs and they cannot be replaced without a Tauri upgrade. Recorded with reasons in `deny.toml`; revisit with every Tauri upgrade.
- **The desktop OAuth client secret is compiled into the app.** Google treats secrets of installed apps as public; the sign-in uses PKCE and a state check on a one-shot loopback redirect, and the refresh token stays in the OS keychain.
- **The web app uses Google's implicit flow.** Google requires a client secret for the code flow of web clients, which a static app cannot keep. The tokens arrive in the URL fragment (never sent to a server), the callback page removes it at once, sends no referrer and has its own CSP, and the tokens are kept in memory only.
- **The desktop CSP allows `wss:` to any host**, which the user's own relay needs. The desktop app can open web links through the host anyway, so `connect-src` would add little against an injected script there; the real defense is that no script can be injected (`script-src 'self'`, no HTML built from data). The web app keeps the strict policy.
- **The account email is kept in the web app's local storage** as a sign-in hint (no secret; removed at sign-out).
- **Local ciphertext is not bound to its record** (for example, a note title could be swapped with another note's title by someone who can write the database files). Such an attacker is outside the threat model.
- **Outbox packets queued before protocol version 2** are sealed without context and are dropped by peers. Pre-release only; no user data is lost, because Drive snapshots carry the full state.

## Areas reviewed without findings

- Crypto core: Web Crypto only, a fresh random 12-byte IV per encryption, 128-bit tags, `iv ‖ ciphertext ‖ tag` through shared `pack`/`unpack`, decryption failures are hard errors, the key is non-extractable, kept in memory and handed to the worker once, passphrases normalized to NFC.
- XSS: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or string timers anywhere; links open only for http(s), checked again in the desktop host; translation parameters are inserted as text.
- Tauri host: least-privilege capabilities, no file system or shell plugin, vault ids accepted only as canonical UUIDs before they become file names, exports written only where the user picks in the save dialog.
- Exports: file and folder names are sanitized, so no zip entry can leave its directory (`..`, `/`, `\`); tests added.
- ServiceWorker: caches only the app's own static files; Google, relay and the sign-in callback are never cached.
- Relay: authenticates before upgrading, takes the token from the subprotocol header (never the URL), never parses or logs frame bodies, scopes channels by account and vault, closes lagging clients.
