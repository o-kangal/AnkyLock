import { describe, expect, it } from 'vitest';
import type { CategoryId, FolderId, FolderLink, NoteId } from '@ankylock/core';
import { canDrop, createDragDropManager, decodeDragItem, encodeDragItem } from '../src/index.js';
import { expectOk, setup } from './helpers.js';

const f = (id: string): FolderId => id as FolderId;

function links(...pairs: [string, string | null][]): Map<FolderId, FolderLink> {
  return new Map(pairs.map(([id, parent]) => [f(id), { id: f(id), parentId: parent === null ? null : f(parent) }]));
}

describe('canDrop', () => {
  const tree = links(['alpha', null], ['beta', 'alpha'], ['l1', null], ['l2', 'l1'], ['l3', 'l2']);

  it('lets notes drop anywhere', () => {
    expect(canDrop({ kind: 'note', id: 'n' as NoteId }, { kind: 'folder', id: f('l3') }, tree).ok).toBe(true);
    expect(canDrop({ kind: 'note', id: 'n' as NoteId }, { kind: 'category', id: 'c' as CategoryId }, tree).ok).toBe(true);
  });

  it('rejects dropping a folder onto its own child (SPEC §6)', () => {
    expect(canDrop({ kind: 'folder', id: f('alpha') }, { kind: 'folder', id: f('beta') }, tree)).toMatchObject({
      ok: false,
      error: { code: 'ERR_CIRCULAR_HIERARCHY' },
    });
  });

  it('rejects nesting deeper than 3 levels', () => {
    expect(canDrop({ kind: 'folder', id: f('alpha') }, { kind: 'folder', id: f('l2') }, tree)).toMatchObject({
      ok: false,
      error: { code: 'ERR_MAX_DEPTH_EXCEEDED' },
    });
  });

  it('allows moving a folder to the root and between categories', () => {
    expect(canDrop({ kind: 'folder', id: f('beta') }, { kind: 'root' }, tree).ok).toBe(true);
    expect(canDrop({ kind: 'folder', id: f('beta') }, { kind: 'category', id: 'c' as CategoryId }, tree).ok).toBe(true);
  });
});

describe('drag payload', () => {
  it('round-trips and rejects foreign data', () => {
    expect(decodeDragItem(encodeDragItem({ kind: 'note', id: 'n' as NoteId }))).toEqual({ kind: 'note', id: 'n' });
    expect(decodeDragItem('not json')).toBeNull();
    expect(decodeDragItem('{"kind":"file","id":"x"}')).toBeNull();
    expect(decodeDragItem('{"kind":"note"}')).toBeNull();
  });
});

describe('createDragDropManager', () => {
  it('drops a note into a folder and adopts the folder category', async () => {
    const { store } = setup();
    await store.createCategory('Work');
    await store.createFolder('Inbox', null, 'id-1' as CategoryId);
    await store.createTab();
    const dnd = createDragDropManager(store, () => undefined);
    expectOk(await dnd.drop({ kind: 'note', id: 'id-3' as NoteId }, { kind: 'folder', id: f('id-2') }));
    expect(store.state.notes['id-3' as NoteId]).toMatchObject({ folderId: 'id-2', categoryId: 'id-1' });
  });

  it('moves a dropped folder to the root of a category with its subtree', async () => {
    const { store } = setup();
    await store.createCategory('Work');
    await store.createCategory('Home');
    await store.createFolder('Projects', null, 'id-1' as CategoryId);
    await store.createFolder('Old', f('id-3'), null);
    await store.createTab();
    const dnd = createDragDropManager(store, () => undefined);
    expectOk(await dnd.drop({ kind: 'note', id: 'id-5' as NoteId }, { kind: 'folder', id: f('id-4') }));
    expectOk(await dnd.drop({ kind: 'folder', id: f('id-4') }, { kind: 'category', id: 'id-2' as CategoryId }));
    expect(store.state.folders.find((x) => x.id === 'id-4')).toMatchObject({ parentId: null, categoryId: 'id-2' });
    expect(store.state.notes['id-5' as NoteId]?.categoryId).toBe('id-2');
    expect(store.state.folders.find((x) => x.id === 'id-3')?.categoryId).toBe('id-1');
  });

  it('refuses invalid folder drops without touching storage', async () => {
    const { store } = setup();
    await store.createFolder('Alpha', null, null);
    await store.createFolder('Beta', f('id-1'), null);
    const dnd = createDragDropManager(store, () => undefined);
    const result = await dnd.drop({ kind: 'folder', id: f('id-1') }, { kind: 'folder', id: f('id-2') });
    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_CIRCULAR_HIERARCHY' } });
    expect(store.state.folders.find((x) => x.id === 'id-1')?.parentId).toBeNull();
  });
});

describe('dropping on the empty tree area', () => {
  async function categorizedNote() {
    const { store, storage } = setup();
    await store.createCategory('Work');
    const category = 'id-1' as CategoryId;
    await store.createTab();
    await store.moveNote('id-2' as NoteId, null, category);
    const dnd = createDragDropManager(store, () => undefined);
    return { store, storage, dnd, category, note: 'id-2' as NoteId };
  }

  it('keeps the category when dropped in the category view (regression)', async () => {
    const { store, storage, dnd, category, note } = await categorizedNote();
    store.select({ kind: 'category', id: category });
    const before = (await storage.getNote(note))?.updatedAt;
    expectOk(await dnd.drop({ kind: 'note', id: note }, { kind: 'root' }));
    expect(store.state.notes[note]).toMatchObject({ folderId: null, categoryId: category });
    expect((await storage.getNote(note))?.updatedAt).toBe(before);
  });

  it('takes a note out of its folder but keeps its category', async () => {
    const { store, dnd, category, note } = await categorizedNote();
    await store.createFolder('Clients', null, category);
    await store.moveNote(note, f('id-3'), category);
    store.select({ kind: 'category', id: category });
    expectOk(await dnd.drop({ kind: 'note', id: note }, { kind: 'root' }));
    expect(store.state.notes[note]).toMatchObject({ folderId: null, categoryId: category });

    await store.moveNote(note, f('id-3'), category);
    store.select({ kind: 'system', id: 'system_all' });
    expectOk(await dnd.drop({ kind: 'note', id: note }, { kind: 'root' }));
    expect(store.state.notes[note]).toMatchObject({ folderId: null, categoryId: category });
  });

  it('moves into the selected folder in a folder view', async () => {
    const { store, dnd, note } = await categorizedNote();
    await store.createFolder('Inbox', null, null);
    store.select({ kind: 'folder', id: f('id-3') });
    expectOk(await dnd.drop({ kind: 'note', id: note }, { kind: 'root' }));
    expect(store.state.notes[note]?.folderId).toBe('id-3');
  });

  it('refuses drops in Archive and Trash', async () => {
    const { store, dnd, note } = await categorizedNote();
    store.select({ kind: 'system', id: 'system_trash' });
    expect(await dnd.drop({ kind: 'note', id: note }, { kind: 'root' })).toMatchObject({
      ok: false,
      error: { code: 'ERR_INVALID_TRANSITION' },
    });
  });

  it('changes the category only when dropped onto another category', async () => {
    const { store, dnd, note } = await categorizedNote();
    await store.createCategory('Home');
    expectOk(await dnd.drop({ kind: 'note', id: note }, { kind: 'category', id: 'id-3' as CategoryId }));
    expect(store.state.notes[note]?.categoryId).toBe('id-3');
  });
});

