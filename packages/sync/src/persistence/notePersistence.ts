import * as Y from 'yjs';
import { MAX_NOTE_PLAINTEXT_BYTES, type Bytes, type EpochMs, type NoteContent, type NoteId } from '@ankylock/core';
import { createTextCodec, type Sealer } from '@ankylock/crypto';
import { StorageError, type IStorageEngine } from '@ankylock/storage';
import { TEXT_FIELD } from '../crdt/docManager.js';

export interface NotePersistenceDeps {
  readonly storage: IStorageEngine;
  readonly sealer: Sealer;
  readonly now?: () => EpochMs;
}

const encoder = new TextEncoder();

/** Decrypts a note's stored Yjs state, or undefined when nothing was saved yet. */
export async function loadNoteState(deps: NotePersistenceDeps, noteId: NoteId): Promise<Bytes | undefined> {
  const content = await deps.storage.getNoteContent(noteId);
  return content ? deps.sealer.open(content.yjsUpdates) : undefined;
}

/**
 * Saves the full doc encrypted: the Yjs state (which contains the text), a plaintext snapshot
 * for export, and the title, each sealed separately. Only the state vector, which holds clock
 * metadata and no text, is stored in the clear. Rejects notes over 10 MB (BR-NOTE-04).
 */
export async function saveNoteState(
  deps: NotePersistenceDeps,
  noteId: NoteId,
  doc: Y.Doc,
  title: string | null,
): Promise<void> {
  const plaintext = encoder.encode(doc.getText(TEXT_FIELD).toString());
  if (plaintext.length > MAX_NOTE_PLAINTEXT_BYTES) {
    throw new StorageError('ERR_NOTE_TOO_LARGE', 'Notes are limited to 10 MB.');
  }
  const content: NoteContent = {
    noteId,
    titleCiphertext: await createTextCodec(deps.sealer).encrypt(title ?? ''),
    contentCiphertext: await deps.sealer.seal(plaintext),
    yjsStateVector: new Uint8Array(Y.encodeStateVector(doc)),
    yjsUpdates: await deps.sealer.seal(new Uint8Array(Y.encodeStateAsUpdate(doc))),
    updatedAt: deps.now?.() ?? (Date.now() as EpochMs),
  };
  await deps.storage.saveNoteContent(content);
}

export interface DocPersister {
  /** Saves pending changes now; resolves once everything so far is stored. */
  flush(): Promise<void>;
  /** Stops watching after a final flush. */
  dispose(): Promise<void>;
}

/**
 * Persists every change to the doc, local or remote, within `delayMs` (BR-NOTE-01: scratchpads
 * save without any dialog). Saves for one note never overlap, so the newest state always wins.
 */
export function persistDoc(
  noteId: NoteId,
  doc: Y.Doc,
  deps: NotePersistenceDeps & {
    readonly title: () => string | null;
    readonly onError: (error: unknown) => void;
    readonly delayMs?: number;
  },
): DocPersister {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return saving;
    dirty = false;
    saving = saving.then(() => saveNoteState(deps, noteId, doc, deps.title()).catch(deps.onError));
    return saving;
  };

  const onUpdate = (): void => {
    dirty = true;
    timer ??= setTimeout(() => void flush(), deps.delayMs ?? 500);
  };
  doc.on('update', onUpdate);

  return {
    flush,
    dispose() {
      doc.off('update', onUpdate);
      return flush();
    },
  };
}
