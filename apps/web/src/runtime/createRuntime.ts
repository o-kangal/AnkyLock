import { createSignal, type Accessor } from 'solid-js';
import type * as Y from 'yjs';
import type { EpochMs, NoteId } from '@ankylock/core';
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
  GoogleDriveClient,
  REMOTE_ORIGIN,
  TEXT_FIELD,
  createSnapshotScheduler,
  createSyncEngine,
  exportSnapshot,
  loadNoteState,
  persistDoc,
  startRetentionWorker,
  type AuthSession,
  type AuthState,
  type BackupStatus,
  type ConnectionStatus,
  type DeviceId,
  type DocPersister,
  type RetentionWorker,
  type SnapshotScheduler,
  type SocketLike,
  type SyncEngine,
} from '@ankylock/sync';
import { createWorkspaceStore, type PurgedItem, type WorkspaceStore } from '../stores/workspaceStore.js';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export interface RuntimeOptions {
  readonly storage: IStorageEngine;
  /** Encryption runs in a Dedicated Web Worker; the app passes `createWorkerSealer(new Worker(...))`. */
  readonly sealer: WorkerSealer;
  readonly onError?: (message: string) => void;
  /** Google session; without it the app is local-only (sync and backup stay off). */
  readonly auth?: AuthSession;
  /** Blind relay WebSocket URL, e.g. `ws://127.0.0.1:8787/ws`. */
  readonly relayUrl?: string;
  /** Test seams for the relay socket and Drive's HTTP client. */
  readonly createSocket?: (url: string, protocols: string[]) => SocketLike;
  readonly driveFetch?: typeof fetch;
}

/** Shown in the status bar; never blocks local work (SPEC §7). */
export interface SyncStatus {
  readonly auth: AuthState['kind'] | 'unavailable';
  readonly connection: ConnectionStatus | 'off';
  readonly backup: BackupStatus;
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
  readonly syncStatus: Accessor<SyncStatus>;
  /** Opens Google sign-in; resolves with an error message, or null on success. */
  signIn(): Promise<string | null>;
  signOut(): Promise<void>;
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
  const { storage, sealer, auth, relayUrl } = options;
  const report = (error: unknown): void => options.onError?.(message(error));
  const vault = createVaultKey();
  let engine: SyncEngine | null = null;
  let scheduler: SnapshotScheduler | null = null;
  let headerJson: string | null = null;
  /** Identifies this app instance in frames; the relay already never echoes to the sender. */
  const deviceId = crypto.randomUUID() as DeviceId;
  const announcePurged = (items: readonly PurgedItem[]): void => {
    for (const item of items) void engine?.submitTombstone(item.id, item.entityType).catch(report);
  };
  const store = createWorkspaceStore({ storage, names: createTextCodec(sealer), onPurged: announcePurged });
  const docs = new DocManager();
  const persisters = new Map<NoteId, DocPersister>();
  const opening = new Map<NoteId, Promise<Y.Doc>>();
  const edited = new Set<NoteId>();
  const [status, setStatus] = createSignal<VaultStatus>('loading');
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus>({
    auth: auth ? auth.state().kind : 'unavailable',
    connection: 'off',
    backup: { kind: 'never' },
  });
  const updateSync = (patch: Partial<SyncStatus>): void => {
    setSyncStatus((current) => ({ ...current, ...patch }));
  };
  let retention: RetentionWorker | null = null;

  // Remote edits can add or retitle notes; coalesce sidebar reloads.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadSoon = (): void => {
    reloadTimer ??= setTimeout(() => {
      reloadTimer = undefined;
      void store.load();
    }, 300);
  };

  function startSync(): void {
    if (engine || !auth || !relayUrl || status() !== 'unlocked' || auth.state().kind !== 'signed-in') return;
    const next = createSyncEngine({
      storage,
      sealer,
      docs,
      deviceId,
      relayUrl,
      getIdToken: () => auth.idToken(),
      onRemoteChange: reloadSoon,
      onStatusChange: (connection) => updateSync({ connection }),
      onIdle: () => scheduler?.notifyIdle(),
      onError: report,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    });
    engine = next;
    for (const noteId of docs.openNoteIds()) {
      const doc = docs.get(noteId);
      if (doc) next.watch(noteId, doc);
    }
    next.start();
    scheduler = createSnapshotScheduler({
      drive: new GoogleDriveClient({
        getAccessToken: () => auth.accessToken(),
        ...(options.driveFetch ? { fetch: options.driveFetch } : {}),
      }),
      createSnapshot: () => exportSnapshot(storage, sealer, Date.now() as EpochMs),
      vaultHeader: () => headerJson,
      onStatus: (backup) => updateSync({ backup }),
    });
    scheduler.start();
  }

  async function stopSync(): Promise<void> {
    scheduler?.stop();
    scheduler = null;
    const stopping = engine;
    engine = null;
    await stopping?.stop();
    updateSync({ connection: 'off' });
  }

  auth?.onChange((state) => {
    updateSync({ auth: state.kind });
    if (state.kind === 'signed-in') startSync();
    else void stopSync();
  });

  async function start(): Promise<string | null> {
    await sealer.setKey(vault.getKey());
    const loaded = await store.load();
    if (!loaded.ok) return loaded.error.message;
    retention = startRetentionWorker({
      storage,
      onError: report,
      onPurged: async (item) => {
        await engine?.submitTombstone(item.id, item.entityType);
      },
    });
    setStatus('unlocked');
    // Sign-in never blocks local work: restore in the background, sync starts when it succeeds.
    if (auth?.state().kind === 'signed-in') startSync();
    else void auth?.restore();
    return null;
  }

  async function closeDoc(noteId: NoteId): Promise<void> {
    await opening.get(noteId);
    await engine?.unwatch(noteId);
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
        headerJson = serializeVaultHeader(header);
        await storage.setVaultHeader(headerJson);
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
        headerJson = header;
        return await start();
      } catch (error) {
        vault.lock();
        return message(error);
      }
    },

    async lock() {
      await stopSync();
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
        engine?.watch(noteId, doc);
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

    syncStatus,

    async signIn() {
      if (!auth) return 'Google sign-in is not available in this app.';
      return auth.signIn();
    },

    async signOut() {
      await auth?.signOut();
    },

    isEmptyAndUnmodified(noteId) {
      // A doc that was never opened may hold saved text, so only a loaded, empty one qualifies.
      const doc = docs.get(noteId);
      return doc !== undefined && !edited.has(noteId) && doc.getText(TEXT_FIELD).length === 0;
    },
  };
}
