import { err, ok, validateFolderMove, type CategoryId, type FolderId, type FolderLink, type NoteId, type Result } from '@ankylock/core';
import type { JSX } from 'solid-js';
import type { WorkspaceStore } from '../stores/workspaceStore.js';

export type DragItem = { readonly kind: 'note'; readonly id: NoteId } | { readonly kind: 'folder'; readonly id: FolderId };

export type DropTarget =
  | { readonly kind: 'folder'; readonly id: FolderId }
  | { readonly kind: 'category'; readonly id: CategoryId }
  /**
   * The empty tree area. It means "the top of the current view": the selected folder in a folder
   * view, otherwise no folder. It never changes a note's category; only dropping onto a category
   * does. Not a drop target in Archive or Trash.
   */
  | { readonly kind: 'root' };

/** Private MIME type so drops from other apps or tabs are ignored. */
export const DRAG_MIME = 'application/x-ankylock-item';

/**
 * Pure drop rule shared by drag feedback and the drop itself. Folder moves get the same
 * depth and cycle checks as storage (BR-HIER-03, BR-HIER-05); moving folders between
 * categories is not supported yet.
 */
export function canDrop(item: DragItem, target: DropTarget, folders: ReadonlyMap<FolderId, FolderLink>): Result<void> {
  if (item.kind === 'note') return ok(undefined);
  switch (target.kind) {
    case 'folder':
      return validateFolderMove(folders, item.id, target.id);
    case 'root':
      return validateFolderMove(folders, item.id, null);
    case 'category':
      return err('ERR_INVALID_TRANSITION', 'Folders cannot be moved between categories yet.');
  }
}

export function encodeDragItem(item: DragItem): string {
  return JSON.stringify(item);
}

export function decodeDragItem(raw: string): DragItem | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { kind, id } = value as Record<string, unknown>;
    if (typeof id !== 'string') return null;
    if (kind === 'note') return { kind, id: id as NoteId };
    if (kind === 'folder') return { kind, id: id as FolderId };
    return null;
  } catch {
    return null;
  }
}

type DragSourceProps = Pick<JSX.HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragEnd'>;
type DropTargetProps = Pick<JSX.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDrop'>;

export interface DragDropManager {
  dragSource(item: () => DragItem): DragSourceProps;
  dropTarget(target: DropTarget): DropTargetProps;
  /** Performs a drop; exposed for keyboard moves and tests. */
  drop(item: DragItem, target: DropTarget): Promise<Result<void>>;
}

/**
 * Native HTML5 drag-and-drop over ids, never DOM nodes, so it works with virtualized rows
 * whose elements may unmount mid-drag. Browsers hide `dataTransfer` contents during dragover,
 * so the dragged item is also kept here for live feedback.
 */
export function createDragDropManager(store: WorkspaceStore, onError: (message: string) => void): DragDropManager {
  let current: DragItem | null = null;

  const folderLinks = (): Map<FolderId, FolderLink> =>
    new Map(store.state.folders.map((f) => [f.id, { id: f.id, parentId: f.parentId }]));

  /** Resolves the empty tree area against the current view; null where dropping isn't allowed. */
  function resolve(target: DropTarget): DropTarget | null {
    if (target.kind !== 'root') return target;
    const { selection } = store.state;
    if (selection.kind === 'folder') return { kind: 'folder', id: selection.id };
    if (selection.kind === 'system' && selection.id !== 'system_all') return null;
    return target;
  }

  function allowed(item: DragItem, target: DropTarget): Result<{ target: DropTarget }> {
    const resolved = resolve(target);
    if (resolved === null) return err('ERR_INVALID_TRANSITION', 'Items cannot be dropped here.');
    const check = canDrop(item, resolved, folderLinks());
    return check.ok ? ok({ target: resolved }) : check;
  }

  async function drop(item: DragItem, requested: DropTarget): Promise<Result<void>> {
    const check = allowed(item, requested);
    if (!check.ok) return check;
    const { target } = check.value;

    if (item.kind === 'folder') {
      const parentId = target.kind === 'folder' ? target.id : null;
      const folder = store.state.folders.find((f) => f.id === item.id);
      return folder?.parentId === parentId ? ok(undefined) : store.moveFolder(item.id, parentId);
    }

    const note = store.state.notes[item.id];
    if (!note) return err('ERR_NOT_FOUND', 'Note not found.');
    let folderId: FolderId | null = null;
    let categoryId = note.categoryId;
    if (target.kind === 'folder') {
      folderId = target.id;
      categoryId = store.state.folders.find((f) => f.id === target.id)?.categoryId ?? note.categoryId;
    } else if (target.kind === 'category') {
      categoryId = target.id;
    } else if (store.state.selection.kind === 'category') {
      // Keep the note visible in the category being viewed.
      categoryId = store.state.selection.id;
    }
    if (note.folderId === folderId && note.categoryId === categoryId && !note.isEphemeral) return ok(undefined);
    return store.moveNote(item.id, folderId, categoryId);
  }

  return {
    drop,

    dragSource(item) {
      return {
        draggable: true,
        onDragStart: (event: DragEvent) => {
          current = item();
          event.dataTransfer?.setData(DRAG_MIME, encodeDragItem(current));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        },
        onDragEnd: () => {
          current = null;
        },
      };
    },

    dropTarget(target) {
      return {
        onDragOver: (event: DragEvent) => {
          if (!current || !allowed(current, target).ok) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const item = current ?? decodeDragItem(event.dataTransfer?.getData(DRAG_MIME) ?? '');
          current = null;
          if (!item) return;
          void drop(item, target).then((result) => {
            if (!result.ok) onError(result.error.message);
          });
        },
      };
    },
  };
}
