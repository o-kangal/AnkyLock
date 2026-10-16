---
name: yjs-sync
description: How AnkyLock syncs — Yjs CRDT doc management, 150 ms debounced encrypted delta packing, the offline sync_outbox queue, the WebSocket client, the Rust Axum blind relay, the frame envelope, tombstones, Locked Vault Mode, and the no-Last-Write-Wins rule. Use it when writing or reviewing packages/sync, apps/relay, Drive snapshot backup, or multi-device/offline/conflict tests, or whenever a task mentions syncing, merging, reconnecting, relaying or replicating notes or hierarchy changes.
---

# Sync: Yjs CRDT + Blind Relay

Two rules shape the whole design:

- **Text never merges by Last-Write-Wins.** Concurrent edits converge through Yjs updates (`Y.applyUpdate`). LWW silently drops one user's work, and that loss is the bug this product exists to prevent.
- **The relay is blind.** It sees routing metadata and opaque bytes, nothing else. Everything a relay could learn, it would eventually log.

## Client pipeline (packages/sync)

```
Y.Doc update ──► debounce 150 ms (merge with Y.mergeUpdates) ──► encrypt (worker) ──► frame
     │                                                                        │
     └─► persist locally (note_contents.yjs_updates) immediately        online? ── yes ─► WebSocket send
                                                                              └─ no ──► sync_outbox
```

- **docManager**: one `Y.Doc` per open tab or note, keyed by note id, independent of whether an editor is mounted. Docs for closed notes are destroyed (`doc.destroy()`) after their state is persisted.
- **Local persistence comes first and doesn't wait for the network.** Scratchpads (BR-NOTE-01) persist on every change. Store the encrypted update log or a compacted state. Compact periodically: `Y.encodeStateAsUpdate(doc)` replaces the accumulated updates, and `yjs_state_vector` = `Y.encodeStateVector(doc)`.
- **Debouncing**: collect updates for 150 ms, merge them with `Y.mergeUpdates`, and send one packet. Never debounce by dropping updates. Every update byte must reach peers, because Yjs updates are not idempotent snapshots.
- **Echo suppression**: when applying a remote update, pass an origin (`Y.applyUpdate(doc, bytes, REMOTE_ORIGIN)`) and skip re-broadcasting updates whose `transaction.origin === REMOTE_ORIGIN`. Without this, two peers ping-pong forever.
- **Encryption** happens before a packet exists. Plaintext Yjs bytes never enter the outbox or a socket (see the `crypto-audit` skill for the layout and IV rules). Run it in the worker.
- **Outbox** (`sync_outbox`): when offline or when a send fails, insert `{entity_id, entity_type, encrypted_payload, created_at}`. On reconnect, drain in `id` order. Delete a row only after the send succeeds. A crash mid-drain then resends, which is safe because applying a Yjs update twice is a no-op.
- **Reconnect handshake**: on reconnect, exchange state vectors per open doc and send `Y.encodeStateAsUpdate(doc, remoteStateVector)`. That catches up on anything the relay dropped while you were away. The relay keeps no history.
- **WebSocket client**: exponential backoff with jitter (cap ~30 s), heartbeat ping/pong, and dead-connection detection. Unregister all handlers on dispose (see `memory-check`).
- **Frame kinds (implemented in Task 6):** binary frames carry data (UTF-8 JSON envelope, below). Text frames are control messages. Browsers can't send WebSocket ping frames, so the heartbeat is the text frame `ping`, which the **relay itself must answer with `pong`** and never forward. The relay forwards only binary frames. Without a `pong` within the timeout, the client closes the socket and reconnects.
- **Known gaps (as of Task 6):** `sync_outbox` stores `entity_type`, not the packet type, so `HIERARCHY_MUTATION` packets (which can target notes too) can't be queued until a migration adds a `packet_type` column. The reconnect state-vector handshake isn't built yet: there is no packet type for it in SPEC §5.2.
- **Encryption types:** sync code depends on the `Sealer` interface from `@ankylock/crypto`. In the app it is `createWorkerSealer(new Worker(...@ankylock/crypto/worker))`; in tests it's `createKeySealer`. Payloads are `SealedBytes`, so plaintext can't type-check into a packet or the outbox.

### Hierarchy and tombstones

Folder, category and note metadata (moves, archive, trash) are not Yjs text. They travel as `HIERARCHY_MUTATION` packets with encrypted bodies. On apply, re-validate with the `ankylock-domain` rules. A cycle created by concurrent moves is repaired (detach to the All Notes root), not rejected. `TOMBSTONE` packets come from purges. Applying one deletes the entity locally and records it in `sync_tombstones` so a late-arriving update can't resurrect it.

**As built (Task 11e):**
- **State, not operations.** A `HIERARCHY_MUTATION` carries the changed records (whole subtrees for cascading folder archive/trash/restore), sealed as one payload. `publishingStorage` wraps the store's storage and publishes after each write; remote changes apply to the unwrapped storage, so nothing echoes.
- **Clocks.** `mergeRecords` keeps a record unless the local clock is newer: `updatedAt` for folders and categories, `metaUpdatedAt` for notes. A note's `updatedAt` also moves on text edits, so it must never decide metadata. `meta_updated_at` is kept by SQLite triggers (IndexedDB: `withMetaClock`). Equal clocks favor the incoming record, so a device's own changes within one millisecond arrive in order.
- **Repair** (`planHierarchyRepair`): deterministic, so it's never sent anywhere. A cycle loses the link of its smallest id; a folder deeper than 3 moves to the root. Dangling references become null inside `mergeRecords`.
- **Catch-up** (`createCatchUp`): the relay keeps no history. On sync start and every reconnect, merge the other devices' Drive snapshots in order: tombstones, then records, then text via `mergeNoteUpdate`, which only saves when the state vector changed (no write and no clock change on replays). Snapshots carry tombstones. Locking backs up first, so other devices can catch up on the session.
- **Outbox** stores `packet_type`; `entity_type` stays only for its CHECK constraint. A submit that queues while no drain runs drains itself, and the enqueue counter moves only after the row is written; otherwise a packet queued at connect time can strand until the next reconnect (found twice: Tasks 11c and 12).
- **Sync handshake (Task 12b):** the relay keeps no history, so packets drained while the peer was offline reach no one. On every (re)connect a device sends a sealed `SYNC_REQUEST` with its notes' state vectors (stored plaintext vectors, nothing decrypted) and its tombstones. Online peers apply those purges and answer directly (never queued) with Yjs diffs for notes that are ahead (only those are decrypted) and one `HIERARCHY_MUTATION` with their records and tombstones. Two devices reconnecting one after the other now converge without Drive.
- **Retention and locking:** `RetentionWorker.stop()` also ends a run in progress; a purge after the vault locked could not seal its tombstone.
- **End-to-end suite:** `tests/` is the `@ankylock/e2e` workspace package (two runtimes, a mock relay that records frames to assert only ciphertext crossed it). Move only `Date` with fake timers there; real timers keep storage and reconnects working, and wait helpers count polls instead of reading the clock.

### Vaults (Task 11g)

Every vault is isolated: its own salt, key, database (`ankylock-<vaultId>.db` on desktop, IndexedDB `ankylock-<vaultId>` on web) and relay channel. `IVaultDirectory` lists, creates and opens them; the runtime builds a fresh `WorkspaceStore`, sync engine and backup scheduler per opened vault and tears them all down on `lock()`. Two test devices on the same vault must share the vault id and header (create the second one's vault with the first one's header and derive the key from the same passphrase), not just a `CryptoKey`, or relay scoping goes untested.

### Locked Vault Mode

If there's no Master Key yet (new device before passphrase or QR), keep receiving: write incoming encrypted packets to local storage as-is and apply them after unlock. Never drop them, and never block on them.

## Cold backup (Task 10)

`exportSnapshot` serializes every storage record into one JSON document (already-encrypted fields stay encrypted) and seals the whole document with the MEK. The outer seal hides structure (ids, counts, timestamps) from Drive. The format is portable between web and desktop. `createSnapshotScheduler` uploads it to `appDataFolder` daily and on network idle, together with the non-secret vault header (`serializeVaultHeader`) that a new device needs for passphrase recovery. Failures surface as a `BackupStatus` (`auth` / `quota` / `network` / `http` / `snapshot` / `conflict`) and never block local saves or sync.

**Per-vault layout (Task 11h, `vaultCatalog.ts`):** `vault-<vaultId>.header.json` (vault id, creation time, key header, encrypted name) is created once with `drive.create` and never overwritten; if Drive holds a different header for the vault id, the scheduler reports `conflict` and uploads nothing. Each device writes only `vault-<vaultId>.snapshot-<deviceId>.bin`, where `deviceId` is stored per vault (`getDeviceId`), so devices never overwrite each other's backups. Opening a vault on a new device checks the passphrase against the header *before* writing anything, then `mergeSnapshots` combines every device's snapshot (note text through Yjs, metadata by newest `updatedAt`) and `importVault` fills the new, empty vault in one transaction. Tests: `FakeDrive` in `apps/web/tests/helpers.ts` fakes the Drive REST calls behind `fetch`.

**Vault lifecycle in Drive (Task 11i):** `syncHeaderFile` is the only code that touches a vault's header file: it creates it once, moves the name (newest `nameUpdatedAt` wins; the key header never changes), and reports `conflict` or `deleted`. A device remembers `headerOnDrive`, so a missing header later means *deleted elsewhere*: stop syncing and never re-upload; the user may keep the vault local-only. Run header checks one at a time (catch-up and the first backup both ask at sync start). `deleteVaultFromDrive` removes snapshots before the header, so an interrupted delete can be retried. Drive tokens use only the `drive.appdata` scope and never touch key material.

## Frame envelope (SPEC §5.2)

```json
{
  "protocol_version": 1,
  "packet_type": "CRDT_DELTA | HIERARCHY_MUTATION | TOMBSTONE",
  "entity_id": "uuid-v4",
  "sender_device_id": "uuid-v4",
  "timestamp_ms": 1776100000000,
  "encrypted_envelope": "<base64(iv + ciphertext + tag)>"
}
```

`entity_id`, `packet_type` and the timestamps are visible to the relay. That is an accepted metadata leak. Don't add anything else in the clear: no titles, no folder ids of parents, no sizes beyond what's inherent. Reject frames with an unknown `protocol_version` on the client, but don't crash.

## Relay (apps/relay, Rust Axum + Tokio)

- Authenticate the socket at upgrade time (`auth.rs`: verify the token and extract `account_id`). Reject before upgrading. Never accept the account id as a client-supplied field.
- **Auth as built (Task 7):** the client offers `Sec-WebSocket-Protocol: ankylock.v1, <Google ID token>`, and the relay echoes `ankylock.v1`. The token never goes in the URL, because URLs end up in logs. `GoogleAuthenticator` checks RS256 against Google's JWKS (cached 1 h; an unknown `kid` triggers at most one refetch per 60 s), the issuer, `aud = GOOGLE_CLIENT_ID` and expiry. `account_id = sub`. ID tokens expire after an hour, so `BlindWebSocketClient` calls `getToken()` on every reconnect. Tests use the `Authenticator` / `KeySource` traits with fixture keys in `apps/relay/tests/fixtures/`.
- **Vault scoping (Task 11g, BR-SEC-04):** clients connect to `/ws/<vaultId>` and the hub keys channels by `Channel { account, vault }`. Devices on different vaults of one Google account must never receive each other's frames: they couldn't decrypt them and would only produce errors. The runtime appends the open vault's id to `relayUrl`; `VaultId::parse` accepts only short `[A-Za-z0-9-]` ids.
- **Web sign-in (Task 11d):** no Google script in the page. One popup runs the implicit flow (`response_type=token id_token`) and `public/oauth-callback.js` hands the fragment back over a `BroadcastChannel`; check `state`, `nonce`, `aud` and the granted `drive.appdata` scope. The ServiceWorker must bypass the callback page. Browsers get no refresh token, so the web transport sets `canRefresh: false`: at expiry the session turns `stale`, the live relay connection keeps running, and reconnects/backups wait for a one-click renewal. The relay's `GOOGLE_CLIENT_ID` lists both the desktop and the web client id.
- `hub.rs`: `HashMap<Channel, broadcast::Sender<Bytes>>` behind a lock. Remove the entry when the last subscriber leaves so memory doesn't grow with every account ever seen.
- `ws.rs`: forward each binary frame unchanged to other sockets of the same `account_id`, and skip the sender. **Don't deserialize, inspect or log the frame body.** Log connection lifecycle and sizes at most. If routing ever needs a field, parse only the outer envelope keys and never `encrypted_envelope`.
- Handle `broadcast::error::RecvError::Lagged` by closing that slow client so it reconnects and resyncs through state vectors, rather than silently skipping frames.
- Enforce a max frame size: a little above the 10 MB note limit plus overhead.
- The relay is stateless. No database and no disk. A restart loses nothing because clients resync by state vector.

## Tests worth writing

Convergence of concurrent offline edits ("Line A" / "Line B" from SPEC §6) against two in-memory docs through a mock relay; idempotent double-apply; outbox drain after a simulated crash; echo suppression; a debounce that merges rather than drops; a tombstone arriving before or after a late update; relay tests showing frames reach same-account peers only, never the sender or other accounts; and a relay test that asserts the payload bytes are forwarded byte-for-byte.
