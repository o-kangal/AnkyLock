import { err, ok, validateFolderMove, type CategoryId, type FolderId, type FolderLink, type NoteId, type Result } from '@ankylock/core';
import type { JSX } from 'solid-js';
import type { WorkspaceStore } from '../stores/workspaceStore.js';

export type DragItem = { readonly kind: 'note'; readonly id: NoteId } | { readonly kind: 'folder'; readonly id: FolderId };

export type DropTarget =
  | { readonly kind: 'folder'; readonly id: FolderId }
  | { readonly kind: 'category'; readonly id: CategoryId }
  /** Workspace root: no folder (and, for notes, no category). */
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

  async function drop(item: DragItem, target: DropTarget): Promise<Result<void>> {
    const allowed = canDrop(item, target, folderLinks());
    if (!allowed.ok) return allowed;
    if (item.kind === 'folder') {
      return store.moveFolder(item.id, target.kind === 'folder' ? target.id : null);
    }
    const note = store.state.notes[item.id];
    switch (target.kind) {
      case 'folder': {
        const folder = store.state.folders.find((f) => f.id === target.id);
        return store.moveNote(item.id, target.id, folder?.categoryId ?? note?.categoryId ?? null);
      }
      case 'category':
        return store.moveNote(item.id, null, target.id);
      case 'root':
        return store.moveNote(item.id, null, null);
    }
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
          if (!current || !canDrop(current, target, folderLinks()).ok) return;
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
