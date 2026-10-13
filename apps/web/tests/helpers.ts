import { IDBFactory } from 'fake-indexeddb';
import type { Ciphertext, NoteContent, NoteId, SealedBytes } from '@ankylock/core';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import { createWorkspaceStore, type NameCodec } from '../src/index.js';

/** Reversible stand-in for the crypto worker; the store only needs encrypt/decrypt to round-trip. */
export const fakeCodec: NameCodec = {
  encrypt: async (plaintext) => `enc:${plaintext}` as Ciphertext,
  decrypt: async (ciphertext) => ciphertext.slice(4),
};

export function setup() {
  let n = 0;
  const storage = new WebIndexedDbAdapter(new IDBFactory());
  const store = createWorkspaceStore({ storage, names: fakeCodec, newId: () => `id-${++n}` });
  return { storage, store };
}

export function contentWithTitle(noteId: NoteId, title: string): NoteContent {
  return {
    noteId,
    titleCiphertext: `enc:${title}` as Ciphertext,
    contentCiphertext: new Uint8Array([1]) as SealedBytes,
    yjsStateVector: new Uint8Array([0]),
    yjsUpdates: new Uint8Array([2]) as SealedBytes,
    updatedAt: (Date.now() + 1000) as NoteContent['updatedAt'],
  };
}

export function expectOk(result: { ok: boolean; error?: { code: string; message: string } }): void {
  if (!result.ok) throw new Error(`Expected success, got ${result.error?.code}: ${result.error?.message}`);
}
