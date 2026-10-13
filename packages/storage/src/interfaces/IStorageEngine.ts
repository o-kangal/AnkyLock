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
}

export class StorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}
