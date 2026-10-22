import * as Y from 'yjs';
import { SYNC_DEBOUNCE_MS, type EpochMs, type NoteId } from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import { packetContext, type DeviceId, type SyncPacket } from '../protocol/frame.js';
import { REMOTE_ORIGIN } from './docManager.js';

export interface DeltaPackerOptions {
  readonly sealer: Sealer;
  readonly deviceId: DeviceId;
  readonly onPacket: (packet: SyncPacket) => Promise<void>;
  /** Called when sealing or delivery fails; the local doc keeps the edit either way. */
  readonly onError: (error: unknown) => void;
  readonly now?: () => EpochMs;
  readonly windowMs?: number;
}

export interface DocWatcher {
  /** Seals and emits any batched updates now; resolves when all emitted packets are delivered. */
  flush(): Promise<void>;
  /** Stops watching after flushing pending updates, so nothing typed is dropped. */
  dispose(): Promise<void>;
}

/**
 * Batches local Yjs updates for `windowMs` (BR-NOTE-02), merges them with `Y.mergeUpdates`,
 * encrypts the merged update and emits one CRDT_DELTA packet. Updates are merged, never dropped,
 * and packets are emitted in order. Remote-origin updates are skipped to avoid echo loops.
 */
export function watchDoc(noteId: NoteId, doc: Y.Doc, options: DeltaPackerOptions): DocWatcher {
  const windowMs = options.windowMs ?? SYNC_DEBOUNCE_MS;
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivered: Promise<void> = Promise.resolve();

  function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending.length === 0) return delivered;
    const batch = pending;
    pending = [];
    delivered = delivered.then(async () => {
      try {
        const merged = new Uint8Array(Y.mergeUpdates(batch));
        await options.onPacket({
          packetType: 'CRDT_DELTA',
          entityId: noteId,
          senderDeviceId: options.deviceId,
          timestampMs: now(),
          payload: await options.sealer.seal(merged, packetContext('CRDT_DELTA', noteId)),
        });
      } catch (error) {
        options.onError(error);
      }
    });
    return delivered;
  }

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return;
    pending.push(update);
    // Fixed window from the first update: latency stays bounded while the user keeps typing.
    timer ??= setTimeout(() => void flush(), windowMs);
  };

  doc.on('update', onUpdate);

  return {
    flush,
    dispose() {
      doc.off('update', onUpdate);
      return flush();
    },
  };
}
