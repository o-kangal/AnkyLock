import { describe, expect, it } from 'vitest';
import {
  checkFolderArchive,
  checkFolderPurge,
  checkFolderTrash,
  descendantFolderIds,
  planFolderRestore,
  type CategoryId,
  type EpochMs,
  type Folder,
  type FolderId,
} from '../src/index.js';

const f = (id: string): FolderId => id as FolderId;

function folder(id: string, extra: Partial<Folder> = {}): Folder {
  return {
    id: f(id),
    parentId: null,
    categoryId: 'cat' as CategoryId,
    nameCiphertext: 'x' as Folder['nameCiphertext'],
    isArchived: false,
    deletedAt: null,
    createdAt: 1 as EpochMs,
    updatedAt: 1 as EpochMs,
    ...extra,
  };
}

const code = (r: { ok: boolean; error?: { code: string } }): string | undefined => r.error?.code;

describe('descendantFolderIds', () => {
  it('walks the whole subtree breadth first', () => {
    const tree = [
      { id: f('a'), parentId: null },
      { id: f('b'), parentId: f('a') },
      { id: f('c'), parentId: f('b') },
      { id: f('d'), parentId: f('a') },
      { id: f('x'), parentId: null },
    ];
    expect(descendantFolderIds(tree, f('a'))).toEqual(['b', 'd', 'c']);
    expect(descendantFolderIds(tree, f('c'))).toEqual([]);
  });

  it('terminates on cyclic data', () => {
    const cyclic = [
      { id: f('a'), parentId: f('b') },
      { id: f('b'), parentId: f('a') },
    ];
    expect(descendantFolderIds(cyclic, f('a'))).toEqual(['b']);
  });
});

describe('checkFolderArchive (BR-LIFE-01)', () => {
  it('archives live folders and unarchives archived ones', () => {
    expect(checkFolderArchive(folder('a'), true, null).ok).toBe(true);
    expect(checkFolderArchive(folder('a', { isArchived: true }), false, null).ok).toBe(true);
  });

  it('rejects no-op transitions, trashed folders and unarchiving under an archived parent', () => {
    expect(code(checkFolderArchive(folder('a', { isArchived: true }), true, null))).toBe('ERR_INVALID_TRANSITION');
    expect(code(checkFolderArchive(folder('a'), false, null))).toBe('ERR_INVALID_TRANSITION');
    expect(code(checkFolderArchive(folder('a', { deletedAt: 5 as EpochMs }), true, null))).toBe('ERR_READ_ONLY_TRASHED_ENTITY');
    const parent = folder('p', { isArchived: true });
    expect(code(checkFolderArchive(folder('a', { isArchived: true, parentId: f('p') }), false, parent))).toBe(
      'ERR_INVALID_TRANSITION',
    );
  });
});

describe('trash, restore and purge rules', () => {
  const trashed = folder('a', { parentId: f('p'), deletedAt: 5 as EpochMs });

  it('only trashes live folders', () => {
    expect(checkFolderTrash(folder('a')).ok).toBe(true);
    expect(code(checkFolderTrash(trashed))).toBe('ERR_READ_ONLY_TRASHED_ENTITY');
  });

  it('keeps pointers to live parents and categories', () => {
    expect(planFolderRestore(trashed, true, true)).toEqual({ ok: true, value: { parentId: 'p', categoryId: 'cat' } });
  });

  it('falls back to the root when the parent is purged or trashed (BR-LIFE-05)', () => {
    expect(planFolderRestore(trashed, false, false)).toEqual({ ok: true, value: { parentId: null, categoryId: null } });
  });

  it('only restores and purges trashed folders', () => {
    expect(code(planFolderRestore(folder('a'), true, true))).toBe('ERR_INVALID_TRANSITION');
    expect(code(checkFolderPurge(folder('a')))).toBe('ERR_INVALID_TRANSITION');
    expect(checkFolderPurge(trashed).ok).toBe(true);
  });
});
