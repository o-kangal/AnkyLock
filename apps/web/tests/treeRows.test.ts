import { describe, expect, it } from 'vitest';
import type { CategoryId, EpochMs, FolderId, NoteId } from '@ankylock/core';
import { buildTreeRows, type TreeRow } from '../src/components/sidebar/treeRows.js';
import type { FolderView, NoteView, Selection, WorkspaceState } from '../src/index.js';

const folder = (id: string, parentId: string | null, categoryId: string | null = null): FolderView => ({
  id: id as FolderId,
  parentId: parentId as FolderId | null,
  categoryId: categoryId as CategoryId | null,
  name: id,
  isArchived: false,
});

const note = (id: string, folderId: string | null, extra: Partial<NoteView> = {}): NoteView => ({
  id: id as NoteId,
  folderId: folderId as FolderId | null,
  categoryId: null,
  isEphemeral: false,
  isArchived: false,
  deletedAt: null,
  updatedAt: 1 as EpochMs,
  title: id,
  ...extra,
});

function state(selection: Selection): WorkspaceState {
  const notes = [
    note('in-a', 'a'),
    note('in-b', 'b'),
    note('loose', null),
    note('work-loose', null, { categoryId: 'work' as CategoryId }),
    note('archived', null, { isArchived: true }),
    note('trashed', 'a', { deletedAt: 5 as EpochMs }),
  ];
  return {
    categories: [],
    folders: [folder('a', null), folder('b', 'a'), folder('w', null, 'work')],
    notes: Object.fromEntries(notes.map((n) => [n.id, n])) as WorkspaceState['notes'],
    tabs: [],
    activeTabIndex: -1,
    selection,
  };
}

const ids = (rows: TreeRow[]): string[] => rows.map((r) => (r.kind === 'folder' ? `F:${r.folder.id}` : `N:${r.note.id}`));
const all: Selection = { kind: 'system', id: 'system_all' };

describe('buildTreeRows', () => {
  it('shows root folders and live loose notes in All Notes, hiding archived and trashed', () => {
    expect(ids(buildTreeRows(state(all), new Set()))).toEqual(['F:a', 'F:w', 'N:loose', 'N:work-loose']);
  });

  it('expands folders into subfolders then notes, with depth', () => {
    const rows = buildTreeRows(state(all), new Set(['a', 'b'] as FolderId[]));
    expect(ids(rows).slice(0, 4)).toEqual(['F:a', 'F:b', 'N:in-b', 'N:in-a']);
    expect(rows.slice(0, 4).map((r) => r.depth)).toEqual([0, 1, 2, 1]);
  });

  it('filters by custom category', () => {
    expect(ids(buildTreeRows(state({ kind: 'category', id: 'work' as CategoryId }), new Set()))).toEqual([
      'F:w',
      'N:work-loose',
    ]);
  });

  it('lists archived and trashed notes flat', () => {
    expect(ids(buildTreeRows(state({ kind: 'system', id: 'system_archive' }), new Set()))).toEqual(['N:archived']);
    expect(ids(buildTreeRows(state({ kind: 'system', id: 'system_trash' }), new Set()))).toEqual(['N:trashed']);
  });

  it('never loops on cyclic folder data', () => {
    const s = state({ kind: 'folder', id: 'x' as FolderId });
    s.folders = [folder('x', 'y'), folder('y', 'x')];
    expect(ids(buildTreeRows(s, new Set(['x', 'y'] as FolderId[])))).toEqual(['F:x', 'F:y']);
  });
});
