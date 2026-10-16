import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_DAY, type Ciphertext, type EpochMs, type FolderId, type NoteId } from '@ankylock/core';
import { createKeySealer } from '@ankylock/crypto';
import { StorageError, WebIndexedDbAdapter, type IStorageEngine } from '@ankylock/storage';
import {
  OutboxQueue,
  changeTrashRetention,
  createTombstonePacket,
  purgeExpired,
  startRetentionWorker,
  type DeviceId,
  type PurgedEntity,
} from '../src/index.js';

const T0 = 1_776_100_000_000;

function world() {
  let t = T0;
  const now = (): EpochMs => t as EpochMs;
  const storage = new WebIndexedDbAdapter(new IDBFactory(), now);
  return {
    storage,
    now,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const noteEntity = (id: string): PurgedEntity => ({ entityType: 'note', id: id as NoteId });

async function trashedNote(storage: IStorageEngine, id: string): Promise<NoteId> {
  await storage.createNote(id as NoteId);
  await storage.trashNote(id as NoteId);
  return id as NoteId;
}

describe('purgeExpired (BR-LIFE-04)', () => {
  it('purges only after the retention window, to the millisecond', async () => {
    const { storage, now, advance } = world();
    await trashedNote(storage, 'old');
    advance(28 * MS_PER_DAY);
    expect(await purgeExpired({ storage, now })).toEqual([]);
    advance(1);
    expect(await purgeExpired({ storage, now })).toEqual([noteEntity('old')]);
    expect(await storage.getNote('old' as NoteId)).toBeNull();
  });

  it('never auto-purges with retention 0 (manual purge only)', async () => {
    const { storage, now, advance } = world();
    await storage.setTrashRetentionDays(0);
    await trashedNote(storage, 'kept');
    advance(10_000 * MS_PER_DAY);
    expect(await purgeExpired({ storage, now })).toEqual([]);
    expect(await storage.getNote('kept' as NoteId)).not.toBeNull();
  });

  it('leaves live notes alone', async () => {
    const { storage, now, advance } = world();
    await storage.createNote('live' as NoteId);
    advance(400 * MS_PER_DAY);
    expect(await purgeExpired({ storage, now })).toEqual([]);
  });

  it('queues an encrypted TOMBSTONE packet for each purge', async () => {
    const { storage, now, advance } = world();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const sealer = createKeySealer(() => key);
    const deviceId = 'desktop-a' as DeviceId;
    const queue = new OutboxQueue(storage, { send: () => false }, deviceId);
    await trashedNote(storage, 'gone');
    advance(29 * MS_PER_DAY);

    await purgeExpired({
      storage,
      now,
      onPurged: async (entity) =>
        queue.submit(await createTombstonePacket(sealer, deviceId, entity.id, entity.entityType, now())),
    });

    const [entry] = await storage.listOutbox(10);
    expect(entry).toMatchObject({ entityId: 'gone', entityType: 'tombstone' });
    const payload = await sealer.open(entry?.encryptedPayload as NonNullable<typeof entry>['encryptedPayload']);
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({ entityType: 'note' });
  });

  it('keeps going when one purge fails', async () => {
    const { storage, now, advance } = world();
    await trashedNote(storage, 'a');
    await trashedNote(storage, 'b');
    advance(29 * MS_PER_DAY);
    // A Proxy (not Object.create) so the adapter's private fields stay reachable.
    const flaky = new Proxy<IStorageEngine>(storage, {
      get: (target, prop: keyof IStorageEngine) =>
        prop === 'purgeNote'
          ? (id: NoteId) =>
              id === 'a' ? Promise.reject(new StorageError('ERR_STORAGE', 'disk full')) : target.purgeNote(id)
          : target[prop].bind(target),
    });
    const errors: unknown[] = [];
    expect(await purgeExpired({ storage: flaky, now, onError: (e: unknown) => errors.push(e) })).toEqual([noteEntity('b')]);
    expect(errors).toHaveLength(1);
  });
});

describe('purgeExpired for folders (Task 10b)', () => {
  async function trashedTree(storage: IStorageEngine): Promise<void> {
    await storage.createFolder({ id: 'a' as FolderId, parentId: null, categoryId: null, nameCiphertext: 'YQ==' as Ciphertext });
    await storage.createFolder({ id: 'b' as FolderId, parentId: 'a' as FolderId, categoryId: null, nameCiphertext: 'Yg==' as Ciphertext });
    await storage.createNote('nb' as NoteId);
    await storage.moveNote('nb' as NoteId, 'b' as FolderId, null);
    await storage.trashFolder('a' as FolderId);
  }

  it('purges an expired folder tree once and reports every entity', async () => {
    const { storage, now, advance } = world();
    await trashedTree(storage);
    advance(29 * MS_PER_DAY);
    const purged = await purgeExpired({ storage, now });
    expect(purged).toEqual([
      { entityType: 'folder', id: 'a' },
      { entityType: 'folder', id: 'b' },
      { entityType: 'note', id: 'nb' },
    ]);
    expect(await storage.listTrashedFolders()).toEqual([]);
    expect(await storage.getNote('nb' as NoteId)).toBeNull();
  });

  it('keeps folders inside the retention window', async () => {
    const { storage, now, advance } = world();
    await trashedTree(storage);
    advance(27 * MS_PER_DAY);
    expect(await purgeExpired({ storage, now })).toEqual([]);
    expect(await storage.listTrashedFolders()).toHaveLength(2);
  });

  it('counts trashed folders when shortening retention needs confirmation', async () => {
    const { storage, now, advance } = world();
    await trashedTree(storage);
    advance(10 * MS_PER_DAY);
    expect(await changeTrashRetention({ storage, now }, 7, { confirmed: false })).toEqual({
      kind: 'confirm_required',
      affected: 3,
    });
  });
});

describe('changeTrashRetention (SPEC §6)', () => {
  it('asks for confirmation before shortening retention purges anything', async () => {
    const { storage, now, advance } = world();
    await trashedNote(storage, 'ten-days-old');
    advance(10 * MS_PER_DAY);

    const first = await changeTrashRetention({ storage, now }, 7, { confirmed: false });
    expect(first).toEqual({ kind: 'confirm_required', affected: 1 });
    expect(await storage.getTrashRetentionDays()).toBe(28);
    expect(await storage.getNote('ten-days-old' as NoteId)).not.toBeNull();

    const second = await changeTrashRetention({ storage, now }, 7, { confirmed: true });
    expect(second).toEqual({ kind: 'applied', purged: [noteEntity('ten-days-old')] });
    expect(await storage.getTrashRetentionDays()).toBe(7);
  });

  it('applies changes that purge nothing without confirmation', async () => {
    const { storage, now } = world();
    expect(await changeTrashRetention({ storage, now }, 90, { confirmed: false })).toEqual({ kind: 'applied', purged: [] });
    expect(await storage.getTrashRetentionDays()).toBe(90);
  });

  it('rejects invalid values', async () => {
    const { storage, now } = world();
    await expect(changeTrashRetention({ storage, now }, 400, { confirmed: true })).rejects.toMatchObject({
      code: 'ERR_INVALID_SETTING',
    });
  });
});

describe('startRetentionWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at startup and every interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { storage, now, advance } = world();
    await trashedNote(storage, 'first');
    advance(29 * MS_PER_DAY);

    const purged: string[] = [];
    const worker = startRetentionWorker({ storage, now, intervalMs: 1_000, onPurged: async (e) => void purged.push(e.id) });
    await worker.runNow();
    expect(purged).toEqual(['first']);

    await trashedNote(storage, 'second');
    advance(29 * MS_PER_DAY);
    vi.advanceTimersByTime(1_000);
    await worker.runNow();
    expect(purged).toEqual(['first', 'second']);
    worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a run in progress: nothing is purged after stop() (the vault locked mid-run)', async () => {
    const { storage, now, advance } = world();
    await trashedNote(storage, 'a');
    await trashedNote(storage, 'b');
    advance(29 * MS_PER_DAY);
    const purged: string[] = [];
    let worker: ReturnType<typeof startRetentionWorker> | null = null;
    worker = startRetentionWorker({
      storage,
      now,
      // The first purge locks the vault: the run must not go on to the second note.
      onPurged: async (e) => {
        purged.push(e.id);
        worker?.stop();
      },
    });
    await worker.runNow();
    expect(purged).toHaveLength(1);
    expect(await storage.listTrashedNotes()).toHaveLength(1);
  });
});
