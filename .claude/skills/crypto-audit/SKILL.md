---
name: crypto-audit
description: Zero-knowledge E2EE rules for AnkyLock — how to implement AES-256-GCM encryption with Web Crypto (IV handling, the iv‖ciphertext‖tag byte layout, base64 for TEXT columns, PBKDF2 key derivation, MEK handling, worker offload) and how to audit code for plaintext leaks. Use it when writing or reviewing anything in packages/crypto, any code that writes *_ciphertext columns, sync_outbox, WebSocket frames, Drive snapshots or key storage, and whenever the user asks for a crypto/security/E2EE audit of a diff, file or package (/crypto-audit <target>).
argument-hint: "[package, path, or empty for current changes]"
---

# Zero-Knowledge Crypto: Implement & Audit

AnkyLock's promise is that the relay, Google Drive and any log line only ever see opaque bytes. One plaintext folder name in a WebSocket frame breaks that promise. A reused IV is worse: with AES-GCM it leaks the XOR of two plaintexts and lets an attacker forge authentication tags. The rules below exist for these two reasons.

## Part 1: Implementing

### Byte layout

There is one representation in memory and one on the wire or in storage. They are the same data:

- **In memory (typed):** `{ iv: Uint8Array /*12*/, ciphertext: Uint8Array, tag: Uint8Array /*16*/ }`. This is the form AGENTS.md describes.
- **Serialized:** `iv ‖ ciphertext ‖ tag` as one byte string (SPEC §5.1). BLOB columns store it raw. TEXT columns (`*_ciphertext TEXT`) and the relay's `encrypted_envelope` store it base64-encoded.

TASKS.md Task 2 types `EncryptedPayload` as three strings. Treat that as the base64 transport form if it's needed at all. Don't create a second, parallel binary type. Put the conversion functions (`pack`/`unpack`, `toBase64`/`fromBase64`) in `packages/crypto` and use them everywhere, never hand-rolled slicing.

`crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data)` returns `ciphertext ‖ tag` already joined. The tag is the last 16 bytes. Slice it off to build the typed form. Join it back before calling `decrypt`. Getting this wrong causes `OperationError` on decrypt with no hint about why.

### Rules

1. **Use a fresh IV for every encrypt call:** `crypto.getRandomValues(new Uint8Array(12))` inside the encrypt function itself. Never take the IV as a parameter from callers, and never use a counter, a constant, `Math.random`, or an IV derived from the note id.
2. **Use Web Crypto only.** No `node:crypto`, no JS AES libraries, no `crypto-js`. In `packages/*` there are no Node built-ins at all, and tests rely on the global `crypto` (Node 20+ provides it).
3. **Key derivation:** PBKDF2-SHA-256: new vaults use 600,000 iterations (OWASP), vaults from before Task 13b still open with 100,000, and headers above 10,000,000 are refused (denial of service). Use a random per-vault salt of 16 bytes or more, stored next to the recovery blob, never a fixed salt. Derive with `deriveKey` into an AES-GCM 256 `CryptoKey` with `extractable: false`, unless a wrap/export flow explicitly needs it.
4. **Keep the MEK separate from OAuth.** The Master Encryption Key comes from the user passphrase or the device-to-device QR handshake. Never derive it from Google tokens, account ids or emails.
5. **MEK storage:** keep it in memory as a non-extractable `CryptoKey`. On desktop, persist it only through the OS keychain (Tauri command). On web, persisting it at all is a product decision. If it's persisted, store the non-extractable `CryptoKey` object in IndexedDB, never raw bytes. Never use `localStorage` or `sessionStorage`, and never plaintext SQLite.
6. **Encrypt before the data reaches any queue.** Plaintext titles, bodies, folder names and category names are encrypted before they reach `sync_outbox`, `note_contents`, a WebSocket send, a Drive upload or a log statement. A sync packet built from an unencrypted Yjs update is a leak, even if it gets encrypted "later".
7. **Run crypto off the main thread.** Encryption, decryption and key derivation run in a Dedicated Web Worker. Pass bytes as transferables. A `CryptoKey` can be structured-cloned into the worker once at unlock.
8. **Locked Vault Mode:** with no MEK available, incoming encrypted deltas are buffered as ciphertext in SQLite and the UI stays locked. Never "decrypt later" by keeping plaintext placeholders around.
9. **Treat decrypt failure as a hard error.** An auth tag failure means the data was tampered with or the wrong key was used. Surface it. Never fall back to showing the raw ciphertext or an empty note that then gets saved over the original.

### Tests worth writing

Round-trip; two encryptions of the same plaintext produce different IVs and ciphertexts; flipping one bit of the ciphertext, tag or IV makes decrypt throw; a wrong key throws; `unpack(pack(x))` is the identity; base64 round-trip; empty plaintext; a 10 MB plaintext.

## Part 2: Auditing

Audit target: `$ARGUMENTS`. If it's empty, audit the current changes. This directory may not be a git repository yet. If `git diff` fails, ask which paths to audit instead of auditing the whole tree silently.

1. Run the bundled scanner for a fast first pass:
   ```bash
   bash .claude/skills/crypto-audit/scripts/scan.sh <path...>
   ```
   It greps for known-bad patterns: `Math.random` near IVs, constant or reused IVs, `localStorage`/`sessionStorage` near key material, Node `crypto` imports in `packages/`, plaintext field names being logged or serialized into outbox/frames, and `extractable: true`. Its hits are **leads, not verdicts**. Read each one in context. CI runs it with `--strict`, which fails only on the checks marked `hard` in the script (patterns with no legitimate use here: an IV parameter on `encrypt`, key material in Web Storage, Node imports in shipped code, extractable keys, keys from OAuth material). The Node-import check skips only an app's own `tests/` and root Vite/Vitest config, which run in Node; `pnpm build:check` backs it up by failing when Vite externalizes a Node module from any bundle.
2. Then trace data flow by hand. Grep alone won't catch these. For each sink (`sync_outbox` insert, `ws.send`, Drive upload, `console.*`/`tracing::*`, `*_ciphertext` column write), follow the value backwards and confirm it went through `encrypt`/`pack` from `packages/crypto`. Check the relay (`apps/relay`) too: it must forward frames without deserializing or logging the `encrypted_envelope`.
3. Check every rule in Part 1, not only the three original checks: fresh IV, no plaintext at the sinks, MEK not persisted insecurely, key separation, KDF parameters, the decrypt failure path, main-thread crypto.

### Report format

```
## Crypto Audit — <target>

| # | Check | Result | Location | Detail |
|---|-------|--------|----------|--------|
| 1 | Fresh 12-byte random IV per encrypt | PASS/FAIL/N/A | file:line | ... |
| 2 | No plaintext in sync_outbox / WS frames / Drive / logs | ... |
| 3 | MEK never in localStorage/sessionStorage/plaintext SQLite | ... |
| 4 | MEK not derived from OAuth material | ... |
| 5 | KDF: PBKDF2-SHA-256, 600k iters for new vaults (≥100k to open, ≤10M), random salt | ... |
| 10 | Routing fields the relay sees (`packet_type`, `entity_id`) bound as AES-GCM additional data | ... |
| 6 | Layout iv‖ct‖tag via shared pack/unpack | ... |
| 7 | Crypto off main thread | ... |
| 8 | Decrypt failure handled as hard error | ... |
| 9 | Relay forwards without parsing/logging payload | ... |

### Violations
<one block per FAIL: file:line, what leaks or breaks, concrete fix>
```

Use N/A only when the target contains no code relevant to that check, and say why. Every FAIL needs an exact `file:line`.
