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

  it('allows moving a folder to the root but not between categories', () => {
    expect(canDrop({ kind: 'folder', id: f('beta') }, { kind: 'root' }, tree).ok).toBe(true);
    expect(canDrop({ kind: 'folder', id: f('beta') }, { kind: 'category', id: 'c' as CategoryId }, tree).ok).toBe(false);
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
