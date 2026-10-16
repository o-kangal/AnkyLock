import type { Bytes, SyncEntityType, SyncOutboxEntry } from '@ankylock/core';
import type { IStorageEngine } from '@ankylock/storage';
import { encodeFrame, type DeviceId, type PacketType, type SyncPacket } from '../protocol/frame.js';

/** Anything that can push a frame to the relay right now; returns false when not connected. */
export interface PacketTransport {
  send(frame: Bytes): boolean;
}

const DRAIN_BATCH = 50;

/** The outbox's `entity_type` column, kept for its CHECK constraint; `packet_type` drives replay. */
const ENTITY_TYPE_FOR: Record<Exclude<PacketType, 'SYNC_REQUEST'>, SyncEntityType> = {
  CRDT_DELTA: 'note',
  HIERARCHY_MUTATION: 'folder',
  TOMBSTONE: 'tombstone',
};

/**
 * Sends packets immediately when connected, otherwise persists them (already encrypted) to
 * `sync_outbox`. `drain()` replays the backlog in insertion order after reconnecting and deletes
 * each row only after its frame was handed to the socket. A crash between send and delete
 * resends the packet, which is safe because applying a Yjs update twice is a no-op.
 */
export class OutboxQueue {
  readonly #storage: IStorageEngine;
  readonly #transport: PacketTransport;
  readonly #deviceId: DeviceId;
  /** Unknown at startup, so assume rows may exist until a drain proves otherwise. */
  #hasBacklog = true;
  /** Bumped after every enqueue so a drain never clears the backlog flag past a concurrent one. */
  #enqueued = 0;
  #draining: Promise<void> | null = null;

  constructor(storage: IStorageEngine, transport: PacketTransport, deviceId: DeviceId) {
    this.#storage = storage;
    this.#transport = transport;
    this.#deviceId = deviceId;
  }

  /** Sends now if nothing older is waiting; otherwise queues behind the backlog to keep order. */
  async submit(packet: SyncPacket): Promise<void> {
    if (packet.packetType === 'SYNC_REQUEST') throw new Error('SYNC_REQUEST is sent on connect, never queued.');
    if (!this.#hasBacklog && this.#transport.send(encodeFrame(packet))) return;
    this.#hasBacklog = true;
    await this.#storage.enqueueOutbox({
      entityId: packet.entityId,
      entityType: ENTITY_TYPE_FOR[packet.packetType],
      packetType: packet.packetType,
      encryptedPayload: packet.payload,
    });
    // Counted once the row exists: a drain running now takes another pass and finds it.
    this.#enqueued++;
    // Without a drain running, nothing would look at the row until the next reconnect. Offline,
    // this is one cheap listing; a failure leaves the row for the next drain.
    if (!this.#draining) await this.drain().catch(() => undefined);
  }

  /** Replays queued packets oldest first; concurrent calls share one drain. */
  drain(): Promise<void> {
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  async #drain(): Promise<void> {
    for (;;) {
      const generation = this.#enqueued;
      const batch = await this.#storage.listOutbox(DRAIN_BATCH);
      if (batch.length === 0) {
        if (generation === this.#enqueued) {
          this.#hasBacklog = false;
          return;
        }
        // Something was queued while this pass ran; take another pass so it isn't stranded
        // until the next reconnect.
        continue;
      }
      for (const entry of batch) {
        if (!this.#transport.send(encodeFrame(this.#toPacket(entry)))) return;
        await this.#storage.deleteOutbox([entry.id]);
      }
    }
  }

  #toPacket(entry: SyncOutboxEntry): SyncPacket {
    return {
      packetType: entry.packetType,
      entityId: entry.entityId,
      senderDeviceId: this.#deviceId,
      timestampMs: entry.createdAt,
      payload: entry.encryptedPayload,
    };
  }
}
