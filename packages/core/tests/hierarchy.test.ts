import { describe, expect, it } from 'vitest';
import {
  folderDepth,
  subtreeHeight,
  validateFolderCreate,
  validateFolderMove,
  type FolderId,
  type FolderLink,
} from '../src/index.js';

const id = (s: string): FolderId => s as FolderId;

function tree(...links: [string, string | null][]): Map<FolderId, FolderLink> {
  return new Map(links.map(([child, parent]) => [id(child), { id: id(child), parentId: parent === null ? null : id(parent) }]));
}

const errorCode = (result: { ok: boolean; error?: { code: string } }): string | undefined => result.error?.code;

describe('folderDepth', () => {
  it('counts a root-level folder as depth 1', () => {
    const folders = tree(['l1', null], ['l2', 'l1'], ['l3', 'l2']);
    expect(folderDepth(folders, id('l1'))).toEqual({ ok: true, value: 1 });
    expect(folderDepth(folders, id('l3'))).toEqual({ ok: true, value: 3 });
  });

  it('detects pre-existing cycles instead of looping', () => {
    const folders = tree(['x', 'y'], ['y', 'x']);
    expect(errorCode(folderDepth(folders, id('x')))).toBe('ERR_CIRCULAR_HIERARCHY');
  });
});

describe('subtreeHeight', () => {
  it('measures descendants', () => {
    const folders = tree(['a', null], ['b', 'a'], ['c', 'b'], ['d', null]);
    expect(subtreeHeight(folders, id('a'))).toBe(2);
    expect(subtreeHeight(folders, id('d'))).toBe(0);
  });

  it('is capped on cyclic data', () => {
    const folders = tree(['x', 'y'], ['y', 'x']);
    expect(subtreeHeight(folders, id('x'))).toBe(3);
  });
});

describe('validateFolderCreate', () => {
  const folders = tree(['l1', null], ['l2', 'l1'], ['l3', 'l2']);

  it('allows the root and up to level 3', () => {
    expect(validateFolderCreate(folders, null).ok).toBe(true);
    expect(validateFolderCreate(folders, id('l2')).ok).toBe(true);
  });

  it('rejects a fourth level', () => {
    expect(errorCode(validateFolderCreate(folders, id('l3')))).toBe('ERR_MAX_DEPTH_EXCEEDED');
  });
});

describe('validateFolderMove', () => {
  const folders = tree(['l1', null], ['l2', 'l1'], ['l3', 'l2'], ['a', null], ['a-child', 'a'], ['leaf', null]);

  it('rejects moving a folder into itself, its child or a grandchild', () => {
    expect(errorCode(validateFolderMove(folders, id('l1'), id('l1')))).toBe('ERR_CIRCULAR_HIERARCHY');
    expect(errorCode(validateFolderMove(folders, id('l1'), id('l2')))).toBe('ERR_CIRCULAR_HIERARCHY');
    expect(errorCode(validateFolderMove(folders, id('l1'), id('l3')))).toBe('ERR_CIRCULAR_HIERARCHY');
  });

  it('counts the moved subtree height', () => {
    expect(errorCode(validateFolderMove(folders, id('a'), id('l2')))).toBe('ERR_MAX_DEPTH_EXCEEDED');
    expect(validateFolderMove(folders, id('leaf'), id('l2')).ok).toBe(true);
  });

  it('allows moving to the root', () => {
    expect(validateFolderMove(folders, id('l3'), null).ok).toBe(true);
  });
});
