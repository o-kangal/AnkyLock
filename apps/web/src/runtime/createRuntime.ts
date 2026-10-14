import { createSignal, type Accessor } from 'solid-js';
import type * as Y from 'yjs';
import type { NoteId } from '@ankylock/core';
import {
  CryptoError,
  createTextCodec,
  createVaultKey,
  parseVaultHeader,
  serializeVaultHeader,
  type WorkerSealer,
} from '@ankylock/crypto';
import { StorageError, type IStorageEngine } from '@ankylock/storage';
import {
  DocManager,
  REMOTE_ORIGIN,
  TEXT_FIELD,
  loadNoteState,
  persistDoc,
  startRetentionWorker,
  type DocPersister,
  type RetentionWorker,
} from '@ankylock/sync';
import { createWorkspaceStore, type WorkspaceStore } from '../stores/workspaceStore.js';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export interface RuntimeOptions {
  readonly storage: IStorageEngine;
  /** Encryption runs in a Dedicated Web Worker; the app passes `createWorkerSealer(new Worker(...))`. */
  readonly sealer: WorkerSealer;
  readonly onError?: (message: string) => void;
}

export interface Runtime {
  readonly store: WorkspaceStore;
  readonly status: Accessor<VaultStatus>;
  /** Reads whether a vault exists; call once at startup. */
  init(): Promise<void>;
  /** First launch: derives the MEK from a new passphrase and stores the (non-secret) vault header. */
  createVault(passphrase: string): Promise<string | null>;
  /** Later launches; resolves with an error message, or null on success. */
  unlock(passphrase: string): Promise<string | null>;
  lock(): Promise<void>;
  /** Opens (or returns) the headless doc of a note and starts persisting it. */
  openDoc(noteId: NoteId): Promise<Y.Doc>;
  /** Closes docs of notes without an open tab, saving pending edits first. */
  retainDocs(noteIds: readonly NoteId[]): Promise<void>;
  /** Saves pending edits of every open note, e.g. before reloading into a new app version. */
  flush(): Promise<void>;
  /** True for a scratchpad whose text is empty and was never edited this session (SPEC §3 CLOSE_TAB). */
  isEmptyAndUnmodified(noteId: NoteId): boolean;
}

const message = (error: unknown): string =>
  error instanceof CryptoError || error instanceof StorageError || error instanceof Error ? error.message : String(error);

/**
 * Composition root shared by desktop and web: storage, the crypto worker, the vault key, the
 * workspace store, headless Y.Docs with encrypted persistence and the retention worker.
 * The MEK lives only as a non-extractable CryptoKey in memory and inside the crypto worker;
 * it is never written to disk, so every launch asks for the passphrase.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { storage, sealer } = options;
  const report = (error: unknown): void => options.onError?.(message(error));
  const vault = createVaultKey();
  const store = createWorkspaceStore({ storage, names: createTextCodec(sealer) });
  const docs = new DocManager();
  const persisters = new Map<NoteId, DocPersister>();
  const opening = new Map<NoteId, Promise<Y.Doc>>();
  const edited = new Set<NoteId>();
  const [status, setStatus] = createSignal<VaultStatus>('loading');
  let retention: RetentionWorker | null = null;

  async function start(): Promise<string | null> {
    await sealer.setKey(vault.getKey());
    const loaded = await store.load();
    if (!loaded.ok) return loaded.error.message;
    retention = startRetentionWorker({ storage, onError: report });
    setStatus('unlocked');
    return null;
  }

  async function closeDoc(noteId: NoteId): Promise<void> {
    await opening.get(noteId);
    await persisters.get(noteId)?.dispose();
    persisters.delete(noteId);
    docs.close(noteId);
    edited.delete(noteId);
  }

  return {
    store,
    status,

    async init() {
      setStatus((await storage.getVaultHeader()) === null ? 'uninitialized' : 'locked');
    },

    async createVault(passphrase) {
      try {
        const header = await vault.initialize(passphrase);
        await storage.setVaultHeader(serializeVaultHeader(header));
        return await start();
      } catch (error) {
        vault.lock();
        return message(error);
      }
    },

    async unlock(passphrase) {
      try {
        const header = await storage.getVaultHeader();
        if (header === null) return 'No vault exists yet.';
        await vault.unlock(passphrase, parseVaultHeader(header));
        return await start();
      } catch (error) {
        vault.lock();
        return message(error);
      }
    },

    async lock() {
      retention?.stop();
      retention = null;
      await Promise.all(docs.openNoteIds().map(closeDoc));
      await sealer.setKey(null);
      vault.lock();
      setStatus('locked');
    },

    openDoc(noteId) {
      const open = docs.get(noteId);
      if (open) return Promise.resolve(open);
      const pending = opening.get(noteId);
      if (pending) return pending;
      const loading = (async () => {
        const doc = docs.open(noteId, await loadNoteState({ storage, sealer }, noteId));
        doc.on('update', (_update: Uint8Array, origin: unknown) => {
          if (origin !== REMOTE_ORIGIN) edited.add(noteId);
        });
        persisters.set(
          noteId,
          persistDoc(noteId, doc, {
            storage,
            sealer,
            title: () => store.state.notes[noteId]?.title ?? null,
            onError: report,
          }),
        );
        return doc;
      })().finally(() => opening.delete(noteId));
      opening.set(noteId, loading);
      return loading;
    },

    async flush() {
      await Promise.all([...persisters.values()].map((persister) => persister.flush()));
    },

    async retainDocs(noteIds) {
      const keep = new Set(noteIds);
      await Promise.all(docs.openNoteIds().filter((id) => !keep.has(id)).map(closeDoc));
    },

    isEmptyAndUnmodified(noteId) {
      // A doc that was never opened may hold saved text, so only a loaded, empty one qualifies.
      const doc = docs.get(noteId);
      return doc !== undefined && !edited.has(noteId) && doc.getText(TEXT_FIELD).length === 0;
    },
  };
}
