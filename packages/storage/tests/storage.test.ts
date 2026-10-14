import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Ciphertext, EpochMs, FolderId, NoteContent, NoteId, SealedBytes, VaultId } from '@ankylock/core';
import { TauriSqliteAdapter, TauriVaultDirectory, WebIndexedDbAdapter, WebVaultDirectory, type Invoke } from '../src/index.js';
import { storageContract } from './contract.js';

/** Strictly increasing clock so ordering by timestamp is deterministic. */
function counterClock(start = 1_776_100_000_000): () => EpochMs {
  let t = start;
  return () => t++ as EpochMs;
}

storageContract('WebIndexedDbAdapter', () => new WebIndexedDbAdapter(new IDBFactory(), counterClock()));

describe('WebIndexedDbAdapter', () => {
  it('persists across adapter instances on the same database', async () => {
    const factory = new IDBFactory();
    const first = new WebIndexedDbAdapter(factory, counterClock());
    await first.createNote('n' as NoteId);
    await first.close();
    const second = new WebIndexedDbAdapter(factory, counterClock());
    expect((await second.getNote('n' as NoteId))?.isEphemeral).toBe(true);
  });

  it('upgrades a version 1 database without losing data', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('ankylock', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('notes', { keyPath: 'id' }).put({
          id: 'old',
          folderId: null,
          categoryId: null,
          isEphemeral: true,
          isArchived: false,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 1,
        });
        for (const name of ['categories', 'folders']) db.createObjectStore(name, { keyPath: 'id' });
        db.createObjectStore('note_contents', { keyPath: 'noteId' });
        db.createObjectStore('sync_outbox', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('sync_tombstones', { keyPath: 'entityId' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const engine = new WebIndexedDbAdapter(factory, counterClock());
    expect((await engine.getNote('old' as NoteId))?.isEphemeral).toBe(true);
    expect(await engine.getTrashRetentionDays()).toBe(28);
    expect(await engine.setTrashRetentionDays(14)).toBe(14);
  });

  it('backfills archivedAt when upgrading from version 2', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('ankylock', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['categories', 'folders', 'notes']) db.createObjectStore(name, { keyPath: 'id' });
        db.createObjectStore('note_contents', { keyPath: 'noteId' });
        db.createObjectStore('sync_outbox', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('sync_tombstones', { keyPath: 'entityId' });
        db.createObjectStore('app_settings', { keyPath: 'key' });
        req.transaction?.objectStore('folders').put({
          id: 'old',
          categoryId: null,
          parentId: null,
          nameCiphertext: 'x',
          isArchived: true,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 42,
        });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const engine = new WebIndexedDbAdapter(factory, counterClock());
    await engine.createFolder({ id: 'child' as FolderId, parentId: null, categoryId: null, nameCiphertext: 'eQ==' as Ciphertext });
    const restored = await engine.unarchiveFolder('old' as FolderId);
    expect(restored).toMatchObject({ isArchived: false, archivedAt: null });
  });

  it('adds sync clocks when upgrading from version 3', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('ankylock', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['categories', 'folders', 'notes']) db.createObjectStore(name, { keyPath: 'id' });
        db.createObjectStore('note_contents', { keyPath: 'noteId' });
        const outbox = db.createObjectStore('sync_outbox', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('sync_tombstones', { keyPath: 'entityId' });
        db.createObjectStore('app_settings', { keyPath: 'key' });
        req.transaction?.objectStore('notes').put({
          id: 'old',
          folderId: null,
          categoryId: null,
          isEphemeral: true,
          isArchived: false,
          archivedAt: null,
          deletedAt: null,
          createdAt: 1,
          updatedAt: 40,
        });
        outbox.put({ entityId: 'old', entityType: 'tombstone', encryptedPayload: new Uint8Array([1]), createdAt: 1 });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const engine = new WebIndexedDbAdapter(factory, counterClock());
    expect((await engine.getNote('old' as NoteId))?.metaUpdatedAt).toBe(40);
    expect((await engine.listOutbox(10)).map((e) => e.packetType)).toEqual(['TOMBSTONE']);
  });

  it('lists notes most recently updated first', async () => {
    const engine = new WebIndexedDbAdapter(new IDBFactory(), counterClock());
    await engine.createNote('a' as NoteId);
    await engine.createNote('b' as NoteId);
    await engine.moveNote('a' as NoteId, null, null);
    expect((await engine.listNotes(null)).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('TauriSqliteAdapter', () => {
  function fakeInvoke(response: unknown): { invoke: Invoke; calls: [string, Record<string, unknown> | undefined][] } {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    return {
      calls,
      invoke: (command, args) => {
        calls.push([command, args]);
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
    };
  }

  const wireNote = {
    id: 'n',
    folderId: 'f',
    categoryId: null,
    isEphemeral: false,
    isArchived: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
    metaUpdatedAt: 2,
  };

  it('sends camelCase arguments to snake_case commands', async () => {
    const { invoke, calls } = fakeInvoke(wireNote);
    const note = await new TauriSqliteAdapter(invoke).moveNote('n' as NoteId, 'f' as FolderId, null);
    expect(calls).toEqual([['note_move', { id: 'n', folderId: 'f', categoryId: null }]]);
    expect(note).toEqual(wireNote);
  });

  it('sends note content bytes as base64 and decodes them on read', async () => {
    const sent = fakeInvoke(null);
    const content = {
      noteId: 'n',
      titleCiphertext: 'dA==',
      contentCiphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      yjsStateVector: new Uint8Array([0]),
      yjsUpdates: new Uint8Array([]),
      updatedAt: 5,
    } as unknown as NoteContent;
    await new TauriSqliteAdapter(sent.invoke).saveNoteContent(content);
    expect(sent.calls[0]?.[1]).toEqual({
      content: {
        noteId: 'n',
        titleCiphertext: 'dA==',
        contentCiphertext: '3q2+7w==',
        yjsStateVector: 'AA==',
        yjsUpdates: '',
        updatedAt: 5,
      },
    });

    const read = fakeInvoke(sent.calls[0]?.[1]?.['content']);
    expect(await new TauriSqliteAdapter(read.invoke).getNoteContent('n' as NoteId)).toEqual(content);
  });

  it('round-trips outbox payloads through base64', async () => {
    const { invoke, calls } = fakeInvoke({
      id: 7,
      entityId: 'n',
      entityType: 'note',
      packetType: 'CRDT_DELTA',
      encryptedPayload: '3q2+7w==',
      createdAt: 1,
    });
    const entry = await new TauriSqliteAdapter(invoke).enqueueOutbox({
      entityId: 'n' as NoteId,
      entityType: 'note',
      packetType: 'CRDT_DELTA',
      encryptedPayload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) as SealedBytes,
    });
    expect(calls[0]).toEqual([
      'outbox_enqueue',
      { entry: { entityId: 'n', entityType: 'note', packetType: 'CRDT_DELTA', encryptedPayload: '3q2+7w==' } },
    ]);
    expect(entry.encryptedPayload).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('maps host errors to StorageError codes', async () => {
    const rejecting: Invoke = () =>
      Promise.reject({ code: 'ERR_READ_ONLY_TRASHED_ENTITY', message: 'Notes in Trash are read-only. Restore the note to edit.' });
    await expect(new TauriSqliteAdapter(rejecting).trashNote('n' as NoteId)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'ERR_READ_ONLY_TRASHED_ENTITY',
      message: 'Notes in Trash are read-only. Restore the note to edit.',
    });
  });

  it('maps unknown failures and malformed responses to ERR_STORAGE', async () => {
    const stringError: Invoke = () => Promise.reject('invalid args `content` for command `note_save_content`');
    await expect(new TauriSqliteAdapter(stringError).getNote('n' as NoteId)).rejects.toMatchObject({ code: 'ERR_STORAGE' });
    const unknownCode: Invoke = () => Promise.reject({ code: 'ERR_SOMETHING_NEW', message: 'x' });
    await expect(new TauriSqliteAdapter(unknownCode).getNote('n' as NoteId)).rejects.toMatchObject({ code: 'ERR_STORAGE' });
    const { invoke } = fakeInvoke({ id: 'n' });
    await expect(new TauriSqliteAdapter(invoke).createNote('n' as NoteId)).rejects.toMatchObject({ code: 'ERR_STORAGE' });
  });

  it('validates retention before calling the host', async () => {
    const { invoke, calls } = fakeInvoke(7);
    const adapter = new TauriSqliteAdapter(invoke);
    expect(await adapter.setTrashRetentionDays(7)).toBe(7);
    await expect(adapter.setTrashRetentionDays(-1)).rejects.toMatchObject({ code: 'ERR_INVALID_SETTING' });
    expect(calls).toEqual([['settings_set_retention_days', { days: 7 }]]);
  });

  it('accepts null for missing notes and unit results', async () => {
    const { invoke } = fakeInvoke(null);
    const adapter = new TauriSqliteAdapter(invoke);
    expect(await adapter.getNote('n' as NoteId)).toBeNull();
    expect(await adapter.getNoteContent('n' as NoteId)).toBeNull();
    await expect(adapter.purgeNote('n' as NoteId)).resolves.toBeUndefined();
  });
});

describe('TauriVaultDirectory', () => {
  const entry = { id: '0b6f5c2e-3d1a-4c8e-9f7b-2a1d4e5f6a7b', createdAt: 1, lastOpenedAt: 2 };

  it('creates and opens vaults through the host', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const invoke: Invoke = (command, args) => {
      calls.push([command, args]);
      return Promise.resolve(command === 'vault_list' ? [entry] : entry);
    };
    const vaults = new TauriVaultDirectory(invoke);
    expect(await vaults.list()).toEqual([entry]);
    const created = await vaults.create(entry.id as VaultId, '{"h":1}', 'bmFtZQ==' as Ciphertext);
    const opened = await vaults.open(entry.id as VaultId);
    expect(created).toBe(opened);
    expect(calls).toEqual([
      ['vault_list', {}],
      ['vault_create', { id: entry.id, header: '{"h":1}', nameCiphertext: 'bmFtZQ==', createdAt: null }],
      ['vault_open', { id: entry.id }],
    ]);
  });

  it('maps host errors', async () => {
    const invoke: Invoke = () => Promise.reject({ code: 'ERR_NOT_FOUND', message: 'Vault not found.' });
    await expect(new TauriVaultDirectory(invoke).open(entry.id as VaultId)).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  });
});

describe('WebVaultDirectory', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as VaultId;
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as VaultId;

  it('keeps every vault in its own database', async () => {
    const factory = new IDBFactory();
    const vaults = new WebVaultDirectory(factory, counterClock());
    expect(await vaults.list()).toEqual([]);
    const a = await vaults.create(A, '{"h":"a"}', 'YQ==' as Ciphertext);
    await a.createNote('only-in-a' as NoteId);
    const b = await vaults.create(B, '{"h":"b"}', 'Yg==' as Ciphertext);
    expect(await b.getNote('only-in-a' as NoteId)).toBeNull();
    expect(await b.getVaultName()).toBe('Yg==');

    const reopened = await vaults.open(A);
    expect(await reopened.getVaultHeader()).toBe('{"h":"a"}');
    expect((await reopened.getNote('only-in-a' as NoteId))?.id).toBe('only-in-a');
    expect((await new WebVaultDirectory(factory, counterClock(2_000_000_000_000)).list()).map((v) => v.id)).toEqual([A, B]);
  });

  it('writes the header once and rejects duplicate or unknown vaults', async () => {
    const vaults = new WebVaultDirectory(new IDBFactory(), counterClock());
    await vaults.create(A, '{}', 'YQ==' as Ciphertext);
    await expect(vaults.create(A, '{}', 'YQ==' as Ciphertext)).rejects.toMatchObject({ code: 'ERR_INVALID_SETTING' });
    await expect(vaults.open(B)).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
    const adapter = new WebIndexedDbAdapter(new IDBFactory(), counterClock());
    await adapter.initializeVault('{"v":1}', 'bg==' as Ciphertext);
    await expect(adapter.initializeVault('{}', 'bg==' as Ciphertext)).rejects.toMatchObject({ code: 'ERR_INVALID_SETTING' });
    expect(await adapter.getVaultHeader()).toBe('{"v":1}');
  });

  it('adopts the pre-vault-id database as the first vault', async () => {
    const factory = new IDBFactory();
    const legacy = new WebIndexedDbAdapter(factory, counterClock());
    await legacy.initializeVault('{"legacy":true}', 'bg==' as Ciphertext);
    await legacy.createNote('old' as NoteId);
    await legacy.close();

    const vaults = new WebVaultDirectory(factory, counterClock());
    const [adopted, ...rest] = await vaults.list();
    expect(rest).toEqual([]);
    const storage = await vaults.open(adopted!.id);
    expect(await storage.getVaultHeader()).toBe('{"legacy":true}');
    expect((await storage.getNote('old' as NoteId))?.id).toBe('old');
  });

  it('ignores a legacy database that never got a vault', async () => {
    const factory = new IDBFactory();
    await new WebIndexedDbAdapter(factory, counterClock()).close();
    expect(await new WebVaultDirectory(factory, counterClock()).list()).toEqual([]);
  });
});
