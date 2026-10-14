import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { CategoryId, Ciphertext, FolderId, NoteId } from '@ankylock/core';
import { createKeySealer, createTextCodec, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DocManager,
  TEXT_FIELD,
  createSyncEngine,
  loadNoteState,
  publishingStorage,
  type DeviceId,
  type SocketLike,
  type SyncEngine,
} from '../src/index.js';

/** In-memory blind relay: forwards binary frames to every other open socket, answers ping. */
class FakeRelay {
  readonly sockets = new Set<FakeSocket>();
  forward(from: FakeSocket, data: Uint8Array): void {
    for (const s of this.sockets) if (s !== from && s.readyState === 1) s.deliver(data);
  }
}

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly relay: FakeRelay,
    readonly online: () => boolean,
  ) {
    relay.sockets.add(this);
    queueMicrotask(() => {
      if (!this.online()) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') return;
    this.relay.forward(this, data);
  }

  close(): void {
    this.readyState = 3;
    this.relay.sockets.delete(this);
  }

  deliver(data: Uint8Array): void {
    const copy = data.slice().buffer;
    this.onmessage?.({ data: copy } as MessageEvent);
  }
}

interface Device {
  readonly engine: SyncEngine;
  readonly docs: DocManager;
  readonly storage: WebIndexedDbAdapter;
  readonly changed: NoteId[];
  online: boolean;
}

function device(relay: FakeRelay, sealer: Sealer, id: string, online = true): Device {
  const storage = new WebIndexedDbAdapter(new IDBFactory());
  const docs = new DocManager();
  const changed: NoteId[] = [];
  const d: Device = { engine: undefined as unknown as SyncEngine, docs, storage, changed, online };
  const engine = createSyncEngine({
    storage,
    sealer,
    docs,
    deviceId: id as DeviceId,
    relayUrl: 'ws://relay.test/ws',
    getIdToken: () => 'id-token',
    onRemoteChange: (ids) => changed.push(...ids),
    onStatusChange: () => undefined,
    onError: (e) => {
      throw e;
    },
    createSocket: () => new FakeSocket(relay, () => d.online),
  });
  Object.assign(d, { engine });
  return d;
}

async function sealer(): Promise<Sealer> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return createKeySealer(() => key);
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const NOTE = 'n-1' as NoteId;

describe('createSyncEngine', () => {
  it('streams edits into the same note open on another device', async () => {
    const relay = new FakeRelay();
    const s = await sealer();
    const a = device(relay, s, 'desktop-a');
    const b = device(relay, s, 'desktop-b');
    a.engine.start();
    b.engine.start();
    const docA = a.docs.open(NOTE);
    b.docs.open(NOTE);
    a.engine.watch(NOTE, docA);
    await until(() => relay.sockets.size === 2, 'both connected');

    docA.getText(TEXT_FIELD).insert(0, 'const secret = 42;');
    await until(() => b.docs.get(NOTE)?.getText(TEXT_FIELD).toString() === 'const secret = 42;', 'live text on B');
    expect(b.changed).toContain(NOTE);
    await Promise.all([a.engine.stop(), b.engine.stop()]);
  });

  it('merges edits for notes that are closed or unknown into encrypted storage', async () => {
    const relay = new FakeRelay();
    const s = await sealer();
    const a = device(relay, s, 'desktop-a');
    const b = device(relay, s, 'desktop-b');
    a.engine.start();
    b.engine.start();
    await until(() => relay.sockets.size === 2, 'both connected');
    const docA = a.docs.open(NOTE);
    a.engine.watch(NOTE, docA);

    docA.getText(TEXT_FIELD).insert(0, 'Shopping list\nmilk');
    await until(async () => (await b.storage.getNote(NOTE)) !== null && (await b.storage.getNoteContent(NOTE)) !== null, 'note on B');
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await loadNoteState({ storage: b.storage, sealer: s }, NOTE)) as Uint8Array);
    expect(restored.getText(TEXT_FIELD).toString()).toBe('Shopping list\nmilk');
    const title = await createTextCodec(s).decrypt((await b.storage.getNoteContent(NOTE))!.titleCiphertext);
    expect(title).toBe('Shopping list');
    await Promise.all([a.engine.stop(), b.engine.stop()]);
  });

  it('queues edits made offline and delivers them after reconnecting', async () => {
    const relay = new FakeRelay();
    const s = await sealer();
    const a = device(relay, s, 'desktop-a', false);
    const b = device(relay, s, 'desktop-b');
    a.engine.start();
    b.engine.start();
    b.docs.open(NOTE);
    const docA = a.docs.open(NOTE);
    a.engine.watch(NOTE, docA);

    docA.getText(TEXT_FIELD).insert(0, 'written offline');
    await until(async () => (await a.storage.listOutbox(10)).length === 1, 'queued on A');

    a.online = true;
    await a.engine.stop();
    const reconnected = device(relay, s, 'desktop-a');
    Object.assign(reconnected, { storage: a.storage });
    // Same storage, new connection: the queued packet drains on open.
    const engine = createSyncEngine({
      storage: a.storage,
      sealer: s,
      docs: a.docs,
      deviceId: 'desktop-a' as DeviceId,
      relayUrl: 'ws://relay.test/ws',
      getIdToken: () => 'id-token',
      onRemoteChange: () => undefined,
      onStatusChange: () => undefined,
      onError: (e) => {
        throw e;
      },
      createSocket: () => new FakeSocket(relay, () => true),
    });
    engine.start();
    await until(() => b.docs.get(NOTE)?.getText(TEXT_FIELD).toString() === 'written offline', 'drained to B');
    expect(await a.storage.listOutbox(10)).toEqual([]);
    await Promise.all([engine.stop(), b.engine.stop()]);
  });

  it('purges a note everywhere when another device purges it', async () => {
    const relay = new FakeRelay();
    const s = await sealer();
    const a = device(relay, s, 'desktop-a');
    const b = device(relay, s, 'desktop-b');
    await b.storage.createNote(NOTE);
    a.engine.start();
    b.engine.start();
    await until(() => relay.sockets.size === 2, 'both connected');

    await a.engine.submitTombstone(NOTE, 'note');
    await until(async () => (await b.storage.getNote(NOTE)) === null, 'purged on B');
    expect(b.changed).toContain(NOTE);
    await Promise.all([a.engine.stop(), b.engine.stop()]);
  });

  it('flushes pending edits into the outbox when stopped', async () => {
    const relay = new FakeRelay();
    const s = await sealer();
    const a = device(relay, s, 'desktop-a', false);
    a.engine.start();
    const doc = a.docs.open(NOTE);
    a.engine.watch(NOTE, doc);
    doc.getText(TEXT_FIELD).insert(0, 'last words');
    await a.engine.stop();
    expect(await a.storage.listOutbox(10)).toHaveLength(1);
  });

  describe('hierarchy', () => {
    /** The storage the UI writes through: every change is published to the engine. */
    const ui = (d: Device) =>
      publishingStorage(d.storage, {
        onRecords: (records) => void d.engine.submitHierarchy(records),
        onRemoved: (id, type) => void d.engine.submitTombstone(id as FolderId, type),
        onError: (e) => {
          throw e;
        },
      });
    const name = 'Zg==' as Ciphertext;
    const f = (id: string) => id as FolderId;

    async function pair(onlineA = true, onlineB = true) {
      const relay = new FakeRelay();
      const s = await sealer();
      const a = device(relay, s, 'desktop-a', onlineA);
      const b = device(relay, s, 'desktop-b', onlineB);
      a.engine.start();
      b.engine.start();
      return { relay, s, a, b };
    }

    it('syncs folder, category and note placement changes live', async () => {
      const { relay, a, b } = await pair();
      await until(() => relay.sockets.size === 2, 'both connected');
      const storageA = ui(a);
      await storageA.createCategory('cat' as CategoryId, name);
      await storageA.createFolder({ id: f('work'), parentId: null, categoryId: 'cat' as CategoryId, nameCiphertext: name });
      await storageA.createNote(NOTE);
      await storageA.moveNote(NOTE, f('work'), null);
      await until(async () => (await b.storage.getNote(NOTE))?.folderId === 'work', 'note filed on B');
      expect((await b.storage.listFolders())[0]).toMatchObject({ id: 'work', categoryId: 'cat' });

      await storageA.trashFolder(f('work'));
      await until(async () => (await b.storage.listTrashedFolders()).length === 1, 'folder trashed on B');
      expect((await b.storage.getNote(NOTE))?.deletedAt).not.toBeNull();

      await storageA.purgeFolder(f('work'));
      await a.engine.submitTombstone(f('work'), 'folder');
      await storageA.deleteCategory('cat' as CategoryId);
      await until(async () => (await b.storage.listCategories()).length === 0, 'category deleted on B');
      expect(await b.storage.listTrashedFolders()).toEqual([]);
      expect(await b.storage.getNote(NOTE)).toBeNull();
      await Promise.all([a.engine.stop(), b.engine.stop()]);
    });

    it('converges after a distributed circular move made offline (SPEC §7)', async () => {
      const { s, a, b } = await pair(false, false);
      for (const d of [a, b]) {
        await d.storage.createFolder({ id: f('f1'), parentId: null, categoryId: null, nameCiphertext: name });
        await d.storage.createFolder({ id: f('f2'), parentId: null, categoryId: null, nameCiphertext: name });
      }
      // Offline: A moves f1 into f2 while B moves f2 into f1.
      await ui(a).moveFolder(f('f1'), f('f2'));
      await ui(b).moveFolder(f('f2'), f('f1'));
      await until(async () => (await a.storage.listOutbox(10)).length === 1 && (await b.storage.listOutbox(10)).length === 1, 'queued');
      await Promise.all([a.engine.stop(), b.engine.stop()]);

      // Both come back online: each outbox drains into the other device.
      const relay = new FakeRelay();
      const applied = [0, 0];
      const online = [a, b].map((d, i) =>
        createSyncEngine({
          storage: d.storage,
          sealer: s,
          docs: d.docs,
          deviceId: `desktop-${i}` as DeviceId,
          relayUrl: 'ws://relay.test/ws',
          getIdToken: () => 'id-token',
          onRemoteChange: () => void applied[i]!++,
          onStatusChange: () => undefined,
          onError: (e) => {
            throw e;
          },
          createSocket: () => new FakeSocket(relay, () => true),
        }),
      );
      // Both sockets exist before either opens, so each drain reaches the other device.
      for (const engine of online) engine.start();
      const shape = async (d: Device) =>
        Object.fromEntries((await d.storage.listFolders()).map((folder) => [folder.id, folder.parentId]));
      await until(() => applied[0] === 1 && applied[1] === 1, "each device applied the other's move");
      // Each device saw the cycle and broke it the same way: at f1, the smallest id.
      await until(async () => JSON.stringify(await shape(a)) === JSON.stringify(await shape(b)), 'converged');
      expect(await shape(a)).toEqual({ f1: null, f2: 'f1' });
      await Promise.all(online.map((engine) => engine.stop()));
    });
  });
});
