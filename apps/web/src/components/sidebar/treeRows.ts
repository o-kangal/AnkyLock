import type { FolderId } from '@ankylock/core';
import type { FolderView, NoteView, WorkspaceState } from '../../stores/workspaceStore.js';
import { compareNames } from '../../i18n/index.js';

export type TreeRow =
  | { readonly kind: 'folder'; readonly folder: FolderView; readonly depth: number; readonly expanded: boolean }
  | { readonly kind: 'note'; readonly note: NoteView; readonly depth: number };

/**
 * How the tree orders notes: by last change or creation (newest first) or by title (A to Z);
 * `reversed` flips it. Folders follow creation order when notes do, and their names otherwise:
 * a folder's own timestamp does not move when the notes inside it change.
 */
export type SortKey = 'modified' | 'created' | 'name';
export interface SortOrder {
  readonly key: SortKey;
  readonly reversed: boolean;
}
export const DEFAULT_SORT: SortOrder = { key: 'modified', reversed: false };

type Compare<T> = (a: T, b: T) => number;

const noteOrder: Record<SortKey, Compare<NoteView>> = {
  modified: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  // Untitled notes (and titles still decrypting) go after named ones, newest first.
  name: (a, b) => {
    if (a.title && b.title) return compareNames(a.title, b.title) || b.updatedAt - a.updatedAt;
    if (a.title || b.title) return a.title ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  },
};

const folderOrder = (key: SortKey): Compare<FolderView> =>
  key === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => compareNames(a.name, b.name);

const directed = <T>(compare: Compare<T>, reversed: boolean): Compare<T> => (reversed ? (a, b) => compare(b, a) : compare);

type Item = Pick<FolderView, 'isArchived' | 'deletedAt'>;

/** Which folders and notes a view shows: Trash shows trashed items, Archive archived ones, the rest live ones. */
function visibilityFor(state: WorkspaceState): (item: Item) => boolean {
  const { selection } = state;
  if (selection.kind === 'system' && selection.id === 'system_trash') return (i) => i.deletedAt !== null;
  if (selection.kind === 'system' && selection.id === 'system_archive') return (i) => i.deletedAt === null && i.isArchived;
  return (i) => i.deletedAt === null && !i.isArchived;
}

/**
 * Flattens the visible part of the hierarchy into rows for the virtualized list. Roots are the
 * visible folders whose parent is not visible in this view (so an archived or trashed folder
 * shows with its subtree in Archive or Trash), followed by visible notes outside visible folders.
 * - All Notes / Archive / Trash: everything visible in that view.
 * - A custom category: its roots and loose notes only.
 * - A folder: that folder's subtree.
 */
export function buildTreeRows(state: WorkspaceState, expanded: ReadonlySet<FolderId>, order: SortOrder = DEFAULT_SORT): TreeRow[] {
  const folderSort = directed(folderOrder(order.key), order.reversed);
  const noteSort = directed(noteOrder[order.key], order.reversed);
  const visible = visibilityFor(state);
  const folders = state.folders.filter(visible);
  const notes = Object.values(state.notes).filter(visible);
  const visibleIds = new Set(folders.map((f) => f.id));

  const children = new Map<FolderId, FolderView[]>();
  for (const folder of folders) {
    if (folder.parentId === null || !visibleIds.has(folder.parentId)) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }

  const rows: TreeRow[] = [];
  const rendered = new Set<FolderId>();
  const addFolder = (folder: FolderView, depth: number): void => {
    // Guards against cyclic data so rendering can never loop.
    if (rendered.has(folder.id)) return;
    rendered.add(folder.id);
    const isExpanded = expanded.has(folder.id);
    rows.push({ kind: 'folder', folder, depth, expanded: isExpanded });
    if (!isExpanded) return;
    for (const child of (children.get(folder.id) ?? []).sort(folderSort)) addFolder(child, depth + 1);
    for (const note of notes.filter((n) => n.folderId === folder.id).sort(noteSort)) {
      rows.push({ kind: 'note', note, depth: depth + 1 });
    }
  };

  const { selection } = state;
  if (selection.kind === 'folder') {
    const root = folders.find((f) => f.id === selection.id);
    if (root) addFolder(root, 0);
    return rows;
  }

  const categoryId = selection.kind === 'category' ? selection.id : null;
  const inCategory = (item: { categoryId: FolderView['categoryId'] }): boolean =>
    categoryId === null || item.categoryId === categoryId;
  const roots = folders.filter((f) => (f.parentId === null || !visibleIds.has(f.parentId)) && inCategory(f));
  for (const folder of roots.sort(folderSort)) addFolder(folder, 0);
  const loose = notes.filter((n) => (n.folderId === null || !visibleIds.has(n.folderId)) && inCategory(n));
  for (const note of loose.sort(noteSort)) rows.push({ kind: 'note', note, depth: 0 });
  return rows;
}
