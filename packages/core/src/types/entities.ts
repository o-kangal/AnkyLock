import type { Brand, Bytes } from './brand.js';
import type { Ciphertext, SealedBytes } from './crypto.js';

/** UTC epoch milliseconds. */
export type EpochMs = Brand<number, 'EpochMs'>;

export type NoteId = Brand<string, 'NoteId'>;
export type FolderId = Brand<string, 'FolderId'>;
/** A user-defined category. System categories are views and never appear as `categoryId`. */
export type CategoryId = Brand<string, 'CategoryId'>;

export interface Category {
  readonly id: CategoryId;
  readonly isSystem: boolean;
  readonly sortOrder: number;
  readonly nameCiphertext: Ciphertext;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface Folder {
  readonly id: FolderId;
  readonly categoryId: CategoryId | null;
  readonly parentId: FolderId | null;
  readonly nameCiphertext: Ciphertext;
  readonly isArchived: boolean;
  readonly deletedAt: EpochMs | null;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface Note {
  readonly id: NoteId;
  readonly folderId: FolderId | null;
  readonly categoryId: CategoryId | null;
  readonly isEphemeral: boolean;
  readonly isArchived: boolean;
  readonly deletedAt: EpochMs | null;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface NoteContent {
  readonly noteId: NoteId;
  readonly titleCiphertext: Ciphertext;
  readonly contentCiphertext: SealedBytes;
  /** Clock metadata only (client ids and counters); carries no text. */
  readonly yjsStateVector: Bytes;
  /** The Yjs update log holds the full text, so it is encrypted at rest too. */
  readonly yjsUpdates: SealedBytes;
  readonly updatedAt: EpochMs;
}

export type SyncEntityType = 'note' | 'folder' | 'category' | 'tombstone';

export interface SyncOutboxEntry {
  readonly id: number;
  readonly entityId: NoteId | FolderId | CategoryId;
  readonly entityType: SyncEntityType;
  readonly encryptedPayload: SealedBytes;
  readonly createdAt: EpochMs;
}
