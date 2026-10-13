import * as Y from 'yjs';
import type { Bytes, NoteId } from '@ankylock/core';

/** Transaction origin for updates that came from peers or storage; such updates are never re-broadcast. */
export const REMOTE_ORIGIN = Symbol('ankylock.remote');

/** Name of the `Y.Text` holding a note body; the editor binds to the same field. */
export const TEXT_FIELD = 'content';

/**
 * Owns one headless `Y.Doc` per open note, independent of whether an editor is mounted.
 * Background tabs keep only this state; only the focused tab mounts an EditorView.
 */
export class DocManager {
  readonly #docs = new Map<NoteId, Y.Doc>();

  /** Returns the open doc, or creates it from persisted state (a decrypted Yjs update). */
  open(noteId: NoteId, state?: Bytes): Y.Doc {
    const existing = this.#docs.get(noteId);
    if (existing) return existing;
    const doc = new Y.Doc();
    if (state) Y.applyUpdate(doc, state, REMOTE_ORIGIN);
    this.#docs.set(noteId, doc);
    return doc;
  }

  get(noteId: NoteId): Y.Doc | undefined {
    return this.#docs.get(noteId);
  }

  openNoteIds(): NoteId[] {
    return [...this.#docs.keys()];
  }

  /**
   * Merges a decrypted peer update into an open doc. Returns false when the note is not open;
   * the caller then persists the update for when it is. Applying the same update twice is a no-op.
   */
  applyRemote(noteId: NoteId, update: Bytes): boolean {
    const doc = this.#docs.get(noteId);
    if (!doc) return false;
    Y.applyUpdate(doc, update, REMOTE_ORIGIN);
    return true;
  }

  /** Destroys the doc and returns its full state for persisting, or null if it was not open. */
  close(noteId: NoteId): Bytes | null {
    const doc = this.#docs.get(noteId);
    if (!doc) return null;
    const state = new Uint8Array(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    this.#docs.delete(noteId);
    return state;
  }

  dispose(): void {
    for (const doc of this.#docs.values()) doc.destroy();
    this.#docs.clear();
  }
}
