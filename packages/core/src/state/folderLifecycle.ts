import { err, ok, type Result } from '../errors.js';
import type { CategoryId, Folder, FolderId, NoteId } from '../types/entities.js';

type FolderShape = Pick<Folder, 'id' | 'parentId'>;

/** Folder ids in the subtree below `rootId` (excluding it), breadth first; safe on cyclic data. */
export function descendantFolderIds(folders: Iterable<FolderShape>, rootId: FolderId): FolderId[] {
  const children = new Map<FolderId, FolderId[]>();
  for (const f of folders) {
    if (f.parentId === null) continue;
    const list = children.get(f.parentId) ?? [];
    list.push(f.id);
    children.set(f.parentId, list);
  }
  const seen = new Set<FolderId>([rootId]);
  const result: FolderId[] = [];
  const queue = [rootId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

const readOnly = (): Result<never> =>
  err('ERR_READ_ONLY_TRASHED_ENTITY', 'Items in Trash are read-only. Restore the folder to change it.');

/**
 * BR-LIFE-01: archiving cascades `is_archived = 1` to every live descendant folder and note;
 * unarchiving clears it on the whole subtree. A folder can't be unarchived while its parent is
 * archived, since it would then sit under a hidden folder.
 */
export function checkFolderArchive(folder: Folder, archived: boolean, parent: Folder | null): Result<void> {
  if (folder.deletedAt !== null) return readOnly();
  if (folder.isArchived === archived) {
    return err('ERR_INVALID_TRANSITION', archived ? 'The folder is already archived.' : 'The folder is not archived.');
  }
  if (!archived && parent?.isArchived) {
    return err('ERR_INVALID_TRANSITION', 'Unarchive the parent folder first.');
  }
  return ok(undefined);
}

/** BR-LIFE-02: trashing stamps one `deleted_at` on the folder and every live descendant. */
export function checkFolderTrash(folder: Folder): Result<void> {
  return folder.deletedAt === null ? ok(undefined) : readOnly();
}

export interface FolderRestorePlacement {
  readonly parentId: FolderId | null;
  readonly categoryId: CategoryId | null;
}

/**
 * Restoring clears `deleted_at` on the folder and on descendants carrying the same timestamp
 * (items trashed separately stay in Trash). BR-LIFE-05: a parent that was purged, or is itself
 * in Trash, can't hold a live folder, so the folder moves to the All Notes root; a purged
 * category is dropped.
 */
export function planFolderRestore(
  folder: Folder,
  parentIsLive: boolean,
  categoryExists: boolean,
): Result<FolderRestorePlacement> {
  if (folder.deletedAt === null) return err('ERR_INVALID_TRANSITION', 'The folder is not in Trash.');
  return ok({
    parentId: parentIsLive ? folder.parentId : null,
    categoryId: categoryExists ? folder.categoryId : null,
  });
}

export function checkFolderPurge(folder: Folder): Result<void> {
  return folder.deletedAt === null ? err('ERR_INVALID_TRANSITION', 'Only folders in Trash can be purged.') : ok(undefined);
}

/** Everything a folder purge removed, so each entity gets a tombstone and a sync packet. */
export interface PurgedEntities {
  readonly folders: FolderId[];
  readonly notes: NoteId[];
}
