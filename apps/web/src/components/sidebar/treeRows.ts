import type { FolderId } from '@ankylock/core';
import type { FolderView, NoteView, Selection, WorkspaceState } from '../../stores/workspaceStore.js';

export type TreeRow =
  | { readonly kind: 'folder'; readonly folder: FolderView; readonly depth: number; readonly expanded: boolean }
  | { readonly kind: 'note'; readonly note: NoteView; readonly depth: number };

const byName = (a: FolderView, b: FolderView): number => a.name.localeCompare(b.name, 'en-US');
const byRecent = (a: NoteView, b: NoteView): number => b.updatedAt - a.updatedAt;

/**
 * Flattens the visible part of the hierarchy into rows for the virtualized list.
 * - All Notes: every live, unarchived folder and note.
 * - A custom category: its root folders (subfolders follow their parent) and its loose notes.
 * - A folder: that folder's subtree.
 * - Archive / Trash: a flat list of archived or trashed notes.
 */
export function buildTreeRows(state: WorkspaceState, expanded: ReadonlySet<FolderId>): TreeRow[] {
  const notes = Object.values(state.notes);
  const selection: Selection = state.selection;

  if (selection.kind === 'system' && selection.id !== 'system_all') {
    const inView =
      selection.id === 'system_trash'
        ? notes.filter((n) => n.deletedAt !== null)
        : notes.filter((n) => n.isArchived && n.deletedAt === null);
    return inView.sort(byRecent).map((note) => ({ kind: 'note', note, depth: 0 }));
  }

  const liveNotes = notes.filter((n) => n.deletedAt === null && !n.isArchived);
  const folders = state.folders.filter((f) => !f.isArchived);
  const children = new Map<FolderId | null, FolderView[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }

  const rows: TreeRow[] = [];
  const visited = new Set<FolderId>();
  const addFolder = (folder: FolderView, depth: number): void => {
    // Guards against cyclic data so rendering can never loop.
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    const isExpanded = expanded.has(folder.id);
    rows.push({ kind: 'folder', folder, depth, expanded: isExpanded });
    if (!isExpanded) return;
    for (const child of (children.get(folder.id) ?? []).sort(byName)) addFolder(child, depth + 1);
    for (const note of liveNotes.filter((n) => n.folderId === folder.id).sort(byRecent)) {
      rows.push({ kind: 'note', note, depth: depth + 1 });
    }
  };

  if (selection.kind === 'folder') {
    const root = folders.find((f) => f.id === selection.id);
    if (root) addFolder(root, 0);
    return rows;
  }

  const categoryId = selection.kind === 'category' ? selection.id : null;
  const roots = (children.get(null) ?? []).filter((f) => categoryId === null || f.categoryId === categoryId);
  for (const folder of roots.sort(byName)) addFolder(folder, 0);
  const loose = liveNotes.filter((n) => n.folderId === null && (categoryId === null || n.categoryId === categoryId));
  for (const note of loose.sort(byRecent)) rows.push({ kind: 'note', note, depth: 0 });
  return rows;
}
