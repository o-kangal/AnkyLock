import type { IStorageEngine } from '@ankylock/storage';

/**
 * Writes that change what a backup holds: entities, note text and vault settings. Outbox and
 * sync bookkeeping are left out: they change with every sync and are not part of a snapshot.
 * A new write method of `IStorageEngine` that changes vault data must be added here.
 */
const VAULT_WRITES: ReadonlySet<keyof IStorageEngine> = new Set<keyof IStorageEngine>([
  'createCategory',
  'renameCategory',
  'deleteCategory',
  'createFolder',
  'moveFolder',
  'moveFolderToCategory',
  'renameFolder',
  'archiveFolder',
  'unarchiveFolder',
  'trashFolder',
  'restoreFolder',
  'purgeFolder',
  'createNote',
  'moveNote',
  'setNoteArchived',
  'trashNote',
  'restoreNote',
  'purgeNote',
  'discardEphemeralNote',
  'saveNoteContent',
  'mergeRecords',
  'detachFolders',
  'setTrashRetentionDays',
  'setVaultName',
  'importVault',
]);

type Method = (...args: never[]) => Promise<unknown>;

/** Wraps storage so `onChange` runs after every successful write to vault data, local or remote. */
export function trackChanges(storage: IStorageEngine, onChange: () => void): IStorageEngine {
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = (value as Method).bind(target);
      if (!VAULT_WRITES.has(property as keyof IStorageEngine)) return method;
      return async (...args: never[]) => {
        const result = await method(...args);
        onChange();
        return result;
      };
    },
  });
}
