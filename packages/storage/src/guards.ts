import type { Category, Folder, Note, NoteContent, SyncOutboxEntry } from '@ankylock/core';
import type { VaultEntry } from './interfaces/IStorageEngine.js';

type Check = (value: unknown) => boolean;

export const isString: Check = (v) => typeof v === 'string';
export const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const isBoolean: Check = (v) => typeof v === 'boolean';
/** Realm-independent: structured clones (IndexedDB, postMessage) may come from another realm. */
const isBytes: Check = (v) => ArrayBuffer.isView(v) && Object.prototype.toString.call(v) === '[object Uint8Array]';
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);

/** Builds a type guard that checks every listed field of a plain object. */
export function shape<T>(fields: { readonly [K in keyof T]-?: Check }): (value: unknown) => value is T {
  const entries = Object.entries<Check>(fields);
  return (value: unknown): value is T => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return entries.every(([key, check]) => check(record[key]));
  };
}

export const arrayOf =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(guard);

export const isNull = (value: unknown): value is null => value === null;

export const isVaultEntry = shape<VaultEntry>({ id: isString, createdAt: isNumber, lastOpenedAt: isNumber });

export const isSyncEntityType: Check = (v) => v === 'note' || v === 'folder' || v === 'category' || v === 'tombstone';

export const isCategory = shape<Category>({
  id: isString,
  isSystem: isBoolean,
  sortOrder: isNumber,
  nameCiphertext: isString,
  createdAt: isNumber,
  updatedAt: isNumber,
});

export const isFolder = shape<Folder>({
  id: isString,
  categoryId: nullable(isString),
  parentId: nullable(isString),
  nameCiphertext: isString,
  isArchived: isBoolean,
  archivedAt: nullable(isNumber),
  deletedAt: nullable(isNumber),
  createdAt: isNumber,
  updatedAt: isNumber,
});

export const isNote = shape<Note>({
  id: isString,
  folderId: nullable(isString),
  categoryId: nullable(isString),
  isEphemeral: isBoolean,
  isArchived: isBoolean,
  archivedAt: nullable(isNumber),
  deletedAt: nullable(isNumber),
  createdAt: isNumber,
  updatedAt: isNumber,
});

export const isNoteContent = shape<NoteContent>({
  noteId: isString,
  titleCiphertext: isString,
  contentCiphertext: isBytes,
  yjsStateVector: isBytes,
  yjsUpdates: isBytes,
  updatedAt: isNumber,
});

export const isOutboxEntry = shape<SyncOutboxEntry>({
  id: isNumber,
  entityId: isString,
  entityType: isSyncEntityType,
  encryptedPayload: isBytes,
  createdAt: isNumber,
});
