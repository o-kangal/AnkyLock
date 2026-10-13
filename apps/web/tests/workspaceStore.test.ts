import { describe, expect, it } from 'vitest';
import type { FolderId, NoteId } from '@ankylock/core';
import { createWorkspaceStore, nextUntitledNumber, tabLabel } from '../src/index.js';
import { contentWithTitle, expectOk, fakeCodec, setup } from './helpers.js';

const labels = (store: ReturnType<typeof setup>['store']): string[] =>
  store.state.tabs.map((t) => tabLabel(t, store.state.notes[t.noteId]));

describe('tabs', () => {
  it('creates persisted scratchpads as Untitled-N and activates them (BR-NOTE-01)', async () => {
    const { store, storage } = setup();
    expectOk(await store.createTab());
    expectOk(await store.createTab());
    expect(labels(store)).toEqual(['Untitled-1', 'Untitled-2']);
    expect(store.state.activeTabIndex).toBe(1);
    expect((await storage.getNote('id-1' as NoteId))?.isEphemeral).toBe(true);
  });

  it('reuses the lowest free Untitled number', () => {
    expect(nextUntitledNumber([{ noteId: 'a' as NoteId, untitledNumber: 1 }, { noteId: 'b' as NoteId, untitledNumber: 3 }])).toBe(2);
  });

  it('shows the derived title once known', async () => {
    const { store } = setup();
    await store.createTab();
    store.setTitle('id-1' as NoteId, 'const secret = 42;');
    expect(labels(store)).toEqual(['const secret = 42;']);
  });

  it('discards an empty, unmodified scratchpad on close without trashing it', async () => {
    const { store, storage } = setup();
    await store.createTab();
    expectOk(await store.closeTab(0, true));
    expect(store.state.tabs).toEqual([]);
    expect(store.state.activeTabIndex).toBe(-1);
    expect(await storage.getNote('id-1' as NoteId)).toBeNull();
    expect(await storage.listTrashedNotes()).toEqual([]);
  });

  it('keeps a modified scratchpad when its tab closes', async () => {
    const { store, storage } = setup();
    await store.createTab();
    await store.closeTab(0, false);
    expect(await storage.getNote('id-1' as NoteId)).not.toBeNull();
  });

  it('keeps a sensible active tab when closing others', async () => {
    const { store } = setup();
    for (let i = 0; i < 4; i++) await store.createTab();
    store.activateTab(2);
    await store.closeTab(0);
    expect(store.state.tabs[store.state.activeTabIndex]?.noteId).toBe('id-3');
    await store.closeTab(store.state.activeTabIndex);
    expect(store.state.tabs[store.state.activeTabIndex]?.noteId).toBe('id-4');
    await store.closeTab(store.state.activeTabIndex);
    expect(store.state.tabs[store.state.activeTabIndex]?.noteId).toBe('id-2');
  });

  it('reorders tabs and keeps the same tab active', async () => {
    const { store } = setup();
    for (let i = 0; i < 3; i++) await store.createTab();
    store.activateTab(0);
    store.moveTab(0, 2);
    expect(store.state.tabs.map((t) => t.noteId)).toEqual(['id-2', 'id-3', 'id-1']);
    expect(store.state.activeTabIndex).toBe(2);
  });

  it('focuses an already open note instead of opening a second tab', async () => {
    const { store } = setup();
    await store.createTab();
    await store.createTab();
    store.openNote('id-1' as NoteId);
    expect(store.state.tabs).toHaveLength(2);
    expect(store.state.activeTabIndex).toBe(0);
  });
});

describe('hierarchy actions', () => {
  it('validates category names before encrypting (BR-HIER-02)', async () => {
    const { store, storage } = setup();
    expectOk(await store.createCategory('  Work '));
    expect(store.state.categories.map((c) => c.name)).toEqual(['Work']);
    expect((await storage.listCategories())[0]?.nameCiphertext).toBe('enc:Work');

    expect(await store.createCategory('work')).toMatchObject({ ok: false, error: { code: 'ERR_CATEGORY_NAME_DUPLICATE' } });
    expect(await store.createCategory('  ')).toMatchObject({ ok: false, error: { code: 'ERR_CATEGORY_NAME_INVALID' } });
  });

  it('rejects circular folder moves and leaves the tree unchanged (SPEC §6)', async () => {
    const { store, storage } = setup();
    await store.createFolder('Alpha', null, null);
    await store.createFolder('Beta', 'id-1' as FolderId, null);
    const result = await store.moveFolder('id-1' as FolderId, 'id-2' as FolderId);
    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_CIRCULAR_HIERARCHY' } });
    expect(store.state.folders.find((f) => f.id === 'id-1')?.parentId).toBeNull();
    expect((await storage.listFolders()).find((f) => f.id === 'id-1')?.parentId).toBeNull();
  });

  it('surfaces storage errors as results', async () => {
    const { store } = setup();
    await store.createFolder('L1', null, null);
    await store.createFolder('L2', 'id-1' as FolderId, null);
    await store.createFolder('L3', 'id-2' as FolderId, null);
    expect(await store.createFolder('L4', 'id-3' as FolderId, null)).toMatchObject({
      ok: false,
      error: { code: 'ERR_MAX_DEPTH_EXCEEDED' },
    });
    expect(store.state.folders).toHaveLength(3);
  });

  it('moves, trashes and restores notes', async () => {
    const { store } = setup();
    await store.createFolder('Inbox', null, null);
    await store.createTab();
    expectOk(await store.moveNote('id-2' as NoteId, 'id-1' as FolderId, null));
    expect(store.state.notes['id-2' as NoteId]).toMatchObject({ folderId: 'id-1', isEphemeral: false });
    expectOk(await store.trashNote('id-2' as NoteId));
    expect(store.state.notes['id-2' as NoteId]?.deletedAt).not.toBeNull();
    expectOk(await store.restoreNote('id-2' as NoteId));
    expect(store.state.notes['id-2' as NoteId]?.deletedAt).toBeNull();
  });
});

describe('folder archive and trash (Task 10b)', () => {
  it('archives, trashes and restores folder subtrees and reloads state', async () => {
    const { store } = setup();
    await store.createFolder('Projects', null, null);
    await store.createFolder('Old', 'id-1' as FolderId, null);
    await store.createTab();
    await store.moveNote('id-3' as NoteId, 'id-2' as FolderId, null);

    expectOk(await store.archiveFolder('id-1' as FolderId));
    expect(store.state.folders.every((f) => f.isArchived)).toBe(true);
    expect(store.state.notes['id-3' as NoteId]?.isArchived).toBe(true);
    expectOk(await store.unarchiveFolder('id-1' as FolderId));

    expectOk(await store.trashFolder('id-1' as FolderId));
    expect(store.state.folders.every((f) => f.deletedAt !== null)).toBe(true);
    expect(store.state.notes['id-3' as NoteId]?.deletedAt).not.toBeNull();
    expect(await store.trashFolder('id-1' as FolderId)).toMatchObject({
      ok: false,
      error: { code: 'ERR_READ_ONLY_TRASHED_ENTITY' },
    });

    expectOk(await store.restoreFolder('id-1' as FolderId));
    expect(store.state.folders.every((f) => f.deletedAt === null)).toBe(true);
    expect(store.state.notes['id-3' as NoteId]?.deletedAt).toBeNull();
  });
});

describe('loading', () => {
  it('rebuilds state from storage and decrypts names and titles lazily', async () => {
    const { store, storage } = setup();
    await store.createCategory('Work');
    await store.createFolder('Inbox', null, null);
    await store.createTab();
    await store.moveNote('id-3' as NoteId, 'id-2' as FolderId, null);
    await storage.saveNoteContent(contentWithTitle('id-3' as NoteId, 'Shopping list'));

    const fresh = createWorkspaceStore({ storage, names: fakeCodec });
    expectOk(await fresh.load());
    expect(fresh.state.categories.map((c) => c.name)).toEqual(['Work']);
    expect(fresh.state.folders.map((f) => f.name)).toEqual(['Inbox']);
    expect(fresh.state.notes['id-3' as NoteId]?.title).toBeUndefined();
    expectOk(await fresh.loadTitle('id-3' as NoteId));
    expect(fresh.state.notes['id-3' as NoteId]?.title).toBe('Shopping list');
  });
});
