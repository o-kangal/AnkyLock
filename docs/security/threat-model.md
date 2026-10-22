# AnkyLock Threat Model

AnkyLock promises that notes are readable only on the user's own devices, after the user enters the vault's passphrase. Google Drive, an optional relay and anyone on the network see ciphertext and a small, documented set of metadata. This document states what is protected, from whom, and where the trust boundaries are. The findings of each review are kept in [`review-2026.md`](review-2026.md).

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| Note text, titles, folder and category names, the vault name | Device storage (SQLite on desktop, IndexedDB on web), Drive snapshots, relay frames | AES-256-GCM under the vault key; never stored or sent in the clear |
| Vault key (MEK) | Memory only: a non-extractable `CryptoKey` in the page and in the crypto worker | Derived from the passphrase at every unlock (PBKDF2-SHA-256, 600,000 iterations for new vaults, random 16-byte salt); never written to disk, never exported |
| Vault passphrase | The user's head (or password manager); typed into the unlock form | Never stored, never sent; at least 12 characters, with a warning for easy guesses |
| Google tokens | Desktop: refresh token in the OS keychain, short-lived tokens in memory. Web: short-lived tokens in memory | Scopes `openid email drive.appdata` only; used for sign-in and the app's hidden Drive folder, never for key material (BR-SEC-03) |
| Integrity of vault data | Everywhere the ciphertext goes | GCM authentication; relay routing fields bound as additional data |

Visible metadata, accepted by design (SPEC §5): entity ids, packet types and timestamps on the relay; Drive file names (vault id, device id), sizes and modification times; on the device, record ids, timestamps and the tree's shape. The account email is kept in the web app's local storage as a sign-in hint.

## Trust boundaries

1. **Page ↔ crypto worker.** Encryption runs in a Dedicated Web Worker holding the key; the page sends bytes and receives sealed bytes.
2. **WebView ↔ Tauri host (desktop).** The frontend reaches the host only through the IPC commands granted in `capabilities/default.json`: storage, sign-in, opening web links (http and https only) and saving exports through the native save dialog. No file system or shell access is exposed to the WebView.
3. **Device ↔ Google Drive.** Drive stores the vault header (salt, iteration count, encrypted key check, encrypted vault name) and each device's sealed snapshot. Google is trusted to store files, not to keep them secret.
4. **Device ↔ relay (optional, desktop).** The relay is not part of the default setup. A user may run their own and enter it in the desktop app. It routes sealed frames and authenticates connections with the user's Google ID token.
5. **App ↔ its update and distribution channel.** Releases are to be built in CI and published with checksums, build provenance and a signed update manifest (Task 13g).

## Attackers and what they can do

| Attacker | Can | Cannot |
|---|---|---|
| **Someone with the user's Drive** (Google, or whoever holds a Drive token) | Read and delete AnkyLock's Drive files, see their metadata, replace files, try to guess the passphrase offline against the vault header | Read notes without the passphrase; slip in data that opens under the vault key; make unlocking hang with an absurd iteration count (headers above 10,000,000 are refused) |
| **A hostile or compromised relay** | See routing metadata, drop or delay frames, replay old frames (idempotent: Yjs updates, newer-wins metadata, already-applied purges), receive the user's short-lived Google ID token | Read payloads; forge frames; move a payload to another note or another packet type (bound as GCM additional data, so it fails to open) |
| **A network attacker** | Observe traffic volumes and timing | Read or change traffic (TLS to Google and to a `wss://` relay; the web app sets a strict CSP) |
| **A malicious dependency or injected script** | Everything the page can do, including reading open notes | Run without being shipped: no inline script is allowed (`script-src 'self'`), no HTML is ever built from data (no `innerHTML`), dependencies are audited (`pnpm audit`, `cargo audit`, `cargo deny`; on every push once CI runs them, Task 13d) |
| **Someone with the unlocked device** | Read the open vault | Read other vaults or the locked vault without their passphrases |
| **Someone with the locked device or its disk** | Copy encrypted databases and try to guess the passphrase offline; read the visible metadata above | Read notes without the passphrase |

Out of scope: malware running as the user on an unlocked device (keyloggers, memory readers), and an attacker who knows the passphrase.

## Design rules that keep these properties

- A fresh random 12-byte IV for every encryption; AES-GCM 128-bit tags; decryption failure is a hard error, never a silent fallback.
- Every relay packet is sealed with `packetContext(packet_type, entity_id)` as additional data (protocol version 2).
- The key never leaves memory; locking forgets it in the page and in the worker.
- Production builds have no default relay; the web app's CSP allows no relay but the one it was built with.
- The relay never parses or logs frame bodies, authenticates before upgrading, limits frame size, connections per account and idle time, and keeps no state.
