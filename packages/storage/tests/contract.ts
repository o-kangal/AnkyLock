import { beforeEach, describe, expect, it } from 'vitest';
import type { Bytes, CategoryId, Ciphertext, FolderId, NoteContent, NoteId, SealedBytes } from '@ankylock/core';
import type { IStorageEngine } from '../src/index.js';

const cat = (s: string): CategoryId => s as CategoryId;
const folder = (s: string): FolderId => s as FolderId;
const note = (s: string): NoteId => s as NoteId;
const name = (s: string): Ciphertext => s as Ciphertext;
const bytes = (...values: number[]): Bytes => new Uint8Array(values);
/** Opaque stand-in for encrypted bytes; storage never inspects them. */
const sealed = (...values: number[]): SealedBytes => bytes(...values) as SealedBytes;

function content(noteId: string, updatedAt: number): NoteContent {
  return {
    noteId: note(noteId),
    titleCiphertext: name('dGl0bGU='),
    contentCiphertext: sealed(1, 2, 3),
    yjsStateVector: bytes(0),
    yjsUpdates: sealed(4, 5),
    updatedAt: updatedAt as NoteContent['updatedAt'],
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/** Behaviour every IStorageEngine must share; mirrors the desktop host's Rust tests. */
export function storageContract(label: string, makeEngine: () => IStorageEngine): void {
  describe(`IStorageEngine contract: ${label}`, () => {
    let engine: IStorageEngine;

    beforeEach(() => {
      engine = makeEngine();
    });

    async function threeLevels(): Promise<void> {
      await engine.createFolder({ id: folder('l1'), parentId: null, categoryId: null, nameCiphertext: name('MQ==') });
      await engine.createFolder({ id: folder('l2'), parentId: folder('l1'), categoryId: null, nameCiphertext: name('Mg==') });
      await engine.createFolder({ id: folder('l3'), parentId: folder('l2'), categoryId: null, nameCiphertext: name('Mw==') });
    }

    describe('categories', () => {
      it('creates categories in sort order and renames them', async () => {
        const work = await engine.createCategory(cat('work'), name('d29yaw=='));
        const home = await engine.createCategory(cat('home'), name('aG9tZQ=='));
        expect([work.sortOrder, home.sortOrder]).toEqual([0, 1]);
        expect(work.isSystem).toBe(false);
        const renamed = await engine.renameCategory(cat('work'), name('bmV3'));
        expect(renamed.nameCiphertext).toBe('bmV3');
        expect((await engine.listCategories()).map((c) => c.id)).toEqual(['work', 'home']);
      });

      it('deleting a category detaches its folders and notes', async () => {
        await engine.createCategory(cat('work'), name('d29yaw=='));
        await engine.createFolder({ id: folder('f'), parentId: null, categoryId: cat('work'), nameCiphertext: name('Zg==') });
        await engine.createNote(note('n'));
        await engine.moveNote(note('n'), null, cat('work'));
        await engine.deleteCategory(cat('work'));
        expect(await engine.listCategories()).toEqual([]);
        expect((await engine.listFolders())[0]?.categoryId).toBeNull();
        expect((await engine.getNote(note('n')))?.categoryId).toBeNull();
      });

      it('rejects system categories and missing ones', async () => {
        for (const id of ['system_all', 'system_archive', 'system_trash'].map(cat)) {
          await expectCode(engine.createCategory(id, name('eA==')), 'ERR_SYSTEM_CATEGORY_IMMUTABLE');
          await expectCode(engine.renameCategory(id, name('eA==')), 'ERR_SYSTEM_CATEGORY_IMMUTABLE');
          await expectCode(engine.deleteCategory(id), 'ERR_SYSTEM_CATEGORY_IMMUTABLE');
        }
        await expectCode(engine.renameCategory(cat('ghost'), name('eA==')), 'ERR_NOT_FOUND');
      });
    });

    describe('folders', () => {
      it('creates nested folders that inherit the parent category', async () => {
        await engine.createCategory(cat('work'), name('d29yaw=='));
        await engine.createFolder({ id: folder('root'), parentId: null, categoryId: cat('work'), nameCiphertext: name('cg==') });
        const child = await engine.createFolder({
          id: folder('child'),
          parentId: folder('root'),
          categoryId: null,
          nameCiphertext: name('Yw=='),
        });
        expect(child.categoryId).toBe('work');
        expect((await engine.listFolders()).map((f) => f.id)).toEqual(['root', 'child']);
      });

      it('rejects a fourth level', async () => {
        await threeLevels();
        await expectCode(
          engine.createFolder({ id: folder('l4'), parentId: folder('l3'), categoryId: null, nameCiphertext: name('NA==') }),
          'ERR_MAX_DEPTH_EXCEEDED',
        );
      });

      it('rejects circular moves and leaves the folder in place (SPEC §6)', async () => {
        await threeLevels();
        await expectCode(engine.moveFolder(folder('l1'), folder('l2')), 'ERR_CIRCULAR_HIERARCHY');
        await expectCode(engine.moveFolder(folder('l1'), folder('l3')), 'ERR_CIRCULAR_HIERARCHY');
        await expectCode(engine.moveFolder(folder('l1'), folder('l1')), 'ERR_CIRCULAR_HIERARCHY');
        expect((await engine.listFolders()).find((f) => f.id === 'l1')?.parentId).toBeNull();
      });

      it('counts the moved subtree against the depth limit', async () => {
        await threeLevels();
        await engine.createFolder({ id: folder('a'), parentId: null, categoryId: null, nameCiphertext: name('YQ==') });
        await engine.createFolder({ id: folder('a2'), parentId: folder('a'), categoryId: null, nameCiphertext: name('Yg==') });
        await expectCode(engine.moveFolder(folder('a'), folder('l2')), 'ERR_MAX_DEPTH_EXCEEDED');
        const moved = await engine.moveFolder(folder('a2'), folder('l2'));
        expect(moved.parentId).toBe('l2');
      });

      it('renames folders and rejects unknown targets', async () => {
        await engine.createFolder({ id: folder('f'), parentId: null, categoryId: null, nameCiphertext: name('Zg==') });
        expect((await engine.renameFolder(folder('f'), name('bmV3'))).nameCiphertext).toBe('bmV3');
        await expectCode(engine.moveFolder(folder('ghost'), null), 'ERR_NOT_FOUND');
        await expectCode(
          engine.createFolder({ id: folder('x'), parentId: folder('ghost'), categoryId: null, nameCiphertext: name('eA==') }),
          'ERR_NOT_FOUND',
        );
        await expectCode(
          engine.createFolder({ id: folder('y'), parentId: null, categoryId: cat('ghost'), nameCiphertext: name('eQ==') }),
          'ERR_NOT_FOUND',
        );
        await expectCode(
          engine.createFolder({ id: folder('z'), parentId: null, categoryId: cat('system_all'), nameCiphertext: name('eg==') }),
          'ERR_SYSTEM_CATEGORY_IMMUTABLE',
        );
      });
    });

    describe('notes', () => {
      it('creates scratchpads and stores encrypted content', async () => {
        const created = await engine.createNote(note('n'));
        expect(created.isEphemeral).toBe(true);
        await engine.saveNoteContent(content('n', created.createdAt + 5));
        expect(await engine.getNoteContent(note('n'))).toEqual(content('n', created.createdAt + 5));
        expect((await engine.getNote(note('n')))?.updatedAt).toBe(created.createdAt + 5);
        expect(await engine.getNote(note('ghost'))).toBeNull();
        expect(await engine.getNoteContent(note('ghost'))).toBeNull();
      });

      it('rejects duplicate ids', async () => {
        await engine.createNote(note('n'));
        await expectCode(engine.createNote(note('n')), 'ERR_STORAGE');
      });

      it('moving organizes a note and lists it under its folder', async () => {
        await engine.createFolder({ id: folder('f'), parentId: null, categoryId: null, nameCiphertext: name('Zg==') });
        await engine.createNote(note('n'));
        const moved = await engine.moveNote(note('n'), folder('f'), null);
        expect(moved.isEphemeral).toBe(false);
        expect((await engine.listNotes(folder('f'))).map((n) => n.id)).toEqual(['n']);
        expect(await engine.listNotes(null)).toEqual([]);
      });

      it('move rejects system categories and missing targets without writing', async () => {
        await engine.createNote(note('n'));
        await expectCode(engine.moveNote(note('n'), null, cat('system_all')), 'ERR_SYSTEM_CATEGORY_IMMUTABLE');
        await expectCode(engine.moveNote(note('n'), folder('ghost'), null), 'ERR_NOT_FOUND');
        await expectCode(engine.moveNote(note('n'), null, cat('ghost')), 'ERR_NOT_FOUND');
        await expectCode(engine.moveNote(note('ghost'), null, null), 'ERR_NOT_FOUND');
        expect((await engine.getNote(note('n')))?.isEphemeral).toBe(true);
      });

      it('archives only organized notes', async () => {
        await engine.createNote(note('n'));
        await expectCode(engine.setNoteArchived(note('n'), true), 'ERR_INVALID_TRANSITION');
        await engine.moveNote(note('n'), null, null);
        expect((await engine.setNoteArchived(note('n'), true)).isArchived).toBe(true);
        await expectCode(engine.setNoteArchived(note('n'), true), 'ERR_INVALID_TRANSITION');
        expect((await engine.setNoteArchived(note('n'), false)).isArchived).toBe(false);
      });

      it('trashed notes are read-only', async () => {
        await engine.createNote(note('n'));
        const trashed = await engine.trashNote(note('n'));
        expect(trashed.deletedAt).not.toBeNull();
        await expectCode(engine.saveNoteContent(content('n', 1)), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.moveNote(note('n'), null, null), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.setNoteArchived(note('n'), true), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.trashNote(note('n')), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.discardEphemeralNote(note('n')), 'ERR_READ_ONLY_TRASHED_ENTITY');
        expect(await engine.listNotes(null)).toEqual([]);
        expect((await engine.listTrashedNotes()).map((n) => n.id)).toEqual(['n']);
      });

      it('restore keeps pointers to surviving parents and drops purged ones', async () => {
        await engine.createCategory(cat('work'), name('d29yaw=='));
        await engine.createFolder({ id: folder('f'), parentId: null, categoryId: null, nameCiphertext: name('Zg==') });
        await engine.createNote(note('n'));
        await engine.moveNote(note('n'), folder('f'), cat('work'));
        await engine.trashNote(note('n'));
        await engine.deleteCategory(cat('work'));
        const restored = await engine.restoreNote(note('n'));
        expect(restored).toMatchObject({ deletedAt: null, folderId: 'f', categoryId: null, isEphemeral: false });
        await expectCode(engine.restoreNote(note('n')), 'ERR_INVALID_TRANSITION');
      });

      it('purge removes the note and its content', async () => {
        await engine.createNote(note('n'));
        await engine.saveNoteContent(content('n', 1));
        await expectCode(engine.purgeNote(note('n')), 'ERR_INVALID_TRANSITION');
        await engine.trashNote(note('n'));
        await engine.purgeNote(note('n'));
        expect(await engine.getNote(note('n'))).toBeNull();
        expect(await engine.getNoteContent(note('n'))).toBeNull();
        await expectCode(engine.purgeNote(note('n')), 'ERR_NOT_FOUND');
      });

      it('discard deletes only scratchpads', async () => {
        await engine.createNote(note('scratch'));
        await engine.discardEphemeralNote(note('scratch'));
        expect(await engine.getNote(note('scratch'))).toBeNull();
        await engine.createNote(note('kept'));
        await engine.moveNote(note('kept'), null, null);
        await expectCode(engine.discardEphemeralNote(note('kept')), 'ERR_INVALID_TRANSITION');
      });
    });

    describe('settings', () => {
      it('defaults trash retention to 28 days and stores valid values (BR-LIFE-03)', async () => {
        expect(await engine.getTrashRetentionDays()).toBe(28);
        expect(await engine.setTrashRetentionDays(7)).toBe(7);
        expect(await engine.getTrashRetentionDays()).toBe(7);
        expect(await engine.setTrashRetentionDays(0)).toBe(0);
        expect(await engine.getTrashRetentionDays()).toBe(0);
      });

      it('rejects invalid retention values', async () => {
        for (const days of [-1, 1.5, 366]) await expectCode(engine.setTrashRetentionDays(days), 'ERR_INVALID_SETTING');
        expect(await engine.getTrashRetentionDays()).toBe(28);
      });
    });

    describe('sync outbox', () => {
      it('drains in insertion order and keeps payload bytes intact', async () => {
        const first = await engine.enqueueOutbox({ entityId: note('n1'), entityType: 'note', encryptedPayload: sealed(0xde, 0xad) });
        await engine.enqueueOutbox({ entityId: folder('f1'), entityType: 'folder', encryptedPayload: sealed(1) });
        await engine.enqueueOutbox({ entityId: note('n2'), entityType: 'tombstone', encryptedPayload: sealed(2) });
        const head = await engine.listOutbox(2);
        expect(head.map((e) => e.entityId)).toEqual(['n1', 'f1']);
        expect(head[0]?.encryptedPayload).toEqual(bytes(0xde, 0xad));
        await engine.deleteOutbox([first.id]);
        expect((await engine.listOutbox(10)).map((e) => e.entityId)).toEqual(['f1', 'n2']);
      });
    });
  });
}
