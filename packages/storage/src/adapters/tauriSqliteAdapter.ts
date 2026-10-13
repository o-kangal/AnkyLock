import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  ERROR_CODES,
  validateRetentionDays,
  type Category,
  type CategoryId,
  type Ciphertext,
  type ErrorCode,
  type Folder,
  type FolderId,
  type Note,
  type NoteContent,
  type NoteId,
  type SyncOutboxEntry,
} from '@ankylock/core';
import { base64ToBytes, bytesToBase64 } from '@ankylock/crypto';
import { arrayOf, isCategory, isFolder, isNote, isNull, isNumber, isString, isSyncEntityType, shape } from '../guards.js';
import { StorageError, type IStorageEngine, type NewFolder, type NewOutboxEntry } from '../interfaces/IStorageEngine.js';

/** Signature of Tauri's `invoke`; injectable for tests. Argument keys are camelCase. */
export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** IPC form of byte fields: base64 strings (see `b64.rs` in the desktop crate). */
interface WireNoteContent {
  readonly noteId: string;
  readonly titleCiphertext: string;
  readonly contentCiphertext: string;
  readonly yjsStateVector: string;
  readonly yjsUpdates: string;
  readonly updatedAt: number;
}

interface WireOutboxEntry {
  readonly id: number;
  readonly entityId: string;
  readonly entityType: string;
  readonly encryptedPayload: string;
  readonly createdAt: number;
}

const isWireNoteContent = shape<WireNoteContent>({
  noteId: isString,
  titleCiphertext: isString,
  contentCiphertext: isString,
  yjsStateVector: isString,
  yjsUpdates: isString,
  updatedAt: isNumber,
});

const isWireOutboxEntry = shape<WireOutboxEntry>({
  id: isNumber,
  entityId: isString,
  entityType: isSyncEntityType,
  encryptedPayload: isString,
  createdAt: isNumber,
});

const isAppError = shape<{ code: ErrorCode; message: string }>({
  code: (v) => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v),
  message: isString,
});

const isWholeNumber = (v: unknown): v is number => Number.isInteger(v);

function toStorageError(error: unknown): StorageError {
  if (isAppError(error)) return new StorageError(error.code, error.message);
  return new StorageError('ERR_STORAGE', typeof error === 'string' ? error : 'IPC call failed.');
}

const fromWireContent = (wire: WireNoteContent): NoteContent =>
  ({
    ...wire,
    contentCiphertext: base64ToBytes(wire.contentCiphertext),
    yjsStateVector: base64ToBytes(wire.yjsStateVector),
    yjsUpdates: base64ToBytes(wire.yjsUpdates),
  }) as NoteContent;

const fromWireOutbox = (wire: WireOutboxEntry): SyncOutboxEntry =>
  ({ ...wire, encryptedPayload: base64ToBytes(wire.encryptedPayload) }) as SyncOutboxEntry;

/** Desktop storage: every call is an IPC command backed by SQLite in the Rust host. */
export class TauriSqliteAdapter implements IStorageEngine {
  readonly #invoke: Invoke;

  constructor(invoke: Invoke = tauriInvoke) {
    this.#invoke = invoke;
  }

  async #call<T>(command: string, args: Record<string, unknown>, guard: (value: unknown) => value is T): Promise<T> {
    let raw: unknown;
    try {
      raw = await this.#invoke(command, args);
    } catch (error) {
      throw toStorageError(error);
    }
    if (!guard(raw)) throw new StorageError('ERR_STORAGE', `Unexpected response from ${command}.`);
    return raw;
  }

  listCategories(): Promise<Category[]> {
    return this.#call('category_list', {}, arrayOf(isCategory));
  }

  createCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category> {
    return this.#call('category_create', { id, nameCiphertext }, isCategory);
  }

  renameCategory(id: CategoryId, nameCiphertext: Ciphertext): Promise<Category> {
    return this.#call('category_rename', { id, nameCiphertext }, isCategory);
  }

  async deleteCategory(id: CategoryId): Promise<void> {
    await this.#call('category_delete', { id }, isNull);
  }

  listFolders(): Promise<Folder[]> {
    return this.#call('folder_list', {}, arrayOf(isFolder));
  }

  createFolder(folder: NewFolder): Promise<Folder> {
    return this.#call('folder_create', { ...folder }, isFolder);
  }

  moveFolder(id: FolderId, newParentId: FolderId | null): Promise<Folder> {
    return this.#call('folder_move', { id, newParentId }, isFolder);
  }

  renameFolder(id: FolderId, nameCiphertext: Ciphertext): Promise<Folder> {
    return this.#call('folder_rename', { id, nameCiphertext }, isFolder);
  }

  createNote(id: NoteId): Promise<Note> {
    return this.#call('note_create', { id }, isNote);
  }

  getNote(id: NoteId): Promise<Note | null> {
    return this.#call('note_get', { id }, (v): v is Note | null => v === null || isNote(v));
  }

  listNotes(folderId: FolderId | null): Promise<Note[]> {
    return this.#call('note_list', { folderId }, arrayOf(isNote));
  }

  listTrashedNotes(): Promise<Note[]> {
    return this.#call('note_list_trashed', {}, arrayOf(isNote));
  }

  moveNote(id: NoteId, folderId: FolderId | null, categoryId: CategoryId | null): Promise<Note> {
    return this.#call('note_move', { id, folderId, categoryId }, isNote);
  }

  setNoteArchived(id: NoteId, archived: boolean): Promise<Note> {
    return this.#call('note_set_archived', { id, archived }, isNote);
  }

  trashNote(id: NoteId): Promise<Note> {
    return this.#call('note_trash', { id }, isNote);
  }

  restoreNote(id: NoteId): Promise<Note> {
    return this.#call('note_restore', { id }, isNote);
  }

  async purgeNote(id: NoteId): Promise<void> {
    await this.#call('note_purge', { id }, isNull);
  }

  async discardEphemeralNote(id: NoteId): Promise<void> {
    await this.#call('note_discard_ephemeral', { id }, isNull);
  }

  async getNoteContent(noteId: NoteId): Promise<NoteContent | null> {
    const wire = await this.#call(
      'note_get_content',
      { noteId },
      (v): v is WireNoteContent | null => v === null || isWireNoteContent(v),
    );
    return wire === null ? null : fromWireContent(wire);
  }

  async saveNoteContent(content: NoteContent): Promise<void> {
    const wire: WireNoteContent = {
      ...content,
      contentCiphertext: bytesToBase64(content.contentCiphertext),
      yjsStateVector: bytesToBase64(content.yjsStateVector),
      yjsUpdates: bytesToBase64(content.yjsUpdates),
    };
    await this.#call('note_save_content', { content: wire }, isNull);
  }

  async enqueueOutbox(entry: NewOutboxEntry): Promise<SyncOutboxEntry> {
    const wire = { ...entry, encryptedPayload: bytesToBase64(entry.encryptedPayload) };
    return fromWireOutbox(await this.#call('outbox_enqueue', { entry: wire }, isWireOutboxEntry));
  }

  async listOutbox(limit: number): Promise<SyncOutboxEntry[]> {
    return (await this.#call('outbox_list', { limit }, arrayOf(isWireOutboxEntry))).map(fromWireOutbox);
  }

  async deleteOutbox(ids: readonly number[]): Promise<void> {
    await this.#call('outbox_delete', { ids: [...ids] }, isNull);
  }

  getTrashRetentionDays(): Promise<number> {
    return this.#call('settings_get_retention_days', {}, isWholeNumber);
  }

  async setTrashRetentionDays(days: number): Promise<number> {
    // Validate here too: the host takes a u32, so -1 or 1.5 would fail as an untyped IPC error.
    const valid = validateRetentionDays(days);
    if (!valid.ok) throw new StorageError(valid.error.code, valid.error.message);
    return this.#call('settings_set_retention_days', { days: valid.value }, isWholeNumber);
  }
}

