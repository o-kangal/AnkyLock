import { describe, expect, it } from 'vitest';
import type { CategoryId, EpochMs, FolderId, NoteId } from '@ankylock/core';
import { buildTreeRows, type SortKey, type TreeRow } from '../src/components/sidebar/treeRows.js';
import type { FolderView, NoteView, Selection, WorkspaceState } from '../src/index.js';

const folder = (
  id: string,
  parentId: string | null,
  categoryId: string | null = null,
  extra: Partial<FolderView> = {},
): FolderView => ({
  id: id as FolderId,
  parentId: parentId as FolderId | null,
  categoryId: categoryId as CategoryId | null,
  name: id,
  isArchived: false,
  deletedAt: null,
  createdAt: 1 as EpochMs,
  ...extra,
});

const note = (id: string, folderId: string | null, extra: Partial<NoteView> = {}): NoteView => ({
  id: id as NoteId,
  folderId: folderId as FolderId | null,
  categoryId: null,
  isEphemeral: false,
  isArchived: false,
  deletedAt: null,
  createdAt: 1 as EpochMs,
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
    notes: Object.fromEntries(notes.map((n) => [n.id, n])),
    tabs: [],
    activeTabIndex: -1,
    selection,
    retentionDays: 28,
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

  it('shows archived and trashed folders with their subtree only in Archive and Trash', () => {
    const s = state(all);
    s.folders = [
      folder('live', null),
      folder('old', null, null, { isArchived: true }),
      folder('old-child', 'old', null, { isArchived: true }),
      folder('bin', null, null, { deletedAt: 9 as EpochMs }),
    ];
    s.notes = { n: note('n', 'old-child', { isArchived: true }) } as WorkspaceState['notes'];
    expect(ids(buildTreeRows(s, new Set()))).toEqual(['F:live']);

    s.selection = { kind: 'system', id: 'system_archive' };
    expect(ids(buildTreeRows(s, new Set(['old', 'old-child'] as FolderId[])))).toEqual(['F:old', 'F:old-child', 'N:n']);

    s.selection = { kind: 'system', id: 'system_trash' };
    expect(ids(buildTreeRows(s, new Set()))).toEqual(['F:bin']);
  });

  describe('sort order', () => {
    function sorted(): WorkspaceState {
      const s = state(all);
      s.folders = [
        folder('beta', null, null, { createdAt: 1 as EpochMs }),
        folder('Alpha', null, null, { createdAt: 3 as EpochMs }),
        folder('gamma', null, null, { createdAt: 2 as EpochMs }),
      ];
      const notes = [
        note('old-edited', null, { title: 'zebra', createdAt: 1 as EpochMs, updatedAt: 30 as EpochMs }),
        note('newest', null, { title: 'Apple', createdAt: 3 as EpochMs, updatedAt: 10 as EpochMs }),
        note('untitled', null, { title: null, createdAt: 2 as EpochMs, updatedAt: 20 as EpochMs }),
        note('middle', null, { title: 'mango', createdAt: 2 as EpochMs, updatedAt: 5 as EpochMs }),
      ];
      s.notes = Object.fromEntries(notes.map((n) => [n.id, n]));
      return s;
    }
    const order = (key: SortKey, reversed = false): string[] => ids(buildTreeRows(sorted(), new Set(), { key, reversed }));

    it('orders notes by last change by default, folders by name', () => {
      expect(ids(buildTreeRows(sorted(), new Set()))).toEqual(order('modified'));
      expect(order('modified')).toEqual(['F:Alpha', 'F:beta', 'F:gamma', 'N:old-edited', 'N:untitled', 'N:newest', 'N:middle']);
    });

    it('orders notes and folders by creation, newest first', () => {
      expect(order('created')).toEqual(['F:Alpha', 'F:gamma', 'F:beta', 'N:newest', 'N:untitled', 'N:middle', 'N:old-edited']);
    });

    it('orders notes by title, ignoring case, with untitled notes last', () => {
      expect(order('name')).toEqual(['F:Alpha', 'F:beta', 'F:gamma', 'N:newest', 'N:middle', 'N:old-edited', 'N:untitled']);
    });

    it('reverses folders and notes', () => {
      expect(order('modified', true)).toEqual(['F:gamma', 'F:beta', 'F:Alpha', 'N:middle', 'N:newest', 'N:untitled', 'N:old-edited']);
    });
  });

  it('never loops on cyclic folder data', () => {
    const s = state({ kind: 'folder', id: 'x' as FolderId });
    s.folders = [folder('x', 'y'), folder('y', 'x')];
    expect(ids(buildTreeRows(s, new Set(['x', 'y'] as FolderId[])))).toEqual(['F:x', 'F:y']);
  });
});
