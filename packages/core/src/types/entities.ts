import type { SystemCategoryId } from '../constants.js';
import type { Brand } from './brand.js';
import type { Ciphertext } from './crypto.js';

/** UTC epoch milliseconds. */
export type EpochMs = Brand<number, 'EpochMs'>;

export type NoteId = Brand<string, 'NoteId'>;
export type FolderId = Brand<string, 'FolderId'>;
export type CategoryId = Brand<string, 'CategoryId'> | SystemCategoryId;

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
  /** Packed `iv ‖ ciphertext ‖ tag` bytes. */
  readonly contentCiphertext: Uint8Array;
  readonly yjsStateVector: Uint8Array;
  readonly yjsUpdates: Uint8Array;
  readonly updatedAt: EpochMs;
}

export type SyncEntityType = 'note' | 'folder' | 'category' | 'tombstone';

export interface SyncOutboxEntry {
  readonly id: number;
  readonly entityId: NoteId | FolderId | CategoryId;
  readonly entityType: SyncEntityType;
  /** Packed `iv ‖ ciphertext ‖ tag` bytes; never plaintext. */
  readonly encryptedPayload: Uint8Array;
  readonly createdAt: EpochMs;
}
