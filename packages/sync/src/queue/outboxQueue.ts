import type { Bytes, SyncEntityType, SyncOutboxEntry } from '@ankylock/core';
import type { IStorageEngine } from '@ankylock/storage';
import { encodeFrame, type DeviceId, type PacketType, type SyncPacket } from '../protocol/frame.js';

/** Anything that can push a frame to the relay right now; returns false when not connected. */
export interface PacketTransport {
  send(frame: Bytes): boolean;
}

const DRAIN_BATCH = 50;

/**
 * The outbox schema stores `entity_type`, not the packet type. Only one-to-one mappings are
 * supported until HIERARCHY_MUTATION packets get their own column (they can target notes too).
 */
const ENTITY_TYPE_FOR: Partial<Record<PacketType, SyncEntityType>> = {
  CRDT_DELTA: 'note',
  TOMBSTONE: 'tombstone',
};

const PACKET_TYPE_FOR: Partial<Record<SyncEntityType, PacketType>> = {
  note: 'CRDT_DELTA',
  tombstone: 'TOMBSTONE',
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
  /** Bumped on every enqueue so a drain never clears the backlog flag past a concurrent enqueue. */
  #enqueued = 0;
  #draining: Promise<void> | null = null;

  constructor(storage: IStorageEngine, transport: PacketTransport, deviceId: DeviceId) {
    this.#storage = storage;
    this.#transport = transport;
    this.#deviceId = deviceId;
  }

  /** Sends now if nothing older is waiting; otherwise queues behind the backlog to keep order. */
  async submit(packet: SyncPacket): Promise<void> {
    const entityType = ENTITY_TYPE_FOR[packet.packetType];
    if (entityType === undefined) {
      throw new Error(`${packet.packetType} packets cannot be queued until the outbox stores packet types.`);
    }
    if (!this.#hasBacklog && this.#transport.send(encodeFrame(packet))) return;
    this.#hasBacklog = true;
    this.#enqueued++;
    await this.#storage.enqueueOutbox({
      entityId: packet.entityId,
      entityType,
      encryptedPayload: packet.payload,
    });
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
        if (generation === this.#enqueued) this.#hasBacklog = false;
        return;
      }
      for (const entry of batch) {
        if (!this.#transport.send(encodeFrame(this.#toPacket(entry)))) return;
        await this.#storage.deleteOutbox([entry.id]);
      }
    }
  }

  #toPacket(entry: SyncOutboxEntry): SyncPacket {
    const packetType = PACKET_TYPE_FOR[entry.entityType];
    if (packetType === undefined) throw new Error(`Cannot replay outbox entity type ${entry.entityType}.`);
    return {
      packetType,
      entityId: entry.entityId,
      senderDeviceId: this.#deviceId,
      timestampMs: entry.createdAt,
      payload: entry.encryptedPayload,
    };
  }
}
