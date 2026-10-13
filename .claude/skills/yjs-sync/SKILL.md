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

### Locked Vault Mode

If there's no Master Key yet (new device before passphrase or QR), keep receiving: write incoming encrypted packets to local storage as-is and apply them after unlock. Never drop them, and never block on them.

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
- `hub.rs`: `HashMap<AccountId, broadcast::Sender<Bytes>>` behind a lock, or a `DashMap`. Remove the entry when the last subscriber leaves so memory doesn't grow with every account ever seen.
- `ws.rs`: forward each binary frame unchanged to other sockets of the same `account_id`, and skip the sender. **Don't deserialize, inspect or log the frame body.** Log connection lifecycle and sizes at most. If routing ever needs a field, parse only the outer envelope keys and never `encrypted_envelope`.
- Handle `broadcast::error::RecvError::Lagged` by closing that slow client so it reconnects and resyncs through state vectors, rather than silently skipping frames.
- Enforce a max frame size: a little above the 10 MB note limit plus overhead.
- The relay is stateless. No database and no disk. A restart loses nothing because clients resync by state vector.

## Tests worth writing

Convergence of concurrent offline edits ("Line A" / "Line B" from SPEC §6) against two in-memory docs through a mock relay; idempotent double-apply; outbox drain after a simulated crash; echo suppression; a debounce that merges rather than drops; a tombstone arriving before or after a late update; relay tests showing frames reach same-account peers only, never the sender or other accounts; and a relay test that asserts the payload bytes are forwarded byte-for-byte.
