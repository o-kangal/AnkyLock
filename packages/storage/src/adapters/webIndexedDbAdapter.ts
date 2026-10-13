import {
  isSystemCategoryId,
  transitionNote,
  validateFolderCreate,
  validateFolderMove,
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
  type Result,
  type SyncOutboxEntry,
} from '@ankylock/core';
import { isCategory, isFolder, isNote, isNoteContent, isOutboxEntry } from '../guards.js';
import { StorageError, type IStorageEngine, type NewFolder, type NewOutboxEntry } from '../interfaces/IStorageEngine.js';

const DB_NAME = 'ankylock';
const DB_VERSION = 1;

const STORES = {
  categories: 'categories',
  folders: 'folders',
  notes: 'notes',
  noteContents: 'note_contents',
  outbox: 'sync_outbox',
  tombstones: 'sync_tombstones',
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

const anything = (_value: unknown): _value is unknown => true;
const isKey = (value: unknown): value is number => typeof value === 'number';

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) throw new StorageError(result.error.code, result.error.message);
  return result.value;
}

const notFound = (entity: string): StorageError => new StorageError('ERR_NOT_FOUND', `${entity} not found.`);

const byUpdatedDesc = (a: Note, b: Note): number => b.updatedAt - a.updatedAt;

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(STORES.categories, { keyPath: 'id' });
      db.createObjectStore(STORES.folders, { keyPath: 'id' });
      db.createObjectStore(STORES.notes, { keyPath: 'id' });
      db.createObjectStore(STORES.noteContents, { keyPath: 'noteId' });
      db.createObjectStore(STORES.outbox, { keyPath: 'id', autoIncrement: true });
      db.createObjectStore(STORES.tombstones, { keyPath: 'entityId' });
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

/** Browser storage on IndexedDB, enforcing the same rules as the desktop SQLite host. */
export class WebIndexedDbAdapter implements IStorageEngine {
  readonly #db: Promise<IDBDatabase>;
  readonly #now: () => EpochMs;

  constructor(factory: IDBFactory = indexedDB, now: () => EpochMs = () => Date.now() as EpochMs) {
    this.#db = openDatabase(factory);
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
      // A trashed parent still exists; only a purged one triggers the root fallback (BR-LIFE-05).
      const folderExists = note.folderId === null || (await tx.get(STORES.folders, note.folderId, isFolder)) !== undefined;
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
}
