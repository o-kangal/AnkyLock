import {
  descendantFolderIds,
  planHierarchyRepair,
  type Category,
  type CategoryId,
  type EpochMs,
  type Folder,
  type FolderId,
  type Note,
  type NoteId,
} from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import type { IStorageEngine, RemoteRecords, Tombstone } from '@ankylock/storage';
import type { DeviceId, SyncPacket } from '../protocol/frame.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * HIERARCHY_MUTATION packet carrying the changed records (state, not operations), sealed as a
 * whole: names inside are ciphertext already, and ids and parents stay hidden from the relay.
 */
export async function createHierarchyPacket(
  sealer: Sealer,
  deviceId: DeviceId,
  records: RemoteRecords,
  now: EpochMs,
): Promise<SyncPacket> {
  const first = records.folders?.[0]?.id ?? records.categories?.[0]?.id ?? records.notes?.[0]?.id;
  if (first === undefined) throw new Error('A hierarchy packet needs at least one record.');
  return {
    packetType: 'HIERARCHY_MUTATION',
    entityId: first,
    senderDeviceId: deviceId,
    timestampMs: now,
    payload: await sealer.seal(encoder.encode(JSON.stringify(records))),
  };
}

/** AES-GCM authenticated the payload, so this vault wrote it; only the shape needs checking. */
export function readHierarchyPayload(plaintext: Uint8Array): RemoteRecords {
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  const list = (key: string): unknown[] => {
    const field = (value as Record<string, unknown>)[key];
    return Array.isArray(field) ? field : [];
  };
  if (typeof value !== 'object' || value === null) throw new Error('Hierarchy payload is malformed.');
  return {
    categories: list('categories') as Category[],
    folders: list('folders') as Folder[],
    notes: list('notes') as Note[],
  };
}

/**
 * Merges another device's records (newer clock wins, purged ids stay purged), then repairs what
 * concurrent moves can break: cycles and depth (SPEC §7). Every device computes the same repair
 * from the same records, so it isn't sent anywhere.
 */
export async function applyRemoteRecords(storage: IStorageEngine, records: RemoteRecords): Promise<void> {
  await storage.mergeRecords(records);
  const [live, trashed] = await Promise.all([storage.listFolders(), storage.listTrashedFolders()]);
  const detach = planHierarchyRepair([...live, ...trashed]);
  if (detach.length > 0) await storage.detachFolders(detach);
}

/** Purges what another device purged. Purging needs Trash first, as it would locally. */
export async function applyRemoteTombstone(
  storage: IStorageEngine,
  entityId: string,
  entityType: Tombstone['entityType'],
): Promise<boolean> {
  switch (entityType) {
    case 'note': {
      const note = await storage.getNote(entityId as NoteId);
      if (note === null) return false;
      if (note.deletedAt === null) await storage.trashNote(note.id);
      await storage.purgeNote(note.id);
      return true;
    }
    case 'folder': {
      const all = [...(await storage.listFolders()), ...(await storage.listTrashedFolders())];
      const folder = all.find((f) => f.id === entityId);
      if (!folder) return false;
      if (folder.deletedAt === null) await storage.trashFolder(folder.id);
      await storage.purgeFolder(folder.id);
      return true;
    }
    case 'category': {
      if (!(await storage.listCategories()).some((c) => c.id === entityId)) return false;
      await storage.deleteCategory(entityId as CategoryId);
      return true;
    }
  }
}

/** Every folder (live or trashed) at or below `id`, with the notes inside them. */
async function subtreeRecords(storage: IStorageEngine, id: FolderId): Promise<RemoteRecords> {
  const folders: Folder[] = [...(await storage.listFolders()), ...(await storage.listTrashedFolders())];
  const ids = new Set<FolderId>([id, ...descendantFolderIds(folders, id)]);
  const live = await Promise.all([...ids].map((folderId) => storage.listNotes(folderId)));
  const trashed = (await storage.listTrashedNotes()).filter((n) => n.folderId !== null && ids.has(n.folderId));
  return { folders: folders.filter((f) => ids.has(f.id)), notes: [...live.flat(), ...trashed] };
}

export interface HierarchyPublisher {
  /** Records the user changed on this device. */
  readonly onRecords: (records: RemoteRecords) => void;
  /** Entities removed for good on this device without a purge (category delete, discarded scratchpad). */
  readonly onRemoved: (entityId: string, entityType: Tombstone['entityType']) => void;
  readonly onError: (error: unknown) => void;
}

type Method = (...args: never[]) => Promise<unknown>;

/**
 * Wraps storage so every hierarchy change the user makes is published to other devices: the
 * changed records after each write (whole subtrees for cascading folder operations). Purges are
 * announced separately (BR-LIFE-04). Remote changes are applied to the unwrapped storage, so
 * nothing echoes back.
 */
export function publishingStorage(storage: IStorageEngine, publish: HierarchyPublisher): IStorageEngine {
  const send = (records: RemoteRecords): void => publish.onRecords(records);
  const after: Partial<Record<keyof IStorageEngine, (result: unknown, args: readonly unknown[]) => Promise<void> | void>> = {
    createCategory: (category) => send({ categories: [category as Category] }),
    renameCategory: (category) => send({ categories: [category as Category] }),
    deleteCategory: (_r, [id]) => publish.onRemoved(id as string, 'category'),
    createFolder: (folder) => send({ folders: [folder as Folder] }),
    moveFolder: (folder) => send({ folders: [folder as Folder] }),
    renameFolder: (folder) => send({ folders: [folder as Folder] }),
    archiveFolder: async (folder) => send(await subtreeRecords(storage, (folder as Folder).id)),
    unarchiveFolder: async (folder) => send(await subtreeRecords(storage, (folder as Folder).id)),
    trashFolder: async (folder) => send(await subtreeRecords(storage, (folder as Folder).id)),
    restoreFolder: async (folder) => send(await subtreeRecords(storage, (folder as Folder).id)),
    createNote: (note) => send({ notes: [note as Note] }),
    moveNote: (note) => send({ notes: [note as Note] }),
    setNoteArchived: (note) => send({ notes: [note as Note] }),
    trashNote: (note) => send({ notes: [note as Note] }),
    restoreNote: (note) => send({ notes: [note as Note] }),
    discardEphemeralNote: (_r, [id]) => publish.onRemoved(id as string, 'note'),
  };
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      const hook = after[property as keyof IStorageEngine];
      if (typeof value !== 'function') return value;
      const method = (value as Method).bind(target);
      if (!hook) return method;
      return async (...args: never[]) => {
        const result = await method(...args);
        try {
          await hook(result, args);
        } catch (error) {
          publish.onError(error);
        }
        return result;
      };
    },
  });
}
