import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { EpochMs, FolderId, NoteContent, NoteId, SealedBytes } from '@ankylock/core';
import { TauriSqliteAdapter, WebIndexedDbAdapter, type Invoke } from '../src/index.js';
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
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
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
      encryptedPayload: '3q2+7w==',
      createdAt: 1,
    });
    const entry = await new TauriSqliteAdapter(invoke).enqueueOutbox({
      entityId: 'n' as NoteId,
      entityType: 'note',
      encryptedPayload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) as SealedBytes,
    });
    expect(calls[0]).toEqual(['outbox_enqueue', { entry: { entityId: 'n', entityType: 'note', encryptedPayload: '3q2+7w==' } }]);
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

  it('accepts null for missing notes and unit results', async () => {
    const { invoke } = fakeInvoke(null);
    const adapter = new TauriSqliteAdapter(invoke);
    expect(await adapter.getNote('n' as NoteId)).toBeNull();
    expect(await adapter.getNoteContent('n' as NoteId)).toBeNull();
    await expect(adapter.purgeNote('n' as NoteId)).resolves.toBeUndefined();
  });
});
