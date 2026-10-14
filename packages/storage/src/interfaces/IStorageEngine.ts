import type {
  Category,
  CategoryId,
  Ciphertext,
  EpochMs,
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
  VaultId,
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

  /** Serialized vault header (see `serializeVaultHeader`); written once when the vault is created. */
  getVaultHeader(): Promise<string | null>;
  /** The vault's encrypted name; null for vaults created before vaults had names. */
  getVaultName(): Promise<Ciphertext | null>;
  /** This device's id within the vault, created on first use; names its own Drive snapshot. */
  getDeviceId(): Promise<string>;
  /**
   * Restores a vault from Drive snapshots in one transaction. Only an empty vault accepts it
   * (ERR_INVALID_TRANSITION otherwise). Records are stored as given: still encrypted.
   */
  importVault(data: VaultImport): Promise<void>;
}

/** A vault's records as restored from (merged) Drive snapshots. */
export interface VaultImport {
  readonly retentionDays: number;
  readonly categories: readonly Category[];
  readonly folders: readonly Folder[];
  readonly notes: readonly Note[];
  readonly contents: readonly NoteContent[];
}

/** A vault on this device: an id and timestamps, never its name (BR-SEC-04). */
export interface VaultEntry {
  readonly id: VaultId;
  readonly createdAt: EpochMs;
  readonly lastOpenedAt: EpochMs;
}

/** The vaults on this device, each in its own database: own salt, key and data. */
export interface IVaultDirectory {
  /** Most recently opened first. */
  list(): Promise<VaultEntry[]>;
  /**
   * Creates the vault's database with its header and encrypted name, registers it and opens it.
   * The header is written once, so a vault's key can never be orphaned. `createdAt` is given
   * for a vault that already exists elsewhere, so every device shows the same creation time.
   */
  create(id: VaultId, header: string, nameCiphertext: Ciphertext | null, createdAt?: EpochMs): Promise<IStorageEngine>;
  /** Opens a registered vault; storage returned earlier must not be used afterwards. */
  open(id: VaultId): Promise<IStorageEngine>;
}

export class StorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}
