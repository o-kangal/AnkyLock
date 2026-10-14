import { createSignal, type Accessor } from 'solid-js';
import type * as Y from 'yjs';
import type { Ciphertext, EpochMs, NoteId, VaultId } from '@ankylock/core';
import {
  CryptoError,
  createTextCodec,
  createVaultKey,
  parseVaultHeader,
  serializeVaultHeader,
  type WorkerSealer,
} from '@ankylock/crypto';
import { StorageError, type IStorageEngine, type IVaultDirectory, type VaultEntry } from '@ankylock/storage';
import {
  DocManager,
  GoogleDriveClient,
  REMOTE_ORIGIN,
  TEXT_FIELD,
  createSnapshotScheduler,
  createSyncEngine,
  downloadSnapshots,
  exportSnapshot,
  listRemoteVaults,
  mergeSnapshots,
  loadNoteState,
  persistDoc,
  startRetentionWorker,
  type AuthSession,
  type AuthState,
  type BackupStatus,
  type ConnectionStatus,
  type DeviceId,
  type DocPersister,
  type RemoteVault,
  type RetentionWorker,
  type SnapshotScheduler,
  type SocketLike,
  type SyncEngine,
} from '@ankylock/sync';
import { createWorkspaceStore, type PurgedItem, type WorkspaceStore } from '../stores/workspaceStore.js';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export interface RuntimeOptions {
  /** The vaults on this device; each has its own database, salt and key (BR-SEC-04). */
  readonly vaults: IVaultDirectory;
  /** Encryption runs in a Dedicated Web Worker; the app passes `createWorkerSealer(new Worker(...))`. */
  readonly sealer: WorkerSealer;
  readonly onError?: (message: string) => void;
  /** Google session; without it the app is local-only (sync and backup stay off). */
  readonly auth?: AuthSession;
  /** Blind relay WebSocket base URL, e.g. `ws://127.0.0.1:8787/ws`; the vault id is appended. */
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
  /** The open vault's workspace; a fresh one per unlock, so nothing carries over between vaults. */
  readonly store: WorkspaceStore;
  /** `uninitialized`: no vault on this device yet. `locked`: choose a vault and unlock it. */
  readonly status: Accessor<VaultStatus>;
  /** The vaults on this device, most recently opened first. */
  readonly vaults: Accessor<readonly VaultEntry[]>;
  /** The open vault's decrypted name; null while locked or for vaults created before names existed. */
  readonly vaultName: Accessor<string | null>;
  /** Lists the vaults on this device; call once at startup. */
  init(): Promise<void>;
  /**
   * Creates a vault with its own salt and key, stores its (non-secret) header and encrypted name,
   * and opens it. Resolves with an error message, or null on success.
   */
  createVault(name: string, passphrase: string): Promise<string | null>;
  /** Resolves with an error message, or null on success. */
  unlock(vaultId: VaultId, passphrase: string): Promise<string | null>;
  /** Locks the open vault and returns to the vault list. */
  lock(): Promise<void>;
  /**
   * Signs in to Google if needed and lists the vaults in the user's Drive that are not on this
   * device yet. Names stay encrypted until a vault is unlocked.
   */
  findRemoteVaults(): Promise<{ readonly vaults: readonly RemoteVault[] } | { readonly error: string }>;
  /**
   * Opens a vault found by `findRemoteVaults` on this device: checks the passphrase against its
   * header first (nothing is written on a wrong one), then restores every device's snapshot.
   */
  openRemoteVault(vaultId: VaultId, passphrase: string): Promise<string | null>;
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

/** Long enough for any sensible label, short enough for the title bar and vault list. */
export const MAX_VAULT_NAME_LENGTH = 64;

const message = (error: unknown): string =>
  error instanceof CryptoError || error instanceof StorageError || error instanceof Error ? error.message : String(error);

/**
 * Composition root shared by desktop and web: storage, the crypto worker, the vault key, the
 * workspace store, headless Y.Docs with encrypted persistence and the retention worker.
 * The MEK lives only as a non-extractable CryptoKey in memory and inside the crypto worker;
 * it is never written to disk, so every launch asks for the passphrase.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { vaults: directory, sealer, auth, relayUrl } = options;
  const report = (error: unknown): void => options.onError?.(message(error));
  const vault = createVaultKey();
  const names = createTextCodec(sealer);
  let engine: SyncEngine | null = null;
  let scheduler: SnapshotScheduler | null = null;
  let headerJson: string | null = null;
  /** The open vault; storage and store are replaced whenever another vault is opened. */
  let vaultId: VaultId | null = null;
  let storage: IStorageEngine | null = null;
  let store: WorkspaceStore | null = null;
  let vaultNameCiphertext: Ciphertext | null = null;
  let vaultDeviceId: string | null = null;
  /** Vaults from the last Drive listing, by id. */
  let remoteVaults = new Map<VaultId, RemoteVault>();
  const drive = auth
    ? new GoogleDriveClient({
        getAccessToken: () => auth.accessToken(),
        ...(options.driveFetch ? { fetch: options.driveFetch } : {}),
      })
    : null;
  /** Identifies this app instance in frames; the relay already never echoes to the sender. */
  const deviceId = crypto.randomUUID() as DeviceId;
  const announcePurged = (items: readonly PurgedItem[]): void => {
    for (const item of items) void engine?.submitTombstone(item.id, item.entityType).catch(report);
  };
  const openStorage = (): IStorageEngine => {
    if (!storage) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
    return storage;
  };
  const openStore = (): WorkspaceStore => {
    if (!store) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
    return store;
  };
  const docs = new DocManager();
  const persisters = new Map<NoteId, DocPersister>();
  const opening = new Map<NoteId, Promise<Y.Doc>>();
  const edited = new Set<NoteId>();
  const [status, setStatus] = createSignal<VaultStatus>('loading');
  const [vaultList, setVaultList] = createSignal<readonly VaultEntry[]>([]);
  const [vaultName, setVaultName] = createSignal<string | null>(null);
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
      void store?.load();
    }, 300);
  };

  function startSync(): void {
    if (engine || !auth || !relayUrl || status() !== 'unlocked' || auth.state().kind !== 'signed-in') return;
    const entry = vaultList().find((v) => v.id === vaultId);
    if (!storage || !vaultId || !entry || !drive || headerJson === null || vaultDeviceId === null) return;
    const vaultStorage = storage;
    const next = createSyncEngine({
      storage: vaultStorage,
      sealer,
      docs,
      deviceId,
      // Relay channels are per account and vault, so other vaults never see these packets.
      relayUrl: `${relayUrl.replace(/\/+$/, '')}/${vaultId}`,
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
      drive,
      createSnapshot: () => exportSnapshot(vaultStorage, sealer, Date.now() as EpochMs),
      vault: { vaultId: entry.id, createdAt: entry.createdAt, header: headerJson, nameCiphertext: vaultNameCiphertext },
      deviceId: vaultDeviceId,
      onStatus: (backup) => updateSync({ backup }),
    });
    scheduler.start();
    // Backups never wait for the relay (SPEC §7): the first one runs right away, online or not.
    scheduler.notifyIdle();
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

  async function start(opened: IStorageEngine, id: VaultId, header: string): Promise<string | null> {
    await sealer.setKey(vault.getKey());
    const nameCiphertext = await opened.getVaultName();
    const deviceOfVault = await opened.getDeviceId();
    const nextStore = createWorkspaceStore({ storage: opened, names, onPurged: announcePurged });
    const loaded = await nextStore.load();
    if (!loaded.ok) return loaded.error.message;
    storage = opened;
    store = nextStore;
    vaultId = id;
    headerJson = header;
    vaultNameCiphertext = nameCiphertext;
    vaultDeviceId = deviceOfVault;
    setVaultList(await directory.list());
    setVaultName(nameCiphertext === null ? null : await names.decrypt(nameCiphertext));
    retention = startRetentionWorker({
      storage: opened,
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

  async function refreshVaults(): Promise<void> {
    const list = await directory.list();
    setVaultList(list);
    setStatus(list.length === 0 ? 'uninitialized' : 'locked');
  }

  /** Forgets the key after a failed create or unlock; nothing was opened. */
  async function failed(error: unknown): Promise<string> {
    vault.lock();
    await sealer.setKey(null);
    return message(error);
  }

  return {
    get store() {
      return openStore();
    },
    status,
    vaults: vaultList,
    vaultName,

    init: refreshVaults,

    async createVault(name, passphrase) {
      const trimmed = name.trim();
      if (trimmed === '') return 'Give the vault a name.';
      if ([...trimmed].length > MAX_VAULT_NAME_LENGTH) return `Use at most ${MAX_VAULT_NAME_LENGTH} characters for the name.`;
      try {
        const id = crypto.randomUUID() as VaultId;
        const header = serializeVaultHeader(await vault.initialize(passphrase));
        await sealer.setKey(vault.getKey());
        const created = await directory.create(id, header, await names.encrypt(trimmed));
        const failure = await start(created, id, header);
        return failure === null ? null : failed(failure);
      } catch (error) {
        return failed(error);
      }
    },

    async unlock(id, passphrase) {
      try {
        const opened = await directory.open(id);
        const header = await opened.getVaultHeader();
        if (header === null) return 'This vault has no header and cannot be unlocked.';
        await vault.unlock(passphrase, parseVaultHeader(header));
        const failure = await start(opened, id, header);
        return failure === null ? null : failed(failure);
      } catch (error) {
        return failed(error);
      }
    },

    async lock() {
      await stopSync();
      retention?.stop();
      retention = null;
      await Promise.all(docs.openNoteIds().map(closeDoc));
      await sealer.setKey(null);
      vault.lock();
      storage = null;
      store = null;
      vaultId = null;
      headerJson = null;
      vaultNameCiphertext = null;
      vaultDeviceId = null;
      setVaultName(null);
      await refreshVaults();
    },

    async findRemoteVaults() {
      if (!auth || !drive) return { error: 'Google sign-in is not available in this app.' };
      if (auth.state().kind !== 'signed-in') {
        const failure = await auth.signIn();
        if (failure !== null) return { error: failure };
      }
      try {
        const local = new Set((await directory.list()).map((v) => v.id));
        const found = (await listRemoteVaults(drive)).filter((v) => !local.has(v.vaultId));
        remoteVaults = new Map(found.map((v) => [v.vaultId, v]));
        return { vaults: found };
      } catch (error) {
        return { error: message(error) };
      }
    },

    async openRemoteVault(id, passphrase) {
      const remote = remoteVaults.get(id);
      if (!remote || !drive) return 'This vault was not found in Google Drive.';
      try {
        await vault.unlock(passphrase, parseVaultHeader(remote.header));
        await sealer.setKey(vault.getKey());
        const { snapshots, unreadable } = await downloadSnapshots(drive, sealer, remote);
        if (unreadable > 0) report(`${unreadable} backup(s) of this vault could not be read and were skipped.`);
        const data = await mergeSnapshots(sealer, snapshots);
        const created = await directory.create(id, remote.header, remote.nameCiphertext, remote.createdAt);
        await created.importVault(data);
        remoteVaults.delete(id);
        const failure = await start(created, id, remote.header);
        return failure === null ? null : failed(failure);
      } catch (error) {
        return failed(error);
      }
    },

    openDoc(noteId) {
      const open = docs.get(noteId);
      if (open) return Promise.resolve(open);
      const pending = opening.get(noteId);
      if (pending) return pending;
      const loading = (async () => {
        const vaultStorage = openStorage();
        const doc = docs.open(noteId, await loadNoteState({ storage: vaultStorage, sealer }, noteId));
        doc.on('update', (_update: Uint8Array, origin: unknown) => {
          if (origin !== REMOTE_ORIGIN) edited.add(noteId);
        });
        persisters.set(
          noteId,
          persistDoc(noteId, doc, {
            storage: vaultStorage,
            sealer,
            title: () => store?.state.notes[noteId]?.title ?? null,
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
