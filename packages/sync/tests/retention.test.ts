import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_DAY, type EpochMs, type NoteId } from '@ankylock/core';
import { createKeySealer } from '@ankylock/crypto';
import { StorageError, WebIndexedDbAdapter, type IStorageEngine } from '@ankylock/storage';
import {
  OutboxQueue,
  changeTrashRetention,
  createTombstonePacket,
  purgeExpiredNotes,
  startRetentionWorker,
  type DeviceId,
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

async function trashedNote(storage: IStorageEngine, id: string): Promise<NoteId> {
  await storage.createNote(id as NoteId);
  await storage.trashNote(id as NoteId);
  return id as NoteId;
}

describe('purgeExpiredNotes (BR-LIFE-04)', () => {
  it('purges only after the retention window, to the millisecond', async () => {
    const { storage, now, advance } = world();
    await trashedNote(storage, 'old');
    advance(28 * MS_PER_DAY);
    expect(await purgeExpiredNotes({ storage, now })).toEqual([]);
    advance(1);
    expect(await purgeExpiredNotes({ storage, now })).toEqual(['old']);
    expect(await storage.getNote('old' as NoteId)).toBeNull();
  });

  it('never auto-purges with retention 0 (manual purge only)', async () => {
    const { storage, now, advance } = world();
    await storage.setTrashRetentionDays(0);
    await trashedNote(storage, 'kept');
    advance(10_000 * MS_PER_DAY);
    expect(await purgeExpiredNotes({ storage, now })).toEqual([]);
    expect(await storage.getNote('kept' as NoteId)).not.toBeNull();
  });

  it('leaves live notes alone', async () => {
    const { storage, now, advance } = world();
    await storage.createNote('live' as NoteId);
    advance(400 * MS_PER_DAY);
    expect(await purgeExpiredNotes({ storage, now })).toEqual([]);
  });

  it('queues an encrypted TOMBSTONE packet for each purge', async () => {
    const { storage, now, advance } = world();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const sealer = createKeySealer(() => key);
    const deviceId = 'desktop-a' as DeviceId;
    const queue = new OutboxQueue(storage, { send: () => false }, deviceId);
    await trashedNote(storage, 'gone');
    advance(29 * MS_PER_DAY);

    await purgeExpiredNotes({
      storage,
      now,
      onPurged: async (id) => queue.submit(await createTombstonePacket(sealer, deviceId, id, 'note', now())),
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
    expect(await purgeExpiredNotes({ storage: flaky, now, onError: (e) => errors.push(e) })).toEqual(['b']);
    expect(errors).toHaveLength(1);
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
    expect(second).toEqual({ kind: 'applied', purged: ['ten-days-old'] });
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

    const purged: NoteId[] = [];
    const worker = startRetentionWorker({ storage, now, intervalMs: 1_000, onPurged: async (id) => void purged.push(id) });
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
});
