import { batch, createSignal, type Accessor } from 'solid-js';
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
import { errorText, t, tn, type MessageKey } from '../i18n/index.js';
import { parseRelayUrl, type RelayPreference, type RelayUrlProblem } from '../preferences/devicePreferences.js';
import { MIN_PASSPHRASE_LENGTH } from '../components/passphrase.js';
import { DEFAULT_LOGO_FACE, nextLogoFace, type LogoFace } from './logoFace.js';

export type VaultStatus = 'loading' | 'uninitialized' | 'locked' | 'unlocked';

export interface RuntimeOptions {
  /** The vaults on this device; each has its own database, salt and key (BR-SEC-04). */
  readonly vaults: IVaultDirectory;
  /** Encryption runs in a Dedicated Web Worker; the app passes `createWorkerSealer(new Worker(...))`. */
  readonly sealer: WorkerSealer;
  readonly onError?: (message: string) => void;
  /** Google session; without it the app is local-only (sync and backup stay off). */
  readonly auth?: AuthSession;
  /**
   * Blind relay WebSocket base URL for development builds, e.g. `ws://127.0.0.1:8787/ws`; the vault
   * id is appended. Production builds have none: without a relay, sync runs through Drive only.
   */
  readonly relayUrl?: string;
  /**
   * The user's own relay for instant sync on this device; it wins over `relayUrl`. Desktop only:
   * the web app's CSP allows no relay but the one it was built with (`VITE_RELAY_URL`).
   */
  readonly relayPreference?: RelayPreference;
  /** Test seams for the relay socket and Drive's HTTP client. */
  readonly createSocket?: (url: string, protocols: string[]) => SocketLike;
  readonly driveFetch?: typeof fetch;
  /** Test seam: builds an export without a Web Worker. */
  readonly runExport?: (job: ExportJob) => Promise<ExportFile>;
  /** Test seam for the logo's random expressions; returns a number in [0, 1). */
  readonly random?: () => number;
}

const RELAY_URL_PROBLEMS = {
  invalid: 'relay.errorInvalid',
  insecure: 'relay.errorInsecure',
  extras: 'relay.errorExtras',
} as const satisfies Record<RelayUrlProblem, MessageKey>;

/** How often a Drive-only device looks for other devices' backups (they back up every 5 minutes). */
export const CATCH_UP_INTERVAL_MS = 2 * 60 * 1000;

/** Shown in the status bar; never blocks local work (SPEC §7). */
export interface SyncStatus {
  readonly auth: AuthState['kind'] | 'unavailable';
  /**
   * `off`: not syncing. `drive`: through Google Drive only (no relay); other devices' changes
   * arrive at the next catch-up. `live`: through a relay as well, instantly.
   */
  readonly mode: 'off' | 'drive' | 'live';
  /** The relay connection; `off` without a relay. */
  readonly connection: ConnectionStatus | 'off';
  /** When this device last merged other devices' Drive backups. */
  readonly lastCatchUpAt: EpochMs | null;
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
  /** Shared by every logo on screen: a new random expression on every lock and unlock. */
  readonly logoFace: Accessor<LogoFace>;
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
  /** Whether this app lets the user set their own relay (the desktop app; not the web app). */
  readonly ownRelaySupported: boolean;
  /** The user's own relay on this device, or null (Drive only). */
  readonly ownRelayUrl: Accessor<string | null>;
  /**
   * Sets or clears (empty input) the user's own relay and restarts sync with it. Resolves with an
   * error message for an address that is not `wss://` (or `ws://` on this machine), or null.
   */
  setOwnRelay(input: string): Promise<string | null>;
  /** Renames the open vault; other devices take the newer name when they next sync. */
  renameVault(name: string): Promise<string | null>;
  /**
   * Removes the open vault from this device, and with `everywhere` also its copy in Google Drive
   * (header and every device's backup). Returns to the vault list.
   */
  removeVault(options: { readonly everywhere: boolean }): Promise<string | null>;
  /** Whether a locked vault on this device has a copy in Google Drive, by its own sync state. */
  lockedVaultOnDrive(vaultId: VaultId): Promise<boolean>;
  /**
   * Removes a locked vault from this device without its passphrase, e.g. one whose passphrase is
   * forgotten; with `everywhere`, deletes its Drive copy first (signing in if needed).
   */
  removeLockedVault(vaultId: VaultId, options: { readonly everywhere: boolean }): Promise<string | null>;
  /** Deletes a vault found by `findRemoteVaults` from Google Drive, without its passphrase. */
  deleteRemoteVault(vaultId: VaultId): Promise<string | null>;
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

/** Coded errors in the user's language; others as they are. */
const message = (error: unknown): string =>
  error instanceof CryptoError || error instanceof StorageError ? errorText(error) : error instanceof Error ? error.message : String(error);

/**
 * Composition root shared by desktop and web: storage, the crypto worker, the vault key, the
 * workspace store, headless Y.Docs with encrypted persistence and the retention worker.
 * The MEK lives only as a non-extractable CryptoKey in memory and inside the crypto worker;
 * it is never written to disk, so every launch asks for the passphrase.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { vaults: directory, sealer, auth } = options;
  const ownRelayUrl = (): string | null => options.relayPreference?.url() ?? null;
  const relayUrl = (): string | null => ownRelayUrl() ?? options.relayUrl ?? null;
  let catchUpTimer: ReturnType<typeof setInterval> | undefined;
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
  const [status, setVaultStatus] = createSignal<VaultStatus>('loading');
  const [logoFace, setLogoFace] = createSignal<LogoFace>(DEFAULT_LOGO_FACE);
  const random = options.random ?? Math.random;
  // Together, so whatever appears with the new status (the vault picker) sees the new face.
  const setStatus = (next: VaultStatus): void =>
    batch(() => {
      setVaultStatus(next);
      setLogoFace((face) => nextLogoFace(face, next === 'unlocked', random));
    });
  const [vaultList, setVaultList] = createSignal<readonly VaultEntry[]>([]);
  const [vaultName, setVaultName] = createSignal<string | null>(null);
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus>({
    auth: auth ? auth.state().kind : 'unavailable',
    mode: 'off',
    connection: 'off',
    lastCatchUpAt: null,
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
      updateSync({ lastCatchUpAt: Date.now() as EpochMs });
      if (result.unreadable > 0) report(tn('runtime.unreadableBackups', result.unreadable));
      if (result.changed) reloadSoon(result.changedNotes);
    } catch (error) {
      // Expired web access waits for a renewal; the next connect retries.
      if (!(error instanceof AuthError && error.code === 'ERR_AUTH_EXPIRED')) report(error);
    } finally {
      updateSync({ catchingUp: false });
    }
  }

  function startSync(): void {
    if (scheduler || !auth || status() !== 'unlocked' || auth.state().kind !== 'signed-in') return;
    const entry = vaultList().find((v) => v.id === vaultId);
    if (!storage || !vaultId || !entry || !drive || headerJson === null || vaultDeviceId === null) return;
    if (!syncState || syncState.localOnly || syncStatus().vaultDrive === 'deleted') return;
    const vaultStorage = storage;
    const relay = relayUrl();
    if (relay !== null) startRelay(vaultStorage, relay, vaultId);
    scheduler = createSnapshotScheduler({
      drive,
      createSnapshot: () => exportSnapshot(vaultStorage, sealer, Date.now() as EpochMs),
      snapshotFile: vaultSnapshotFileName(vaultId, vaultDeviceId),
      prepare: prepareHeader,
      onStatus: (backup) => updateSync({ backup }),
    });
    scheduler.start();
    catchUp = createCatchUp({ drive, storage: vaultStorage, sealer, docs, vaultId, deviceId: vaultDeviceId });
    // Without a relay, other devices' changes only arrive through their Drive backups.
    if (relay === null) catchUpTimer = setInterval(() => void runCatchUp(), CATCH_UP_INTERVAL_MS);
    updateSync({ mode: relay === null ? 'drive' : 'live' });
    // Neither waits for the relay (SPEC §7): catch up from Drive, then back up the merged state.
    void runCatchUp().finally(() => scheduler?.notifyIdle());
  }

  /** Instant sync through a relay, on top of Drive: live packets, outbox and peer catch-up. */
  function startRelay(vaultStorage: IStorageEngine, relay: string, id: VaultId): void {
    if (!auth) return;
    const next = createSyncEngine({
      storage: vaultStorage,
      sealer,
      docs,
      deviceId,
      // Relay channels are per account and vault, so other vaults never see these packets.
      relayUrl: `${relay.replace(/\/+$/, '')}/${id}`,
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
  }

  async function stopSync(): Promise<void> {
    clearInterval(catchUpTimer);
    catchUpTimer = undefined;
    catchUp = null;
    scheduler?.stop();
    scheduler = null;
    const stopping = engine;
    engine = null;
    await stopping?.stop();
    updateSync({ mode: 'off', connection: 'off' });
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
    logoFace,

    init: refreshVaults,

    async createVault(name, passphrase) {
      const trimmed = name.trim();
      if (trimmed === '') return t('vault.nameRequired');
      // Also enforced here, not only in the form: the passphrase is the vault's only protection.
      if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) return t('unlock.passphraseTooShort', { min: MIN_PASSPHRASE_LENGTH });
      if ([...trimmed].length > MAX_VAULT_NAME_LENGTH) return t('runtime.nameTooLong', { max: MAX_VAULT_NAME_LENGTH });
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
        if (header === null) return t('runtime.noHeader');
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
      if (trimmed === '') return t('vault.nameRequired');
      if ([...trimmed].length > MAX_VAULT_NAME_LENGTH) return t('runtime.nameTooLong', { max: MAX_VAULT_NAME_LENGTH });
      if (!storage || !syncState) return t('runtime.noVaultOpen');
      try {
        const ciphertext = await names.encrypt(trimmed);
        const updatedAt = Date.now() as EpochMs;
        await storage.setVaultName(ciphertext, updatedAt);
        syncState = { ...syncState, nameUpdatedAt: updatedAt };
        vaultNameCiphertext = ciphertext;
        setVaultName(trimmed);
        // Publish the new name now if syncing; otherwise the next sync does.
        if (scheduler) {
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
      if (id === null) return t('runtime.noVaultOpen');
      try {
        if (everywhere) {
          if (!drive || auth?.state().kind !== 'signed-in') return t('settings.signInToDeleteEverywhere');
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

    async lockedVaultOnDrive(id) {
      if (status() === 'unlocked') return false;
      const state = await (await directory.open(id)).getSyncState();
      return state.headerOnDrive && !state.localOnly;
    },

    async removeLockedVault(id, { everywhere }) {
      if (status() === 'unlocked') return t('runtime.lockFirst');
      try {
        if (everywhere) {
          if (!auth || !drive) return t('runtime.noGoogle');
          if (auth.state().kind !== 'signed-in') {
            const failure = await auth.signIn();
            if (failure !== null) return failure;
          }
          // Drive first: if that fails, the vault is still here to retry with.
          await deleteVaultFromDrive(drive, id);
        }
        await directory.remove(id);
        await refreshVaults();
        return null;
      } catch (error) {
        return message(error);
      }
    },

    async deleteRemoteVault(id) {
      if (!drive || !remoteVaults.has(id)) return t('runtime.notOnDrive');
      try {
        await deleteVaultFromDrive(drive, id);
        remoteVaults.delete(id);
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
      if (!auth || !drive) return t('runtime.noGoogle');
      if (auth.state().kind !== 'signed-in') return t('settings.signInToWipe');
      try {
        // Sync stays off from here on: a backup now would put files back into Drive.
        await stopSync();
        const { remaining } = await deleteAllFromDrive(drive);
        if (remaining > 0) {
          return tn('runtime.wipeRemaining', remaining);
        }
        if (syncState) {
          await saveSyncState({ localOnly: true, headerOnDrive: false });
          updateSync({ vaultDrive: 'local-only', backup: { kind: 'never' } });
        }
      } catch (error) {
        return t('runtime.wipeFailed', { reason: message(error) });
      }
      const failure = await auth.revokeAndSignOut();
      return failure === null
        ? null
        : t('runtime.revokeFailed', { reason: failure });
    },

    async findRemoteVaults() {
      if (!auth || !drive) return { error: t('runtime.noGoogle') };
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
      if (!remote || !drive) return t('runtime.notOnDrive');
      try {
        await vault.unlock(passphrase, parseVaultHeader(remote.header));
        await sealer.setKey(vault.getKey());
        const { snapshots, unreadable } = await downloadSnapshots(drive, sealer, remote);
        if (unreadable > 0) report(tn('runtime.unreadableBackups', unreadable));
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
      if (!auth) return t('runtime.noGoogle');
      return auth.signIn();
    },

    async signOut() {
      await auth?.signOut();
    },

    async syncNow() {
      await runCatchUp();
      await scheduler?.runNow();
    },

    ownRelaySupported: options.relayPreference !== undefined,
    ownRelayUrl,

    async setOwnRelay(input) {
      const parsed = parseRelayUrl(input);
      if ('error' in parsed) return t(RELAY_URL_PROBLEMS[parsed.error]);
      if (!options.relayPreference) return t('runtime.relayDesktopOnly');
      if (parsed.url === ownRelayUrl()) return null;
      options.relayPreference.set(parsed.url);
      // Restart with or without the relay; Drive sync continues either way.
      if (scheduler) {
        await stopSync();
        startSync();
      }
      return null;
    },

    async exportNotes(scope, password) {
      const vaultStorage = openStorage();
      // Pending edits first, so the export has what the user sees.
      await Promise.all([...persisters.values()].map((persister) => persister.flush()));
      const date = new Date().toISOString().slice(0, 10);
      const untitled = t('note.untitled');
      const names = { untitled, untitledFolder: t('export.untitledFolder'), folder: t('export.folder'), vault: t('export.vault') };
      const plan = planExport(openStore().state, scope, vaultName(), date, names);
      const items = await Promise.all(
        plan.items.map(async (item) => ({ dir: item.dir, state: (await loadNoteState({ storage: vaultStorage, sealer }, item.noteId)) ?? null })),
      );
      const job: ExportJob = { archiveName: plan.archiveName, single: plan.single, dirs: plan.dirs, items, password, untitled };
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
