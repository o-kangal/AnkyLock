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

  async create(id: VaultId, header: string, nameCiphertext: Ciphertext | null, createdAt?: EpochMs): Promise<IStorageEngine> {
    this.#storage = await this.#inner.create(id, header, nameCiphertext, createdAt);
    return this.#storage;
  }

  async open(id: VaultId): Promise<IStorageEngine> {
    this.#storage = await this.#inner.open(id);
    return this.#storage;
  }
}

/**
 * In-memory Google Drive appDataFolder behind `fetch`, covering the REST calls GoogleDriveClient
 * makes: list/find, media download, multipart create and media update.
 */
export class FakeDrive {
  readonly files = new Map<string, { name: string; data: Uint8Array; modifiedTime: number }>();
  #next = 0;

  names(): string[] {
    return [...this.files.values()].map((f) => f.name);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    const fileId = /\/files\/([^/?]+)$/.exec(url.pathname)?.[1];

    if (method === 'GET' && fileId !== undefined) {
      const file = this.files.get(decodeURIComponent(fileId));
      return file ? new Response(file.data.slice()) : new Response('not found', { status: 404 });
    }
    if (method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const exact = /^name = '(.*)' and trashed = false$/.exec(q)?.[1];
      const prefix = /^name contains '(.*)' and trashed = false$/.exec(q)?.[1];
      const matches = [...this.files.entries()]
        .filter(([, f]) => (exact !== undefined ? f.name === exact : f.name.includes(prefix ?? '')))
        .sort(([, a], [, b]) => b.modifiedTime - a.modifiedTime)
        .map(([id, f]) => ({ id, name: f.name, modifiedTime: new Date(f.modifiedTime).toISOString() }));
      return json({ files: matches });
    }
    if (method === 'PATCH' && fileId !== undefined) {
      const file = this.files.get(decodeURIComponent(fileId));
      if (!file) return new Response('not found', { status: 404 });
      file.data = new Uint8Array(init?.body as Uint8Array);
      file.modifiedTime = Date.now();
      return json({ id: fileId });
    }
    if (method === 'POST') {
      // Multipart body: metadata JSON part, then the raw file part. latin1 keeps byte offsets.
      const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes);
      const boundary = /boundary=(.+)$/.exec(new Headers(init?.headers).get('Content-Type') ?? '')?.[1] ?? '';
      const [, metaPart, dataPart] = text.split(`--${boundary}`);
      const metadata = JSON.parse((metaPart ?? '').split('\r\n\r\n')[1] ?? '{}') as { name: string };
      const dataStart = text.indexOf('\r\n\r\n', text.indexOf(dataPart ?? '')) + 4;
      const dataEnd = text.lastIndexOf(`\r\n--${boundary}--`);
      const id = `file-${++this.#next}`;
      this.files.set(id, { name: metadata.name, data: bytes.slice(dataStart, dataEnd), modifiedTime: Date.now() });
      return json({ id });
    }
    return new Response('unsupported', { status: 400 });
  };
}
