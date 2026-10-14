import type {
  Category,
  CategoryId,
  Ciphertext,
  ErrorCode,
  Folder,
  FolderId,
  Note,
  NoteContent,
  NoteId,
  PurgedEntities,
  SealedBytes,
  SyncEntityType,
  SyncOutboxEntry,
} from '@ankylock/core';

export interface NewFolder {
  readonly id: FolderId;
  /** A subfolder inherits its parent's category; `categoryId` only applies at the root. */
  readonly parentId: FolderId | null;
  readonly categoryId: CategoryId | null;
  readonly nameCiphertext: Ciphertext;
}

export interface NewOutboxEntry {
  readonly entityId: SyncOutboxEntry['entityId'];
  readonly entityType: SyncEntityType;
  readonly encryptedPayload: SealedBytes;
}

/**
 * Platform-agnostic persistence. Desktop routes through Tauri IPC to SQLite; web uses IndexedDB.
 * Both adapters enforce the same domain rules and reject with `StorageError` carrying a core `ErrorCode`.
 * All names and bodies arrive already encrypted; adapters never see plaintext.
 */
export interface IStorageEngine {
  listCategories(): Promise<Category[]>;
  createCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category>;
  renameCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category>;
  /** Notes and folders in the category fall back to no category. */
  deleteCategory(id: CategoryId): Promise<void>;

  /** Live (non-trashed) folders, oldest first. */
  listFolders(): Promise<Folder[]>;
  createFolder(folder: NewFolder): Promise<Folder>;
  moveFolder(id: FolderId, newParentId: FolderId | null): Promise<Folder>;
  renameFolder(id: FolderId, nameCiphertext: Ciphertext): Promise<Folder>;
  /** Trashed folders, most recently trashed first. */
  listTrashedFolders(): Promise<Folder[]>;
  /** BR-LIFE-01: cascades `isArchived` to every live descendant folder and note. */
  archiveFolder(id: FolderId): Promise<Folder>;
  /** Clears `isArchived` on the subtree; rejected while the parent is archived. */
  unarchiveFolder(id: FolderId): Promise<Folder>;
  /** BR-LIFE-02: stamps one `deletedAt` on the folder and every live descendant folder and note. */
  trashFolder(id: FolderId): Promise<Folder>;
  /** Restores the folder and what was trashed with it; a trashed or purged parent sends it to the root. */
  restoreFolder(id: FolderId): Promise<Folder>;
  /** Hard-deletes a trashed folder with its subtree and notes, writing a tombstone for each. */
  purgeFolder(id: FolderId): Promise<PurgedEntities>;

  createNote(id: NoteId): Promise<Note>;
  getNote(id: NoteId): Promise<Note | null>;
  /** Live notes in a folder, or loose notes for `null`; most recently updated first. */
  listNotes(folderId: FolderId | null): Promise<Note[]>;
  listTrashedNotes(): Promise<Note[]>;
  moveNote(id: NoteId, folderId: FolderId | null, categoryId: CategoryId | null): Promise<Note>;
  setNoteArchived(id: NoteId, archived: boolean): Promise<Note>;
  trashNote(id: NoteId): Promise<Note>;
  restoreNote(id: NoteId): Promise<Note>;
  purgeNote(id: NoteId): Promise<void>;
  /** Deletes an empty, unmodified scratchpad without trashing it; the caller decides emptiness. */
  discardEphemeralNote(id: NoteId): Promise<void>;
  getNoteContent(noteId: NoteId): Promise<NoteContent | null>;
  saveNoteContent(content: NoteContent): Promise<void>;

  enqueueOutbox(entry: NewOutboxEntry): Promise<SyncOutboxEntry>;
  /** Oldest first, so the queue drains in insertion order. */
  listOutbox(limit: number): Promise<SyncOutboxEntry[]>;
  deleteOutbox(ids: readonly number[]): Promise<void>;

  /** BR-LIFE-03: 0 (manual purge only) or 1..=365; defaults to 28. */
  getTrashRetentionDays(): Promise<number>;
  /** Stores the value; rejects invalid ones with ERR_INVALID_SETTING. Confirmation is the caller's job. */
  setTrashRetentionDays(days: number): Promise<number>;

  /** Serialized vault header (see `serializeVaultHeader`), or null before the vault exists. */
  getVaultHeader(): Promise<string | null>;
  /** Written once; a second call fails with ERR_INVALID_SETTING so the key can't be orphaned. */
  setVaultHeader(header: string): Promise<void>;
}

export class StorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}
