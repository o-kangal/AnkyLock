import { MAX_FOLDER_DEPTH } from '../constants.js';
import { err, ok, type Result } from '../errors.js';
import type { Folder, FolderId } from '../types/entities.js';

/** Minimal folder shape needed for hierarchy checks; trashed folders are included. */
export type FolderLink = Pick<Folder, 'id' | 'parentId'>;

/**
 * Depth of `id` (a root-level folder is 1). Walks parents with a visited set so cyclic
 * data fails instead of looping. Reaching `moving` on the way up means a move would create a cycle.
 */
export function folderDepth(
  folders: ReadonlyMap<FolderId, FolderLink>,
  id: FolderId,
  moving?: FolderId,
): Result<number> {
  const visited = new Set<FolderId>();
  let current: FolderId | null = id;
  while (current !== null) {
    if (current === moving || visited.has(current)) {
      return err('ERR_CIRCULAR_HIERARCHY', 'Moving this folder would create a cycle.');
    }
    visited.add(current);
    current = folders.get(current)?.parentId ?? null;
  }
  return ok(visited.size);
}

/** Height of the subtree under `id` (a leaf is 0), capped at `MAX_FOLDER_DEPTH`. */
export function subtreeHeight(folders: ReadonlyMap<FolderId, FolderLink>, id: FolderId): number {
  const children = new Map<FolderId, FolderId[]>();
  for (const folder of folders.values()) {
    if (folder.parentId === null) continue;
    const siblings = children.get(folder.parentId);
    if (siblings) siblings.push(folder.id);
    else children.set(folder.parentId, [folder.id]);
  }
  let height = 0;
  let level = [id];
  while (height < MAX_FOLDER_DEPTH) {
    level = level.flatMap((folderId) => children.get(folderId) ?? []);
    if (level.length === 0) break;
    height++;
  }
  return height;
}

const tooDeep = (): Result<never> => err('ERR_MAX_DEPTH_EXCEEDED', 'Folders can nest at most 3 levels deep.');

/** BR-HIER-03 for a new folder under `parentId` (null = root). */
export function validateFolderCreate(
  folders: ReadonlyMap<FolderId, FolderLink>,
  parentId: FolderId | null,
): Result<void> {
  if (parentId === null) return ok(undefined);
  const depth = folderDepth(folders, parentId);
  if (!depth.ok) return depth;
  return depth.value + 1 > MAX_FOLDER_DEPTH ? tooDeep() : ok(undefined);
}

/** BR-HIER-03 and BR-HIER-05 for moving `id` under `newParentId`; counts the moved subtree's height. */
export function validateFolderMove(
  folders: ReadonlyMap<FolderId, FolderLink>,
  id: FolderId,
  newParentId: FolderId | null,
): Result<void> {
  let parentDepth = 0;
  if (newParentId !== null) {
    const depth = folderDepth(folders, newParentId, id);
    if (!depth.ok) return depth;
    parentDepth = depth.value;
  }
  return parentDepth + 1 + subtreeHeight(folders, id) > MAX_FOLDER_DEPTH ? tooDeep() : ok(undefined);
}

/**
 * Folders to move to the root after merging another device's records, where concurrent moves can
 * produce what no single device allowed (SPEC §7): a cycle loses the link of its smallest id, and
 * a folder nested deeper than `MAX_FOLDER_DEPTH` moves to the root with its subtree. Deterministic,
 * so every device repairs the same records the same way without sending anything.
 */
export function planHierarchyRepair(folders: Iterable<FolderLink>): FolderId[] {
  const parents = new Map<FolderId, FolderId | null>();
  for (const f of folders) parents.set(f.id, f.parentId);
  const detached: FolderId[] = [];
  const detach = (id: FolderId): void => {
    parents.set(id, null);
    detached.push(id);
  };
  const byId = [...parents.keys()].sort();

  for (const start of byId) {
    const path: FolderId[] = [];
    let current: FolderId | null = start;
    while (current !== null && !path.includes(current)) {
      path.push(current);
      current = parents.get(current) ?? null;
    }
    if (current !== null) detach(path.slice(path.indexOf(current)).sort()[0] as FolderId);
  }

  const depth = (id: FolderId): number => {
    let d = 0;
    for (let current: FolderId | null = id; current !== null; current = parents.get(current) ?? null) d++;
    return d;
  };
  for (;;) {
    const tooDeepIds = byId.filter((id) => depth(id) === MAX_FOLDER_DEPTH + 1);
    if (tooDeepIds.length === 0) return detached;
    tooDeepIds.forEach(detach);
  }
}
