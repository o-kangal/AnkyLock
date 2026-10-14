import { IDBFactory } from 'fake-indexeddb';
import type { Ciphertext, EpochMs, NoteContent, NoteId, SealedBytes, VaultId } from '@ankylock/core';
import {
  WebIndexedDbAdapter,
  WebVaultDirectory,
  type IStorageEngine,
  type IVaultDirectory,
  type VaultEntry,
} from '@ankylock/storage';
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

/** Browser vault directory that also exposes the open vault's storage for assertions. */
export class TestVaults implements IVaultDirectory {
  readonly #inner: WebVaultDirectory;
  #storage: IStorageEngine | null = null;

  constructor(now?: () => EpochMs) {
    this.#inner = new WebVaultDirectory(new IDBFactory(), now);
  }

  get storage(): IStorageEngine {
    if (!this.#storage) throw new Error('No vault was opened yet.');
    return this.#storage;
  }

  list(): Promise<VaultEntry[]> {
    return this.#inner.list();
  }

  async create(id: VaultId, header: string, nameCiphertext: Ciphertext): Promise<IStorageEngine> {
    this.#storage = await this.#inner.create(id, header, nameCiphertext);
    return this.#storage;
  }

  async open(id: VaultId): Promise<IStorageEngine> {
    this.#storage = await this.#inner.open(id);
    return this.#storage;
  }
}
