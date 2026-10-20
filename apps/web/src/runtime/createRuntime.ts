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
import {
  StorageError,
  type IStorageEngine,
  type IVaultDirectory,
  type VaultEntry,
  type VaultSyncState,
} from '@ankylock/storage';
import {
  DocManager,
  GoogleDriveClient,
  REMOTE_ORIGIN,
  TEXT_FIELD,
  AuthError,
  createCatchUp,
  createSnapshotScheduler,
  createSyncEngine,
  deleteAllFromDrive,
  deleteVaultFromDrive,
  downloadSnapshots,
  exportSnapshot,
  listRemoteVaults,
  mergeSnapshots,
  publishingStorage,
  removeLegacyDriveFiles,
  syncHeaderFile,
  vaultSnapshotFileName,
  loadNoteState,
  persistDoc,
  startRetentionWorker,
  trackChanges,
  type AuthSession,
  type AuthState,
  type BackupStatus,
  type ConnectionStatus,
  type DeviceId,
  type CatchUp,
  type DocPersister,
  type RemoteVault,
  type RetentionWorker,
  type SnapshotScheduler,
  type SocketLike,
  type SyncEngine,
} from '@ankylock/sync';
import { runExportInWorker, type ExportFile, type ExportJob } from '../export/exportNotes.js';
import { planExport, type ExportScope } from '../export/exportPlan.js';
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
  /** Test seam: builds an export without a Web Worker. */
  readonly runExport?: (job: ExportJob) => Promise<ExportFile>;
}

/** Shown in the status bar; never blocks local work (SPEC §7). */
export interface SyncStatus {
  readonly auth: AuthState['kind'] | 'unavailable';
  readonly connection: ConnectionStatus | 'off';
  readonly backup: BackupStatus;
  /** Merging other devices' Drive backups right now. */
  readonly catchingUp: boolean;
  /**
   * The open vault's copy in Google Drive. `deleted`: another device deleted it, so sync stopped.
   * `local-only`: the user keeps this vault on this device only.
   */
  readonly vaultDrive: 'ok' | 'deleted' | 'local-only';
  /** The open vault has a copy in Google Drive (its header was uploaded and is still there). */
  readonly onDrive: boolean;
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
  /** Catches up from Drive and backs up now ("Sync now"); a no-op while sync is off. */
  syncNow(): Promise<void>;
  /** Renames the open vault; other devices take the newer name when they next sync. */
  renameVault(name: string): Promise<string | null>;
  /**
   * Removes the open vault from this device, and with `everywhere` also its copy in Google Drive
   * (header and every device's backup). Returns to the vault list.
   */
  removeVault(options: { readonly everywhere: boolean }): Promise<string | null>;
  /** Keeps a vault deleted elsewhere on this device only: sync and backup stay off for it. */
  keepLocalOnly(): Promise<void>;
  /** Backs up a local-only vault to Google Drive again, as a vault of its own. */
  backUpAgain(): Promise<void>;
  /**
   * Leaves AnkyLock's Google Drive: stops sync and backups, deletes every vault's files from
   * Drive, then revokes the Google grant and signs out. Notes on this device stay; the open vault
   * becomes local-only. Resolves with an error message (what remains, so it can be retried), or
   * null; access is never revoked while files remain.
   */
  deleteAllDriveData(): Promise<string | null>;
  /**
   * Builds an unencrypted export of a note, a folder or the whole open vault (Trash left out),
   * optionally as an AES-256 protected zip. Decrypting happens in the crypto worker and building
   * the file in the export worker; the file only goes where the user saves it.
   */
  exportNotes(scope: ExportScope, password: string | null): Promise<ExportFile>;
  /** Backups are on and the vault changed since the last successful one. */
  hasUnbackedChanges(): boolean;
  /**
   * Before the app closes: saves pending edits, then backs up if anything is not on Drive yet,
   * waiting at most `waitMs`. `clean`: nothing to back up (or backups are off).
   */
  backUpBeforeClose(waitMs: number): Promise<'clean' | 'ok' | 'failed' | 'timeout'>;
}

const LOCK_BACKUP_WAIT_MS = 5_000;

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
  let catchUp: CatchUp | null = null;
  let headerJson: string | null = null;
  /** The open vault; storage and store are replaced whenever another vault is opened. */
  let vaultId: VaultId | null = null;
  let storage: IStorageEngine | null = null;
  let store: WorkspaceStore | null = null;
  let vaultNameCiphertext: Ciphertext | null = null;
  let syncState: VaultSyncState | null = null;
  /** The header file was checked against Drive since sync (re)started; reset by every catch-up. */
  let headerChecked = false;
  let legacyCleaned = false;
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
    catchingUp: false,
    vaultDrive: 'ok',
    onDrive: false,
  });
  const updateSync = (patch: Partial<SyncStatus>): void => {
    setSyncStatus((current) => ({ ...current, ...patch }));
  };
  let retention: RetentionWorker | null = null;

  // Remote edits can add, move or retitle notes; coalesce sidebar reloads.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const retitled = new Set<NoteId>();
  const reloadSoon = (noteIds: readonly NoteId[] = []): void => {
    for (const noteId of noteIds) retitled.add(noteId);
    reloadTimer ??= setTimeout(() => {
      reloadTimer = undefined;
      const changed = [...retitled];
      retitled.clear();
      const current = store;
      void current?.load().then(() => current.refreshTitles(changed));
    }, 300);
  };

  async function saveSyncState(patch: Partial<VaultSyncState>): Promise<void> {
    if (!storage || !syncState) return;
    syncState = { ...syncState, ...patch };
    updateSync({ onDrive: syncState.headerOnDrive && !syncState.localOnly });
    await storage.setSyncState(syncState);
  }

  /**
   * Brings the vault's header file in Drive in line with this device (see `syncHeaderFile`):
   * creates it once, takes or publishes the newer name, and notices a vault deleted elsewhere.
   */
  let preparing: Promise<'conflict' | 'deleted' | null> | null = null;
  function prepareHeader(): Promise<'conflict' | 'deleted' | null> {
    // Catch-up and backup both ask at sync start; one check must never create the file twice.
    preparing ??= checkHeader().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function checkHeader(): Promise<'conflict' | 'deleted' | null> {
    if (headerChecked) return null;
    const entry = vaultList().find((v) => v.id === vaultId);
    if (!drive || !entry || headerJson === null || !syncState) return 'conflict';
    const result = await syncHeaderFile(
      drive,
      { vaultId: entry.id, createdAt: entry.createdAt, header: headerJson, nameCiphertext: vaultNameCiphertext, nameUpdatedAt: syncState.nameUpdatedAt },
      syncState.headerOnDrive,
    );
    if (result.kind === 'conflict') return 'conflict';
    if (result.kind === 'deleted') {
      updateSync({ vaultDrive: 'deleted', onDrive: false });
      void stopSync();
      return 'deleted';
    }
    if (!syncState.headerOnDrive) await saveSyncState({ headerOnDrive: true });
    // Another device renamed the vault more recently.
    if (result.name?.ciphertext && storage) {
      await storage.setVaultName(result.name.ciphertext, result.name.updatedAt);
      syncState = { ...syncState, nameUpdatedAt: result.name.updatedAt };
      vaultNameCiphertext = result.name.ciphertext;
      setVaultName(await names.decrypt(result.name.ciphertext));
    }
    headerChecked = true;
    return null;
  }

  /** Merges what other devices backed up while this one was away (the relay keeps no history). */
  async function runCatchUp(): Promise<void> {
    if (!catchUp) return;
    updateSync({ catchingUp: true });
    try {
      headerChecked = false;
      if ((await prepareHeader()) === 'deleted') return;
      if (!legacyCleaned && drive) {
        legacyCleaned = true;
        await removeLegacyDriveFiles(drive);
      }
      const result = await catchUp.run();
      if (result.unreadable > 0) report(`${result.unreadable} backup(s) of this vault could not be read and were skipped.`);
      if (result.changed) reloadSoon(result.changedNotes);
    } catch (error) {
      // Expired web access waits for a renewal; the next connect retries.
      if (!(error instanceof AuthError && error.code === 'ERR_AUTH_EXPIRED')) report(error);
    } finally {
      updateSync({ catchingUp: false });
    }
  }

  function startSync(): void {
    if (engine || !auth || !relayUrl || status() !== 'unlocked' || auth.state().kind !== 'signed-in') return;
    const entry = vaultList().find((v) => v.id === vaultId);
    if (!storage || !vaultId || !entry || !drive || headerJson === null || vaultDeviceId === null) return;
    if (!syncState || syncState.localOnly || syncStatus().vaultDrive === 'deleted') return;
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
      onStatusChange: (connection) => {
        updateSync({ connection });
        // Every (re)connect may follow a gap in which other devices changed things.
        if (connection === 'open') void runCatchUp();
      },
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
      snapshotFile: vaultSnapshotFileName(vaultId, vaultDeviceId),
      prepare: prepareHeader,
      onStatus: (backup) => updateSync({ backup }),
    });
    scheduler.start();
    catchUp = createCatchUp({ drive, storage: vaultStorage, sealer, docs, vaultId, deviceId: vaultDeviceId });
    // Neither waits for the relay (SPEC §7): catch up from Drive, then back up the merged state.
    void runCatchUp().finally(() => scheduler?.notifyIdle());
  }

  async function stopSync(): Promise<void> {
    catchUp = null;
    scheduler?.stop();
    scheduler = null;
    const stopping = engine;
    engine = null;
    await stopping?.stop();
    updateSync({ connection: 'off' });
  }

  auth?.onChange((state) => {
    updateSync({ auth: state.kind });
    if (state.kind === 'signed-in') {
      startSync();
      // After a renewal, catch up on a backup that waited for fresh tokens.
      scheduler?.notifyIdle();
    } else if (state.kind === 'signed-out' || state.kind === 'expired') {
      void stopSync();
    }
    // `signing-in` and `stale` keep a running sync: its live connection still works.
  });

  async function start(vaultStorage: IStorageEngine, id: VaultId, header: string): Promise<string | null> {
    // Every write to vault data, local or from another device, is due for the next backup.
    const opened = trackChanges(vaultStorage, () => scheduler?.markChanged());
    await sealer.setKey(vault.getKey());
    const nameCiphertext = await opened.getVaultName();
    const deviceOfVault = await opened.getDeviceId();
    const stateOfVault = await opened.getSyncState();
    // Changes made through the store reach other devices; remote changes bypass this wrapper.
    const published = publishingStorage(opened, {
      onRecords: (records) => void engine?.submitHierarchy(records).catch(report),
      onRemoved: (id, type) => void engine?.submitTombstone(id as NoteId, type).catch(report),
      onError: report,
    });
    const nextStore = createWorkspaceStore({ storage: published, names, onPurged: announcePurged });
    const loaded = await nextStore.load();
    if (!loaded.ok) return loaded.error.message;
    storage = opened;
    store = nextStore;
    vaultId = id;
    headerJson = header;
    vaultNameCiphertext = nameCiphertext;
    vaultDeviceId = deviceOfVault;
    syncState = stateOfVault;
    headerChecked = false;
    updateSync({
      vaultDrive: stateOfVault.localOnly ? 'local-only' : 'ok',
      onDrive: stateOfVault.headerOnDrive && !stateOfVault.localOnly,
    });
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

  /** Locks the open vault and returns to the vault list; `backup` takes a last backup first. */
  async function closeVault(backup: boolean): Promise<void> {
    retention?.stop();
    retention = null;
    await Promise.all(docs.openNoteIds().map(closeDoc));
    // A last backup, so other devices can catch up on this session; never blocks locking long.
    if (backup && scheduler?.hasChanges()) {
      await Promise.race([scheduler.runNow(), new Promise((resolve) => setTimeout(resolve, LOCK_BACKUP_WAIT_MS))]);
    }
    await stopSync();
    await sealer.setKey(null);
    vault.lock();
    storage = null;
    store = null;
    vaultId = null;
    headerJson = null;
    vaultNameCiphertext = null;
    vaultDeviceId = null;
    syncState = null;
    updateSync({ vaultDrive: 'ok', onDrive: false, backup: { kind: 'never' } });
    setVaultName(null);
    await refreshVaults();
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

    lock: () => closeVault(true),

    async renameVault(name) {
      const trimmed = name.trim();
      if (trimmed === '') return 'Give the vault a name.';
      if ([...trimmed].length > MAX_VAULT_NAME_LENGTH) return `Use at most ${MAX_VAULT_NAME_LENGTH} characters for the name.`;
      if (!storage || !syncState) return 'No vault is open.';
      try {
        const ciphertext = await names.encrypt(trimmed);
        const updatedAt = Date.now() as EpochMs;
        await storage.setVaultName(ciphertext, updatedAt);
        syncState = { ...syncState, nameUpdatedAt: updatedAt };
        vaultNameCiphertext = ciphertext;
        setVaultName(trimmed);
        // Publish the new name now if syncing; otherwise the next sync does.
        if (engine) {
          headerChecked = false;
          await prepareHeader();
        }
        return null;
      } catch (error) {
        return message(error);
      }
    },

    async removeVault({ everywhere }) {
      const id = vaultId;
      if (id === null) return 'No vault is open.';
      try {
        if (everywhere) {
          if (!drive || auth?.state().kind !== 'signed-in') return 'Sign in with Google to delete the vault from Google Drive too.';
          await deleteVaultFromDrive(drive, id);
        }
        // Kept in Drive: back up the last changes first. Deleted everywhere: nothing to keep.
        await closeVault(!everywhere && syncStatus().onDrive);
        await directory.remove(id);
        await refreshVaults();
        return null;
      } catch (error) {
        return message(error);
      }
    },

    async keepLocalOnly() {
      await saveSyncState({ localOnly: true, headerOnDrive: false });
      updateSync({ vaultDrive: 'local-only', backup: { kind: 'never' } });
      await stopSync();
    },

    async backUpAgain() {
      await saveSyncState({ localOnly: false, headerOnDrive: false });
      updateSync({ vaultDrive: 'ok' });
      startSync();
    },

    async deleteAllDriveData() {
      if (!auth || !drive) return 'Google sign-in is not available in this app.';
      if (auth.state().kind !== 'signed-in') return 'Sign in with Google to delete your data from Google Drive.';
      try {
        // Sync stays off from here on: a backup now would put files back into Drive.
        await stopSync();
        const { remaining } = await deleteAllFromDrive(drive);
        if (remaining > 0) {
          return `${remaining} file(s) could not be deleted from Google Drive. Sync is paused; try again.`;
        }
        if (syncState) {
          await saveSyncState({ localOnly: true, headerOnDrive: false });
          updateSync({ vaultDrive: 'local-only', backup: { kind: 'never' } });
        }
      } catch (error) {
        return `Could not delete your data from Google Drive: ${message(error)} Sync is paused; try again.`;
      }
      const failure = await auth.revokeAndSignOut();
      return failure === null
        ? null
        : `Your data was deleted from Google Drive, but AnkyLock's Google access could not be revoked: ${failure} Try again, or remove AnkyLock from your Google Account's third-party access.`;
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
          // Counted before the debounced save, so closing right after typing still warns.
          scheduler?.markChanged();
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

    async syncNow() {
      await runCatchUp();
      await scheduler?.runNow();
    },

    async exportNotes(scope, password) {
      const vaultStorage = openStorage();
      // Pending edits first, so the export has what the user sees.
      await Promise.all([...persisters.values()].map((persister) => persister.flush()));
      const date = new Date().toISOString().slice(0, 10);
      const plan = planExport(openStore().state, scope, vaultName(), date);
      const items = await Promise.all(
        plan.items.map(async (item) => ({ dir: item.dir, state: (await loadNoteState({ storage: vaultStorage, sealer }, item.noteId)) ?? null })),
      );
      const job: ExportJob = { archiveName: plan.archiveName, single: plan.single, dirs: plan.dirs, items, password };
      return (options.runExport ?? runExportInWorker)(job);
    },

    hasUnbackedChanges: () => scheduler?.hasChanges() ?? false,

    async backUpBeforeClose(waitMs) {
      await Promise.all([...persisters.values()].map((persister) => persister.flush()));
      if (!scheduler?.hasChanges()) return 'clean';
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), waitMs));
      const result = await Promise.race([scheduler.runNow(), timeout]);
      return result === 'timeout' ? result : result.kind === 'ok' ? 'ok' : 'failed';
    },

    isEmptyAndUnmodified(noteId) {
      // A doc that was never opened may hold saved text, so only a loaded, empty one qualifies.
      const doc = docs.get(noteId);
      return doc !== undefined && !edited.has(noteId) && doc.getText(TEXT_FIELD).length === 0;
    },
  };
}
