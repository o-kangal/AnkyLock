import {
  DEFAULT_RETENTION_DAYS,
  checkFolderArchive,
  checkFolderPurge,
  checkFolderTrash,
  descendantFolderIds,
  planFolderRestore,
  isSystemCategoryId,
  transitionNote,
  validateFolderCreate,
  validateFolderMove,
  validateRetentionDays,
  type Category,
  type CategoryId,
  type Ciphertext,
  type DomainError,
  type EpochMs,
  type Folder,
  type FolderId,
  type Note,
  type NoteAction,
  type NoteContent,
  type NoteId,
  type NoteTransition,
  type PurgedEntities,
  type Result,
  type SyncOutboxEntry,
} from '@ankylock/core';
import { isCategory, isFolder, isNote, isNoteContent, isOutboxEntry } from '../guards.js';
import { StorageError, type IStorageEngine, type NewFolder, type NewOutboxEntry } from '../interfaces/IStorageEngine.js';

/** The single database used before vaults had ids; adopted as the first vault. */
export const LEGACY_DB_NAME = 'ankylock';
/**
 * v1: entity stores. v2: app_settings. v3: `archivedAt` on folders and notes (mirrors the SQL
 * migration `V20261013224803__add_archived_at`). Upgrades run step by step from the stored version.
 */
const DB_VERSION = 3;
const RETENTION_KEY = 'trash_retention_days';
const VAULT_HEADER_KEY = 'vault_header';
const VAULT_NAME_KEY = 'vault_name';

const STORES = {
  categories: 'categories',
  folders: 'folders',
  notes: 'notes',
  noteContents: 'note_contents',
  outbox: 'sync_outbox',
  tombstones: 'sync_tombstones',
  settings: 'app_settings',
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

interface Tombstone {
  readonly entityId: string;
  readonly entityType: 'note' | 'folder' | 'category';
  readonly purgedAt: EpochMs;
}

function request<T>(req: IDBRequest, guard: (value: unknown) => value is T): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result: unknown = req.result;
      if (guard(result)) resolve(result);
      else reject(new StorageError('ERR_STORAGE', 'Unexpected record shape in IndexedDB.'));
    };
    req.onerror = () => reject(new StorageError('ERR_STORAGE', req.error?.message ?? 'IndexedDB request failed.'));
  });
}

const optional =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T | undefined =>
    value === undefined || guard(value);

const all =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(guard);

const isSetting = (value: unknown): value is { key: string; value: unknown } =>
  typeof value === 'object' && value !== null && 'value' in value;

const anything = (_value: unknown): _value is unknown => true;
const isKey = (value: unknown): value is number => typeof value === 'number';

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) throw new StorageError(result.error.code, result.error.message);
  return result.value;
}

const notFound = (entity: string): StorageError => new StorageError('ERR_NOT_FOUND', `${entity} not found.`);

const byUpdatedDesc = (a: Note, b: Note): number => b.updatedAt - a.updatedAt;

/** Archived records get their last update time as `archivedAt`, like the SQL migration. */
function backfillArchivedAt(store: IDBObjectStore): void {
  store.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    const record: unknown = cursor.value;
    if (typeof record === 'object' && record !== null && !('archivedAt' in record)) {
      const { isArchived, updatedAt } = record as { isArchived?: unknown; updatedAt?: unknown };
      cursor.update({ ...record, archivedAt: isArchived === true ? updatedAt : null });
    }
    cursor.continue();
  };
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(STORES.categories, { keyPath: 'id' });
        db.createObjectStore(STORES.folders, { keyPath: 'id' });
        db.createObjectStore(STORES.notes, { keyPath: 'id' });
        db.createObjectStore(STORES.noteContents, { keyPath: 'noteId' });
        db.createObjectStore(STORES.outbox, { keyPath: 'id', autoIncrement: true });
        db.createObjectStore(STORES.tombstones, { keyPath: 'entityId' });
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (event.oldVersion >= 1 && event.oldVersion < 3 && req.transaction) {
        for (const name of [STORES.folders, STORES.notes]) backfillArchivedAt(req.transaction.objectStore(name));
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('ERR_STORAGE', req.error?.message ?? 'Cannot open IndexedDB.'));
  });
}

/** One IndexedDB transaction: every read and write inside commits or aborts together. */
class Tx {
  readonly #tx: IDBTransaction;

  constructor(tx: IDBTransaction) {
    this.#tx = tx;
  }

  #store(name: StoreName): IDBObjectStore {
    return this.#tx.objectStore(name);
  }

  get<T>(name: StoreName, key: IDBValidKey, guard: (value: unknown) => value is T): Promise<T | undefined> {
    return request(this.#store(name).get(key), optional(guard));
  }

  getAll<T>(name: StoreName, guard: (value: unknown) => value is T): Promise<T[]> {
    return request(this.#store(name).getAll(), all(guard));
  }

  async put(name: StoreName, value: object): Promise<void> {
    await request(this.#store(name).put(value), anything);
  }

  /** Fails with ERR_STORAGE if the key already exists, like a primary-key violation in SQLite. */
  async add(name: StoreName, value: object): Promise<IDBValidKey> {
    return request(this.#store(name).add(value), (v): v is IDBValidKey => v !== undefined);
  }

  async delete(name: StoreName, key: IDBValidKey): Promise<void> {
    await request(this.#store(name).delete(key), anything);
  }

  async folderMap(): Promise<Map<FolderId, Folder>> {
    const folders = await this.getAll(STORES.folders, isFolder);
    return new Map(folders.map((f) => [f.id, f]));
  }

  async requireNote(id: NoteId): Promise<Note> {
    const note = await this.get(STORES.notes, id, isNote);
    if (!note) throw notFound('Note');
    return note;
  }

  async requireCategory(id: CategoryId): Promise<Category> {
    const category = await this.get(STORES.categories, id, isCategory);
    if (!category) throw notFound('Category');
    return category;
  }

  async requireFolder(id: FolderId): Promise<Folder> {
    const folder = await this.get(STORES.folders, id, isFolder);
    if (!folder) throw notFound('Folder');
    return folder;
  }

  /** The folder and every folder below it, plus all folders and notes for in-memory filtering. */
  async subtree(id: FolderId): Promise<{ ids: Set<FolderId>; folders: Folder[]; notes: Note[] }> {
    const folders = await this.getAll(STORES.folders, isFolder);
    const notes = await this.getAll(STORES.notes, isNote);
    return { ids: new Set([id, ...descendantFolderIds(folders, id)]), folders, notes };
  }

  async requireWritableFolder(id: FolderId): Promise<Folder> {
    const folder = await this.get(STORES.folders, id, isFolder);
    if (!folder) throw notFound('Folder');
    if (folder.deletedAt !== null) {
      throw new StorageError('ERR_READ_ONLY_TRASHED_ENTITY', 'Items in Trash are read-only.');
    }
    return folder;
  }

  async tombstone(entityId: string, entityType: Tombstone['entityType'], purgedAt: EpochMs): Promise<void> {
    const record: Tombstone = { entityId, entityType, purgedAt };
    await this.put(STORES.tombstones, record);
  }
}

const rejectSystemCategory = (id: CategoryId | null): void => {
  if (id !== null && isSystemCategoryId(id)) {
    throw new StorageError('ERR_SYSTEM_CATEGORY_IMMUTABLE', 'System categories are views and cannot be modified.');
  }
};

/**
 * Browser storage on IndexedDB, enforcing the same rules as the desktop SQLite host. Each vault
 * has its own database (see `WebVaultDirectory`).
 */
export class WebIndexedDbAdapter implements IStorageEngine {
  readonly #db: Promise<IDBDatabase>;
  readonly #now: () => EpochMs;

  constructor(
    factory: IDBFactory = indexedDB,
    now: () => EpochMs = () => Date.now() as EpochMs,
    name: string = LEGACY_DB_NAME,
  ) {
    this.#db = openDatabase(factory, name);
    this.#now = now;
  }

  /** Closes the connection; the adapter must not be used afterwards. */
  async close(): Promise<void> {
    (await this.#db).close();
  }

  async #run<T>(stores: StoreName[], mode: IDBTransactionMode, work: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = (await this.#db).transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new StorageError('ERR_STORAGE', tx.error?.message ?? 'Transaction aborted.'));
    });
    try {
      const result = await work(new Tx(tx));
      await done;
      return result;
    } catch (error) {
      done.catch(() => undefined);
      if (!tx.error) {
        try {
          tx.abort();
        } catch {
          // Already finished; nothing to roll back.
        }
      }
      throw error instanceof StorageError ? error : new StorageError('ERR_STORAGE', String(error));
    }
  }

  /** Applies a lifecycle action through the core reducer and persists the result. */
  async #transition(tx: Tx, note: Note, action: NoteAction): Promise<NoteTransition> {
    const transition = unwrap(transitionNote(note, action));
    if (transition.kind === 'saved') await tx.put(STORES.notes, transition.note);
    if (transition.kind === 'purged') {
      await tx.delete(STORES.notes, note.id);
      await tx.delete(STORES.noteContents, note.id);
      await tx.tombstone(note.id, 'note', this.#now());
    }
    return transition;
  }

  async #savedNote(id: NoteId, action: (note: Note) => NoteAction, extraStores: StoreName[] = []): Promise<Note> {
    return this.#run([STORES.notes, ...extraStores], 'readwrite', async (tx) => {
      const note = await tx.requireNote(id);
      const transition = await this.#transition(tx, note, action(note));
      return transition.kind === 'saved' ? transition.note : note;
    });
  }

  // Categories

  listCategories(): Promise<Category[]> {
    return this.#run([STORES.categories], 'readonly', async (tx) =>
      (await tx.getAll(STORES.categories, isCategory)).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
      ),
    );
  }

  async createCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category> {
    rejectSystemCategory(id);
    return this.#run([STORES.categories], 'readwrite', async (tx) => {
      const existing = await tx.getAll(STORES.categories, isCategory);
      const now = this.#now();
      const category: Category = {
        id,
        isSystem: false,
        sortOrder: existing.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1,
        nameCiphertext,
        createdAt: now,
        updatedAt: now,
      };
      await tx.add(STORES.categories, category);
      return category;
    });
  }

  async renameCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category> {
    rejectSystemCategory(id);
    return this.#run([STORES.categories], 'readwrite', async (tx) => {
      const category: Category = { ...(await tx.requireCategory(id)), nameCiphertext, updatedAt: this.#now() };
      await tx.put(STORES.categories, category);
      return category;
    });
  }

  async deleteCategory(id: CategoryId): Promise<void> {
    rejectSystemCategory(id);
    return this.#run(
      [STORES.categories, STORES.folders, STORES.notes, STORES.tombstones],
      'readwrite',
      async (tx) => {
        await tx.requireCategory(id);
        await tx.delete(STORES.categories, id);
        // Mirrors SQLite's ON DELETE SET NULL.
        for (const folder of await tx.getAll(STORES.folders, isFolder)) {
          if (folder.categoryId === id) await tx.put(STORES.folders, { ...folder, categoryId: null });
        }
        for (const note of await tx.getAll(STORES.notes, isNote)) {
          if (note.categoryId === id) await tx.put(STORES.notes, { ...note, categoryId: null });
        }
        await tx.tombstone(id, 'category', this.#now());
      },
    );
  }

  // Folders

  listFolders(): Promise<Folder[]> {
    return this.#run([STORES.folders], 'readonly', async (tx) =>
      (await tx.getAll(STORES.folders, isFolder))
        .filter((f) => f.deletedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  createFolder({ id, parentId, categoryId, nameCiphertext }: NewFolder): Promise<Folder> {
    return this.#run([STORES.folders, STORES.categories], 'readwrite', async (tx) => {
      let category = categoryId;
      if (parentId !== null) {
        category = (await tx.requireWritableFolder(parentId)).categoryId;
        unwrap(validateFolderCreate(await tx.folderMap(), parentId));
      } else if (categoryId !== null) {
        rejectSystemCategory(categoryId);
        await tx.requireCategory(categoryId);
      }
      const now = this.#now();
      const folder: Folder = {
        id,
        categoryId: category,
        parentId,
        nameCiphertext,
        isArchived: false,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.add(STORES.folders, folder);
      return folder;
    });
  }

  moveFolder(id: FolderId, newParentId: FolderId | null): Promise<Folder> {
    return this.#run([STORES.folders], 'readwrite', async (tx) => {
      const folder = await tx.requireWritableFolder(id);
      if (newParentId !== null) await tx.requireWritableFolder(newParentId);
      unwrap(validateFolderMove(await tx.folderMap(), id, newParentId));
      const moved: Folder = { ...folder, parentId: newParentId, updatedAt: this.#now() };
      await tx.put(STORES.folders, moved);
      return moved;
    });
  }

  renameFolder(id: FolderId, nameCiphertext: Ciphertext): Promise<Folder> {
    return this.#run([STORES.folders], 'readwrite', async (tx) => {
      const renamed: Folder = { ...(await tx.requireWritableFolder(id)), nameCiphertext, updatedAt: this.#now() };
      await tx.put(STORES.folders, renamed);
      return renamed;
    });
  }

  listTrashedFolders(): Promise<Folder[]> {
    return this.#run([STORES.folders], 'readonly', async (tx) =>
      (await tx.getAll(STORES.folders, isFolder))
        .filter((f) => f.deletedAt !== null)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    );
  }

  archiveFolder(id: FolderId): Promise<Folder> {
    return this.#setFolderArchived(id, true);
  }

  unarchiveFolder(id: FolderId): Promise<Folder> {
    return this.#setFolderArchived(id, false);
  }

  #setFolderArchived(id: FolderId, archived: boolean): Promise<Folder> {
    return this.#run([STORES.folders, STORES.notes], 'readwrite', async (tx) => {
      const folder = await tx.requireFolder(id);
      const parent = folder.parentId === null ? null : ((await tx.get(STORES.folders, folder.parentId, isFolder)) ?? null);
      unwrap(checkFolderArchive(folder, archived, parent));
      const now = this.#now();
      const { ids, folders, notes } = await tx.subtree(id);
      // Archive stamps one archivedAt on not-yet-archived items; unarchive clears only that stamp,
      // so items archived on their own stay archived.
      const affected = (item: { isArchived: boolean; archivedAt: EpochMs | null; deletedAt: EpochMs | null }): boolean =>
        item.deletedAt === null && (archived ? !item.isArchived : item.isArchived && item.archivedAt === folder.archivedAt);
      const change = { isArchived: archived, archivedAt: archived ? now : null, updatedAt: now };
      for (const f of folders) {
        if (ids.has(f.id) && affected(f)) await tx.put(STORES.folders, { ...f, ...change });
      }
      for (const n of notes) {
        if (n.folderId !== null && ids.has(n.folderId) && affected(n)) await tx.put(STORES.notes, { ...n, ...change });
      }
      return tx.requireFolder(id);
    });
  }

  trashFolder(id: FolderId): Promise<Folder> {
    return this.#run([STORES.folders, STORES.notes], 'readwrite', async (tx) => {
      unwrap(checkFolderTrash(await tx.requireFolder(id)));
      const now = this.#now();
      const { ids, folders, notes } = await tx.subtree(id);
      for (const f of folders) {
        if (ids.has(f.id) && f.deletedAt === null) await tx.put(STORES.folders, { ...f, deletedAt: now, updatedAt: now });
      }
      for (const n of notes) {
        if (n.folderId !== null && ids.has(n.folderId) && n.deletedAt === null) {
          await tx.put(STORES.notes, { ...n, deletedAt: now, updatedAt: now });
        }
      }
      return tx.requireFolder(id);
    });
  }

  restoreFolder(id: FolderId): Promise<Folder> {
    return this.#run([STORES.folders, STORES.notes, STORES.categories], 'readwrite', async (tx) => {
      const folder = await tx.requireFolder(id);
      const parent = folder.parentId === null ? undefined : await tx.get(STORES.folders, folder.parentId, isFolder);
      const categoryExists =
        folder.categoryId !== null && (await tx.get(STORES.categories, folder.categoryId, isCategory)) !== undefined;
      const placement = unwrap(planFolderRestore(folder, parent !== undefined && parent.deletedAt === null, categoryExists));
      const trashedAt = folder.deletedAt;
      const now = this.#now();
      const { ids, folders, notes } = await tx.subtree(id);
      for (const f of folders) {
        if (!ids.has(f.id) || f.deletedAt !== trashedAt) continue;
        const restored: Folder = { ...f, deletedAt: null, updatedAt: now };
        await tx.put(STORES.folders, f.id === id ? { ...restored, ...placement } : restored);
      }
      for (const n of notes) {
        if (n.folderId !== null && ids.has(n.folderId) && n.deletedAt === trashedAt) {
          await tx.put(STORES.notes, { ...n, deletedAt: null, updatedAt: now });
        }
      }
      return tx.requireFolder(id);
    });
  }

  purgeFolder(id: FolderId): Promise<PurgedEntities> {
    return this.#run([STORES.folders, STORES.notes, STORES.noteContents, STORES.tombstones], 'readwrite', async (tx) => {
      unwrap(checkFolderPurge(await tx.requireFolder(id)));
      const before = await tx.subtree(id);
      const trashed = new Set(before.folders.filter((f) => f.deletedAt !== null).map((f) => f.id));
      // Live leftovers under trashed folders move to the root instead of being purged.
      for (const f of before.folders) {
        if (before.ids.has(f.id) && f.deletedAt === null && f.parentId !== null && trashed.has(f.parentId)) {
          await tx.put(STORES.folders, { ...f, parentId: null });
        }
      }
      for (const n of before.notes) {
        if (n.folderId !== null && before.ids.has(n.folderId) && n.deletedAt === null && trashed.has(n.folderId)) {
          await tx.put(STORES.notes, { ...n, folderId: null });
        }
      }
      const { ids, notes } = await tx.subtree(id);
      const purgedNotes = notes.filter((n) => n.folderId !== null && ids.has(n.folderId)).map((n) => n.id);
      const now = this.#now();
      for (const noteId of purgedNotes) {
        await tx.delete(STORES.notes, noteId);
        await tx.delete(STORES.noteContents, noteId);
        await tx.tombstone(noteId, 'note', now);
      }
      for (const folderId of ids) {
        await tx.delete(STORES.folders, folderId);
        await tx.tombstone(folderId, 'folder', now);
      }
      return { folders: [...ids], notes: purgedNotes };
    });
  }

  // Notes

  createNote(id: NoteId): Promise<Note> {
    return this.#run([STORES.notes], 'readwrite', async (tx) => {
      const note = unwrap(transitionNote(null, { type: 'CREATE_TAB', id, now: this.#now() }));
      if (note.kind !== 'saved') throw new StorageError('ERR_STORAGE', 'CREATE_TAB did not produce a note.');
      await tx.add(STORES.notes, note.note);
      return note.note;
    });
  }

  getNote(id: NoteId): Promise<Note | null> {
    return this.#run([STORES.notes], 'readonly', async (tx) => (await tx.get(STORES.notes, id, isNote)) ?? null);
  }

  listNotes(folderId: FolderId | null): Promise<Note[]> {
    return this.#run([STORES.notes], 'readonly', async (tx) =>
      (await tx.getAll(STORES.notes, isNote))
        .filter((n) => n.folderId === folderId && n.deletedAt === null)
        .sort(byUpdatedDesc),
    );
  }

  listTrashedNotes(): Promise<Note[]> {
    return this.#run([STORES.notes], 'readonly', async (tx) =>
      (await tx.getAll(STORES.notes, isNote)).filter((n) => n.deletedAt !== null).sort(byUpdatedDesc),
    );
  }

  async moveNote(id: NoteId, folderId: FolderId | null, categoryId: CategoryId | null): Promise<Note> {
    rejectSystemCategory(categoryId);
    return this.#run([STORES.notes, STORES.folders, STORES.categories], 'readwrite', async (tx) => {
      const note = await tx.requireNote(id);
      const action: NoteAction = { type: 'ASSIGN_HIERARCHY', folderId, categoryId, now: this.#now() };
      // Validate the note's own state before its targets, matching the desktop host.
      unwrap(transitionNote(note, action));
      if (folderId !== null) await tx.requireWritableFolder(folderId);
      if (categoryId !== null) await tx.requireCategory(categoryId);
      const transition = await this.#transition(tx, note, action);
      return transition.kind === 'saved' ? transition.note : note;
    });
  }

  setNoteArchived(id: NoteId, archived: boolean): Promise<Note> {
    return this.#savedNote(id, () => ({ type: archived ? 'ARCHIVE' : 'UNARCHIVE', now: this.#now() }));
  }

  trashNote(id: NoteId): Promise<Note> {
    return this.#savedNote(id, () => ({ type: 'DELETE', now: this.#now() }));
  }

  restoreNote(id: NoteId): Promise<Note> {
    return this.#run([STORES.notes, STORES.folders, STORES.categories], 'readwrite', async (tx) => {
      const note = await tx.requireNote(id);
      // A purged or trashed folder can't hold a live note: fall back to the root (BR-LIFE-05).
      const folder = note.folderId === null ? undefined : await tx.get(STORES.folders, note.folderId, isFolder);
      const folderExists = note.folderId === null || (folder !== undefined && folder.deletedAt === null);
      const categoryExists =
        note.categoryId === null || (await tx.get(STORES.categories, note.categoryId, isCategory)) !== undefined;
      const transition = await this.#transition(tx, note, {
        type: 'RESTORE',
        now: this.#now(),
        folderExists,
        categoryExists,
      });
      return transition.kind === 'saved' ? transition.note : note;
    });
  }

  async purgeNote(id: NoteId): Promise<void> {
    await this.#savedNote(id, () => ({ type: 'PURGE' }), [STORES.noteContents, STORES.tombstones]);
  }

  async discardEphemeralNote(id: NoteId): Promise<void> {
    await this.#savedNote(id, () => ({ type: 'CLOSE_TAB', isEmptyAndUnmodified: true }), [
      STORES.noteContents,
      STORES.tombstones,
    ]);
  }

  getNoteContent(noteId: NoteId): Promise<NoteContent | null> {
    return this.#run(
      [STORES.noteContents],
      'readonly',
      async (tx) => (await tx.get(STORES.noteContents, noteId, isNoteContent)) ?? null,
    );
  }

  async saveNoteContent(content: NoteContent): Promise<void> {
    await this.#run([STORES.notes, STORES.noteContents], 'readwrite', async (tx) => {
      const note = await tx.requireNote(content.noteId);
      await this.#transition(tx, note, { type: 'EDIT_CONTENT', now: content.updatedAt });
      await tx.put(STORES.noteContents, content);
    });
  }

  // Sync outbox

  enqueueOutbox(entry: NewOutboxEntry): Promise<SyncOutboxEntry> {
    return this.#run([STORES.outbox], 'readwrite', async (tx) => {
      const record = { ...entry, createdAt: this.#now() };
      // `add` assigns the auto-increment key.
      const key = await tx.add(STORES.outbox, record);
      if (!isKey(key)) throw new StorageError('ERR_STORAGE', 'Outbox key is not numeric.');
      return { ...record, id: key };
    });
  }

  listOutbox(limit: number): Promise<SyncOutboxEntry[]> {
    return this.#run([STORES.outbox], 'readonly', async (tx) =>
      (await tx.getAll(STORES.outbox, isOutboxEntry)).sort((a, b) => a.id - b.id).slice(0, limit),
    );
  }

  deleteOutbox(ids: readonly number[]): Promise<void> {
    return this.#run([STORES.outbox], 'readwrite', async (tx) => {
      for (const id of ids) await tx.delete(STORES.outbox, id);
    });
  }

  // Settings

  getTrashRetentionDays(): Promise<number> {
    return this.#run([STORES.settings], 'readonly', async (tx) => {
      const record = await tx.get(STORES.settings, RETENTION_KEY, isSetting);
      const stored = typeof record?.value === 'number' ? validateRetentionDays(record.value) : null;
      return stored?.ok ? stored.value : DEFAULT_RETENTION_DAYS;
    });
  }

  getVaultHeader(): Promise<string | null> {
    return this.#run([STORES.settings], 'readonly', async (tx) => {
      const record = await tx.get(STORES.settings, VAULT_HEADER_KEY, isSetting);
      return typeof record?.value === 'string' ? record.value : null;
    });
  }

  getVaultName(): Promise<Ciphertext | null> {
    return this.#run([STORES.settings], 'readonly', async (tx) => {
      const record = await tx.get(STORES.settings, VAULT_NAME_KEY, isSetting);
      return typeof record?.value === 'string' ? (record.value as Ciphertext) : null;
    });
  }

  /** Writes a new vault's header and encrypted name together; the header is written only once. */
  initializeVault(header: string, nameCiphertext: Ciphertext): Promise<void> {
    return this.#run([STORES.settings], 'readwrite', async (tx) => {
      if (await tx.get(STORES.settings, VAULT_HEADER_KEY, isSetting)) {
        throw new StorageError('ERR_INVALID_SETTING', 'The vault is already initialized.');
      }
      await tx.put(STORES.settings, { key: VAULT_HEADER_KEY, value: header });
      await tx.put(STORES.settings, { key: VAULT_NAME_KEY, value: nameCiphertext });
    });
  }

  async setTrashRetentionDays(days: number): Promise<number> {
    const valid = unwrap(validateRetentionDays(days));
    return this.#run([STORES.settings], 'readwrite', async (tx) => {
      await tx.put(STORES.settings, { key: RETENTION_KEY, value: valid });
      return valid;
    });
  }
}
