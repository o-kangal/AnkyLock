import * as Y from 'yjs';
import { deriveTitle, type FolderId, type NoteId } from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import type { IStorageEngine } from '@ankylock/storage';
import { BlindWebSocketClient, type ConnectionStatus, type SocketLike } from '../client/blindWebSocketClient.js';
import { TEXT_FIELD, type DocManager } from '../crdt/docManager.js';
import { watchDoc, type DocWatcher } from '../crdt/deltaPacker.js';
import { loadNoteState, saveNoteState } from '../persistence/notePersistence.js';
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
  /** Notes changed or removed by another device; the UI reloads them. */
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
  submitTombstone(entityId: NoteId | FolderId, entityType: 'note' | 'folder'): Promise<void>;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const LINE_ONE_LIMIT = 1024;

/**
 * Live note sync over the blind relay. Outgoing: local Yjs edits are batched, sealed and sent, or
 * queued in the encrypted outbox while offline. Incoming: sealed deltas are opened and merged
 * with Y.applyUpdate (never last-write-wins), into the open doc or into the stored state.
 * Folder and category changes are not synced yet (Task 11e).
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
    const note = await storage.getNote(noteId);
    if (note === null) await storage.createNote(noteId);
    const doc = new Y.Doc();
    try {
      const stored = await loadNoteState({ storage, sealer }, noteId);
      if (stored) Y.applyUpdate(doc, stored);
      Y.applyUpdate(doc, update);
      const text = doc.getText(TEXT_FIELD).toString();
      const firstLine = text.slice(0, LINE_ONE_LIMIT).split('\n', 1)[0] ?? '';
      await saveNoteState({ storage, sealer }, noteId, doc, deriveTitle(firstLine));
    } finally {
      doc.destroy();
    }
  }

  async function removeNote(noteId: NoteId): Promise<void> {
    const note = await storage.getNote(noteId);
    if (note === null) return;
    if (note.deletedAt === null) await storage.trashNote(noteId);
    await storage.purgeNote(noteId);
  }

  async function apply(packet: SyncPacket): Promise<void> {
    const noteId = packet.entityId as NoteId;
    const plaintext = await sealer.open(packet.payload);
    if (packet.packetType === 'CRDT_DELTA') {
      if (!docs.applyRemote(noteId, plaintext)) {
        const previous = merging.get(noteId) ?? Promise.resolve();
        const next = previous.then(() => mergeIntoStorage(noteId, plaintext));
        merging.set(noteId, next.catch(() => undefined));
        await next;
      }
    } else if (packet.packetType === 'TOMBSTONE') {
      const { entityType } = JSON.parse(textDecoder.decode(plaintext)) as { entityType?: unknown };
      // Folder tombstones need hierarchy sync (Task 11e).
      if (entityType !== 'note') return;
      await removeNote(noteId);
    } else {
      return; // HIERARCHY_MUTATION: Task 11e.
    }
    options.onRemoteChange([noteId]);
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
      await queue.submit(await createTombstonePacket(sealer, deviceId, entityId, entityType, Date.now() as SyncPacket['timestampMs']));
    },
  };
}

