import { beforeEach, describe, expect, it } from 'vitest';
import type { Bytes, CategoryId, Ciphertext, EpochMs, FolderId, NoteContent, NoteId, SealedBytes } from '@ankylock/core';
import type { IStorageEngine, VaultImport } from '../src/index.js';

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

    describe('folder archive and trash lifecycle', () => {
      /** work ─ a ─ b, with note `na` in `a` and `nb` in `b`. */
      async function tree(): Promise<void> {
        await engine.createCategory(cat('work'), name('d29yaw=='));
        await engine.createFolder({ id: folder('a'), parentId: null, categoryId: cat('work'), nameCiphertext: name('YQ==') });
        await engine.createFolder({ id: folder('b'), parentId: folder('a'), categoryId: null, nameCiphertext: name('Yg==') });
        for (const [n, f] of [['na', 'a'], ['nb', 'b']] as const) {
          await engine.createNote(note(n));
          await engine.moveNote(note(n), folder(f), null);
        }
      }

      const live = async (): Promise<string[]> => (await engine.listFolders()).map((f) => f.id).sort();

      it('archives a folder subtree and unarchives it again (BR-LIFE-01)', async () => {
        await tree();
        expect((await engine.archiveFolder(folder('a'))).isArchived).toBe(true);
        expect((await engine.listFolders()).every((f) => f.isArchived)).toBe(true);
        expect((await engine.getNote(note('nb')))?.isArchived).toBe(true);
        await expectCode(engine.unarchiveFolder(folder('b')), 'ERR_INVALID_TRANSITION');
        await expectCode(engine.archiveFolder(folder('a')), 'ERR_INVALID_TRANSITION');

        await engine.unarchiveFolder(folder('a'));
        expect((await engine.listFolders()).some((f) => f.isArchived)).toBe(false);
        expect((await engine.getNote(note('na')))?.isArchived).toBe(false);
      });

      it('unarchiving a folder keeps items that were archived on their own', async () => {
        await tree();
        await engine.setNoteArchived(note('nb'), true);
        await engine.archiveFolder(folder('a'));
        await engine.unarchiveFolder(folder('a'));
        expect((await engine.getNote(note('na')))?.isArchived).toBe(false);
        expect((await engine.getNote(note('nb')))?.isArchived).toBe(true);
        expect((await engine.listFolders()).some((f) => f.isArchived)).toBe(false);
      });

      it('trashes a folder subtree with one timestamp and keeps it read-only (BR-LIFE-02)', async () => {
        await tree();
        const trashed = await engine.trashFolder(folder('a'));
        expect(await live()).toEqual([]);
        const inTrash = await engine.listTrashedFolders();
        expect(inTrash.map((f) => f.id).sort()).toEqual(['a', 'b']);
        expect(inTrash.every((f) => f.deletedAt === trashed.deletedAt)).toBe(true);
        expect((await engine.getNote(note('nb')))?.deletedAt).toBe(trashed.deletedAt);
        expect(inTrash.find((f) => f.id === 'b')?.parentId).toBe('a');
        await expectCode(engine.trashFolder(folder('a')), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.archiveFolder(folder('a')), 'ERR_READ_ONLY_TRASHED_ENTITY');
        await expectCode(engine.renameFolder(folder('b'), name('eA==')), 'ERR_READ_ONLY_TRASHED_ENTITY');
      });

      it('restores only what was trashed together', async () => {
        await tree();
        await engine.trashNote(note('nb'));
        await engine.trashFolder(folder('a'));
        await engine.restoreFolder(folder('a'));
        expect(await live()).toEqual(['a', 'b']);
        expect((await engine.getNote(note('na')))?.deletedAt).toBeNull();
        expect((await engine.getNote(note('nb')))?.deletedAt).not.toBeNull();
        await expectCode(engine.restoreFolder(folder('a')), 'ERR_INVALID_TRANSITION');
      });

      it('restores to the root when the parent is still trashed or the category is gone (BR-LIFE-05)', async () => {
        await tree();
        await engine.trashFolder(folder('a'));
        await engine.deleteCategory(cat('work'));
        const b = await engine.restoreFolder(folder('b'));
        expect(b).toMatchObject({ parentId: null, deletedAt: null, categoryId: null });
        const a = await engine.restoreFolder(folder('a'));
        expect(a).toMatchObject({ parentId: null, categoryId: null });
      });

      it('restores a note out of a trashed folder to the root', async () => {
        await tree();
        await engine.trashFolder(folder('a'));
        expect(await engine.restoreNote(note('na'))).toMatchObject({ folderId: null, deletedAt: null });
      });

      it('purges a trashed subtree with its notes and contents', async () => {
        await tree();
        await engine.saveNoteContent(content('nb', Date.now() + 10_000));
        await expectCode(engine.purgeFolder(folder('a')), 'ERR_INVALID_TRANSITION');
        await engine.trashFolder(folder('a'));
        const purged = await engine.purgeFolder(folder('a'));
        expect([...purged.folders].sort()).toEqual(['a', 'b']);
        expect([...purged.notes].sort()).toEqual(['na', 'nb']);
        expect(await engine.listTrashedFolders()).toEqual([]);
        expect(await engine.getNote(note('nb'))).toBeNull();
        expect(await engine.getNoteContent(note('nb'))).toBeNull();
        await expectCode(engine.purgeFolder(folder('a')), 'ERR_NOT_FOUND');
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

    describe('vault restore', () => {
      const at = (n: number) => n as EpochMs;

      it('keeps one device id', async () => {
        const id = await engine.getDeviceId();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await engine.getDeviceId()).toBe(id);
      });

      it('imports records as given into an empty vault only', async () => {
        const data: VaultImport = {
          retentionDays: 7,
          categories: [{ id: cat('c'), isSystem: false, sortOrder: 0, nameCiphertext: name('Yw=='), createdAt: at(1), updatedAt: at(1) }],
          folders: [
            { id: folder('child'), categoryId: null, parentId: folder('parent'), nameCiphertext: name('Yg=='), isArchived: false, archivedAt: null, deletedAt: null, createdAt: at(2), updatedAt: at(2) },
            { id: folder('parent'), categoryId: cat('c'), parentId: null, nameCiphertext: name('YQ=='), isArchived: false, archivedAt: null, deletedAt: null, createdAt: at(1), updatedAt: at(1) },
          ],
          notes: [
            { id: note('n'), folderId: folder('child'), categoryId: null, isEphemeral: false, isArchived: false, archivedAt: null, deletedAt: null, createdAt: at(3), updatedAt: at(3), metaUpdatedAt: at(3) },
            { id: note('t'), folderId: null, categoryId: null, isEphemeral: false, isArchived: false, archivedAt: null, deletedAt: at(9), createdAt: at(3), updatedAt: at(9), metaUpdatedAt: at(9) },
          ],
          contents: [content('n', 3), content('t', 9)],
        };
        await engine.importVault(data);
        expect((await engine.listFolders()).map((f) => f.id).sort()).toEqual(['child', 'parent']);
        expect((await engine.listNotes(folder('child'))).map((n) => n.id)).toEqual(['n']);
        expect((await engine.listTrashedNotes()).map((n) => n.deletedAt)).toEqual([9]);
        expect((await engine.getNoteContent(note('n')))?.yjsUpdates).toEqual(content('n', 3).yjsUpdates);
        expect(await engine.getTrashRetentionDays()).toBe(7);
        await expectCode(engine.importVault(data), 'ERR_INVALID_TRANSITION');
      });
    });

    describe('multi-device merge', () => {
      const at = (n: number) => n as EpochMs;
      const remoteFolder = (id: string, parentId: string | null, updatedAt: number, nameCt = 'Zg==') => ({
        id: folder(id),
        categoryId: null,
        parentId: parentId === null ? null : folder(parentId),
        nameCiphertext: name(nameCt),
        isArchived: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: at(1),
        updatedAt: at(updatedAt),
      });
      const remoteNote = (id: string, folderId: string | null, meta: number) => ({
        id: note(id),
        folderId: folderId === null ? null : folder(folderId),
        categoryId: null,
        isEphemeral: false,
        isArchived: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: at(1),
        updatedAt: at(meta),
        metaUpdatedAt: at(meta),
      });

      it('moves the metadata clock on moves and lifecycle changes, not on text edits', async () => {
        const created = await engine.createNote(note('n'));
        expect(created.metaUpdatedAt).toBe(created.updatedAt);
        await engine.saveNoteContent(content('n', Date.now() + 50_000));
        const edited = await engine.getNote(note('n'));
        expect(edited?.metaUpdatedAt).toBe(created.metaUpdatedAt);
        await engine.createFolder({ id: folder('f'), parentId: null, categoryId: null, nameCiphertext: name('Zg==') });
        const moved = await engine.moveNote(note('n'), folder('f'), null);
        expect(moved.metaUpdatedAt).toBeGreaterThan(created.metaUpdatedAt);
      });

      it('keeps the newer record and skips purged ids', async () => {
        await engine.mergeRecords({ folders: [remoteFolder('a', null, 10, 'b2xk')], notes: [remoteNote('n', 'a', 10)] });
        await engine.mergeRecords({
          folders: [remoteFolder('a', null, 20, 'bmV3'), remoteFolder('a', null, 15, 'c3RhbGU=')],
          notes: [remoteNote('n', null, 30), remoteNote('n', 'a', 25)],
        });
        expect((await engine.listFolders()).map((f) => f.nameCiphertext)).toEqual(['bmV3']);
        expect((await engine.getNote(note('n')))?.folderId).toBeNull();

        await engine.trashNote(note('n'));
        await engine.purgeNote(note('n'));
        await engine.mergeRecords({ notes: [remoteNote('n', null, 99)] });
        expect(await engine.getNote(note('n'))).toBeNull();
        expect((await engine.listTombstones()).map((t) => [t.entityId, t.entityType])).toEqual([['n', 'note']]);
      });

      it('clears references to rows that do not exist here, and detaches folders', async () => {
        await engine.mergeRecords({
          folders: [remoteFolder('child', 'missing', 5), remoteFolder('p', null, 1), remoteFolder('c', 'p', 7)],
          notes: [remoteNote('orphan', 'missing', 5)],
        });
        expect((await engine.getNote(note('orphan')))?.folderId).toBeNull();
        await engine.detachFolders([folder('c')]);
        const byId = new Map((await engine.listFolders()).map((f) => [f.id, f]));
        expect(byId.get(folder('child'))?.parentId).toBeNull();
        expect([byId.get(folder('c'))?.parentId, byId.get(folder('c'))?.updatedAt]).toEqual([null, 7]);
      });
    });

    describe('sync outbox', () => {
      it('drains in insertion order and keeps payload bytes intact', async () => {
        const first = await engine.enqueueOutbox({ entityId: note('n1'), entityType: 'note', packetType: 'CRDT_DELTA', encryptedPayload: sealed(0xde, 0xad) });
        await engine.enqueueOutbox({ entityId: folder('f1'), entityType: 'folder', packetType: 'HIERARCHY_MUTATION', encryptedPayload: sealed(1) });
        await engine.enqueueOutbox({ entityId: note('n2'), entityType: 'tombstone', packetType: 'TOMBSTONE', encryptedPayload: sealed(2) });
        const head = await engine.listOutbox(2);
        expect(head.map((e) => e.entityId)).toEqual(['n1', 'f1']);
        expect(head[0]?.encryptedPayload).toEqual(bytes(0xde, 0xad));
        expect(head.map((e) => e.packetType)).toEqual(['CRDT_DELTA', 'HIERARCHY_MUTATION']);
        await engine.deleteOutbox([first.id]);
        expect((await engine.listOutbox(10)).map((e) => e.entityId)).toEqual(['f1', 'n2']);
      });
    });
  });
}
