import type * as Y from 'yjs';
import type { CategoryId, EpochMs, FolderId, NoteId } from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import type { IStorageEngine, RemoteRecords } from '@ankylock/storage';
import { BlindWebSocketClient, type ConnectionStatus, type SocketLike } from '../client/blindWebSocketClient.js';
import type { DocManager } from '../crdt/docManager.js';
import { watchDoc, type DocWatcher } from '../crdt/deltaPacker.js';
import { applyRemoteRecords, applyRemoteTombstone, createHierarchyPacket, readHierarchyPayload } from '../hierarchy/hierarchySync.js';
import { mergeNoteUpdate } from '../persistence/notePersistence.js';
import { createTombstonePacket, decodeFrame, type DeviceId, type SyncPacket } from '../protocol/frame.js';
import { OutboxQueue } from '../queue/outboxQueue.js';

export interface SyncEngineOptions {
  readonly storage: IStorageEngine;
  readonly sealer: Sealer;
  readonly docs: DocManager;
  readonly deviceId: DeviceId;
  readonly relayUrl: string;
  /** Current Google ID token; read on every (re)connect. */
  readonly getIdToken: () => string;
  /** Notes changed or removed by another device (empty for folder and category changes); the UI reloads. */
  readonly onRemoteChange: (noteIds: NoteId[]) => void;
  readonly onStatusChange: (status: ConnectionStatus) => void;
  /** The outbox drained after (re)connecting: a good moment for a background backup. */
  readonly onIdle?: () => void;
  readonly onError: (error: unknown) => void;
  readonly createSocket?: (url: string, protocols: string[]) => SocketLike;
}

export interface SyncEngine {
  start(): void;
  /** Stops sending and receiving after flushing pending local edits into the outbox. */
  stop(): Promise<void>;
  /** Starts sending this open doc's local edits. */
  watch(noteId: NoteId, doc: Y.Doc): void;
  unwatch(noteId: NoteId): Promise<void>;
  /** Tells other devices that an entity was purged (BR-LIFE-04). */
  submitTombstone(entityId: NoteId | FolderId | CategoryId, entityType: 'note' | 'folder' | 'category'): Promise<void>;
  /** Sends records the user changed here: folders, categories, note placement and lifecycle. */
  submitHierarchy(records: RemoteRecords): Promise<void>;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Live sync over the blind relay. Outgoing: local Yjs edits are batched, sealed and sent, or
 * queued in the encrypted outbox while offline, like hierarchy changes and purges. Incoming:
 * sealed deltas merge with Y.applyUpdate (never last-write-wins), into the open doc or the stored
 * state; hierarchy records merge by their clocks and are repaired; tombstones purge.
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { storage, sealer, docs, deviceId } = options;
  const watchers = new Map<NoteId, DocWatcher>();
  /** Per-note chain so merges into stored state never interleave. */
  const merging = new Map<NoteId, Promise<void>>();
  let running = false;

  const client = new BlindWebSocketClient({
    url: options.relayUrl,
    getToken: options.getIdToken,
    onFrame: (frame) => void receive(frame),
    onStatusChange: (status) => {
      options.onStatusChange(status);
      if (status === 'open') {
        void queue.drain().then(() => options.onIdle?.(), options.onError);
      }
    },
    ...(options.createSocket ? { createSocket: options.createSocket } : {}),
  });
  const queue = new OutboxQueue(storage, client, deviceId);

  async function mergeIntoStorage(noteId: NoteId, update: Uint8Array): Promise<void> {
    await mergeNoteUpdate({ storage, sealer }, noteId, update);
  }

  /** Hierarchy changes and purges apply one at a time, so each repair sees the previous merge. */
  let structural: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const next = structural.then(work);
    structural = next.catch(() => undefined);
    return next;
  };

  async function apply(packet: SyncPacket): Promise<void> {
    const noteId = packet.entityId as NoteId;
    const plaintext = await sealer.open(packet.payload);
    switch (packet.packetType) {
      case 'CRDT_DELTA': {
        if (!docs.applyRemote(noteId, plaintext)) {
          const previous = merging.get(noteId) ?? Promise.resolve();
          const next = previous.then(() => mergeIntoStorage(noteId, plaintext));
          merging.set(noteId, next.catch(() => undefined));
          await next;
        }
        options.onRemoteChange([noteId]);
        return;
      }
      case 'TOMBSTONE': {
        const { entityType } = JSON.parse(textDecoder.decode(plaintext)) as { entityType?: unknown };
        if (entityType !== 'note' && entityType !== 'folder' && entityType !== 'category') return;
        await inOrder(() => applyRemoteTombstone(storage, packet.entityId, entityType));
        options.onRemoteChange(entityType === 'note' ? [noteId] : []);
        return;
      }
      case 'HIERARCHY_MUTATION': {
        const records = readHierarchyPayload(plaintext);
        await inOrder(() => applyRemoteRecords(storage, records));
        options.onRemoteChange([]);
        return;
      }
    }
  }

  async function receive(frame: Uint8Array): Promise<void> {
    const decoded = decodeFrame(new Uint8Array(frame));
    if (!decoded.ok || decoded.packet.senderDeviceId === deviceId) return;
    try {
      await apply(decoded.packet);
    } catch (error) {
      options.onError(error);
    }
  }

  return {
    start() {
      running = true;
      client.connect();
    },

    async stop() {
      running = false;
      await Promise.all([...watchers.values()].map((w) => w.dispose()));
      watchers.clear();
      client.dispose();
    },

    watch(noteId, doc) {
      if (!running || watchers.has(noteId)) return;
      watchers.set(
        noteId,
        watchDoc(noteId, doc, {
          sealer,
          deviceId,
          onPacket: (packet) => queue.submit(packet),
          onError: options.onError,
        }),
      );
    },

    async unwatch(noteId) {
      const watcher = watchers.get(noteId);
      watchers.delete(noteId);
      await watcher?.dispose();
    },

    async submitTombstone(entityId, entityType) {
      if (!running) return;
      await queue.submit(await createTombstonePacket(sealer, deviceId, entityId, entityType, Date.now() as EpochMs));
    },

    async submitHierarchy(records) {
      if (!running) return;
      await queue.submit(await createHierarchyPacket(sealer, deviceId, records, Date.now() as EpochMs));
    },
  };
}

