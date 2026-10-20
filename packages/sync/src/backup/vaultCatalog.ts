import * as Y from 'yjs';
import {
  DEFAULT_RETENTION_DAYS,
  type Bytes,
  type Category,
  type Ciphertext,
  type EpochMs,
  type Folder,
  type Note,
  type NoteContent,
  type NoteId,
  type SealedBytes,
  type VaultId,
} from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import type { VaultImport } from '@ankylock/storage';
import { encodeNoteContent } from '../persistence/notePersistence.js';
import { DriveError, type DriveFile, type GoogleDriveClient } from './googleDriveClient.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

/**
 * Drive layout (appDataFolder), one set per vault (BR-SEC-04):
 * - `vault-<vaultId>.header.json`: written once by the first device; never overwritten.
 * - `vault-<vaultId>.snapshot-<deviceId>.bin`: each device's own sealed snapshot, so devices
 *   never overwrite each other's backups.
 */
const PREFIX = 'vault-';
const HEADER_FILE = /^vault-([0-9a-f-]{36})\.header\.json$/;
const SNAPSHOT_FILE = /^vault-([0-9a-f-]{36})\.snapshot-[0-9a-f-]{36}\.bin$/;

export const vaultHeaderFileName = (vaultId: VaultId): string => `${PREFIX}${vaultId}.header.json`;
/** Name prefix shared by every device's snapshot of a vault. */
export const vaultSnapshotPrefix = (vaultId: VaultId): string => `${PREFIX}${vaultId}.snapshot-`;
export const vaultSnapshotFileName = (vaultId: VaultId, deviceId: string): string =>
  `${vaultSnapshotPrefix(vaultId)}${deviceId}.bin`;

/**
 * What a new device needs to open a vault: the (non-secret) key header and the encrypted name.
 * Drive sees the vault id and creation time only.
 */
export interface VaultHeaderFile {
  readonly vaultId: VaultId;
  readonly createdAt: EpochMs;
  /** Serialized vault header (see `serializeVaultHeader`). */
  readonly header: string;
  readonly nameCiphertext: Ciphertext | null;
  /**
   * When the name last changed (0: never renamed). The name is the only field that may change
   * after the file is created; the newer name wins across devices.
   */
  readonly nameUpdatedAt: EpochMs;
}

export function serializeVaultHeaderFile(file: VaultHeaderFile): string {
  return JSON.stringify({ version: 1, ...file });
}

export function parseVaultHeaderFile(json: string): VaultHeaderFile {
  const value: unknown = JSON.parse(json);
  const { version, vaultId, createdAt, header, nameCiphertext, nameUpdatedAt } = (typeof value === 'object' && value !== null
    ? value
    : {}) as Record<string, unknown>;
  if (
    version !== 1 ||
    typeof vaultId !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof header !== 'string' ||
    (nameCiphertext !== null && typeof nameCiphertext !== 'string')
  ) {
    throw new Error('Vault header file is malformed.');
  }
  return {
    vaultId: vaultId as VaultId,
    createdAt: createdAt as EpochMs,
    header,
    nameCiphertext: nameCiphertext as Ciphertext | null,
    nameUpdatedAt: (typeof nameUpdatedAt === 'number' ? nameUpdatedAt : 0) as EpochMs,
  };
}

/**
 * Outcome of comparing this device's view of a vault with its header file in Drive.
 * - `ready`: Drive has this vault's header (created now if it never had one); `name` is set when
 *   Drive's name is newer and should replace the local one.
 * - `conflict`: Drive holds a different key header under this vault id; nothing is changed.
 * - `deleted`: the header was in Drive before and is gone: another device deleted the vault.
 */
export type HeaderSync =
  | { readonly kind: 'ready'; readonly name: { readonly ciphertext: Ciphertext | null; readonly updatedAt: EpochMs } | null }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'deleted' };

/**
 * Brings the vault's header file in Drive and this device in line. The key header is written
 * once and never replaced; only the name moves, newest first.
 */
export async function syncHeaderFile(
  drive: Pick<GoogleDriveClient, 'download' | 'create' | 'upload'>,
  local: VaultHeaderFile,
  headerOnDrive: boolean,
): Promise<HeaderSync> {
  const name = vaultHeaderFileName(local.vaultId);
  const bytes = await drive.download(name);
  const write = (file: VaultHeaderFile): Bytes => new TextEncoder().encode(serializeVaultHeaderFile(file)) as Bytes;
  if (bytes === null) {
    if (headerOnDrive) return { kind: 'deleted' };
    await drive.create(name, write(local), 'application/json');
    return { kind: 'ready', name: null };
  }
  let remote: VaultHeaderFile;
  try {
    remote = parseVaultHeaderFile(new TextDecoder().decode(bytes));
  } catch {
    // A header we cannot read is not ours to replace.
    return { kind: 'conflict' };
  }
  if (remote.header !== local.header) return { kind: 'conflict' };
  if (remote.nameUpdatedAt > local.nameUpdatedAt) {
    return { kind: 'ready', name: { ciphertext: remote.nameCiphertext, updatedAt: remote.nameUpdatedAt } };
  }
  if (local.nameUpdatedAt > remote.nameUpdatedAt) {
    await drive.upload(name, write({ ...remote, nameCiphertext: local.nameCiphertext, nameUpdatedAt: local.nameUpdatedAt }), 'application/json');
  }
  return { kind: 'ready', name: null };
}

/** Deletes a vault's header and every device's snapshot from Drive. */
export async function deleteVaultFromDrive(
  drive: Pick<GoogleDriveClient, 'listFiles' | 'deleteFile'>,
  vaultId: VaultId,
): Promise<void> {
  // The header goes last: while snapshots remain, the vault still shows up and can be retried.
  const files = await drive.listFiles(`${PREFIX}${vaultId}.`);
  const header = vaultHeaderFileName(vaultId);
  for (const file of files.filter((f) => f.name !== header)) await drive.deleteFile(file.id);
  for (const file of files.filter((f) => f.name === header)) await drive.deleteFile(file.id);
}

/** Files from before vaults had ids (Task 11c); nothing reads them any more. */
const LEGACY_PREFIX = 'ankylock-';
const LEGACY_FILES = ['ankylock-snapshot.v1.bin', 'ankylock-vault-header.v1.json'];

export async function removeLegacyDriveFiles(drive: Pick<GoogleDriveClient, 'listFiles' | 'deleteFile'>): Promise<number> {
  const legacy = (await drive.listFiles(LEGACY_PREFIX)).filter((f) => LEGACY_FILES.includes(f.name));
  for (const file of legacy) await drive.deleteFile(file.id);
  return legacy.length;
}

async function listAnkyLockFiles(drive: Pick<GoogleDriveClient, 'listFiles'>): Promise<DriveFile[]> {
  return [...(await drive.listFiles(PREFIX)), ...(await drive.listFiles(LEGACY_PREFIX))];
}

/**
 * Deletes every AnkyLock file in appDataFolder (all vaults, every device's backups), then lists
 * the folder again. `remaining` is above zero when a deletion failed or another device uploaded
 * meanwhile; running it again picks up whatever is left.
 */
export async function deleteAllFromDrive(
  drive: Pick<GoogleDriveClient, 'listFiles' | 'deleteFile'>,
): Promise<{ readonly remaining: number }> {
  try {
    const files = await listAnkyLockFiles(drive);
    // Headers first: other devices then see their vaults as deleted and stop backing up into the
    // folder being emptied.
    const headers = files.filter((f) => HEADER_FILE.test(f.name));
    for (const file of [...headers, ...files.filter((f) => !headers.includes(f))]) {
      try {
        await drive.deleteFile(file.id);
      } catch (error) {
        // Already gone, e.g. deleted by another device at the same time.
        if (!(error instanceof DriveError && error.status === 404)) throw error;
      }
    }
  } catch {
    // Whatever is left is counted below, and a retry deletes it.
  }
  return { remaining: (await listAnkyLockFiles(drive)).length };
}

/** A vault found in Drive, with the snapshots its devices uploaded. */
export interface RemoteVault extends VaultHeaderFile {
  /** Newest snapshot upload, or null if no device backed up yet. */
  readonly lastBackupAt: EpochMs | null;
  readonly snapshots: readonly DriveFile[];
}

const decoder = new TextDecoder();

/** Lists the vaults in Drive, most recently backed up first. Malformed headers are skipped. */
export async function listRemoteVaults(
  drive: Pick<GoogleDriveClient, 'listFiles' | 'downloadFile'>,
): Promise<RemoteVault[]> {
  const files = await drive.listFiles(PREFIX);
  const snapshots = new Map<string, DriveFile[]>();
  for (const file of files) {
    const id = SNAPSHOT_FILE.exec(file.name)?.[1];
    if (id !== undefined) snapshots.set(id, [...(snapshots.get(id) ?? []), file]);
  }
  const vaults = await Promise.all(
    files
      .filter((file) => HEADER_FILE.test(file.name))
      .map(async (file): Promise<RemoteVault | null> => {
        try {
          const header = parseVaultHeaderFile(decoder.decode(await drive.downloadFile(file.id)));
          if (vaultHeaderFileName(header.vaultId) !== file.name) return null;
          const backups = snapshots.get(header.vaultId) ?? [];
          const lastBackupAt = backups.length === 0 ? null : (Math.max(...backups.map((b) => b.modifiedTime)) as EpochMs);
          return { ...header, lastBackupAt, snapshots: backups };
        } catch {
          return null;
        }
      }),
  );
  return vaults
    .filter((v): v is RemoteVault => v !== null)
    .sort((a, b) => (b.lastBackupAt ?? b.createdAt) - (a.lastBackupAt ?? a.createdAt));
}

/**
 * Downloads and opens every snapshot of a vault. A snapshot that cannot be opened with this
 * vault's key is skipped and counted, never trusted.
 */
export async function downloadSnapshots(
  drive: Pick<GoogleDriveClient, 'downloadFile'>,
  sealer: Sealer,
  vault: RemoteVault,
): Promise<{ readonly snapshots: Snapshot[]; readonly unreadable: number }> {
  const opened = await Promise.all(
    vault.snapshots.map(async (file) => {
      try {
        return await openSnapshot(sealer, (await drive.downloadFile(file.id)) as SealedBytes);
      } catch {
        return null;
      }
    }),
  );
  const snapshots = opened.filter((s): s is Snapshot => s !== null);
  return { snapshots, unreadable: opened.length - snapshots.length };
}

/** Per id, the most recently updated record. */
function newest<T extends { readonly id: string; readonly updatedAt: EpochMs }>(lists: readonly (readonly T[])[]): T[] {
  const byId = new Map<string, T>();
  for (const record of lists.flat()) {
    const current = byId.get(record.id);
    if (!current || record.updatedAt > current.updatedAt) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * Combines the snapshots of all devices into one vault. Note text merges through Yjs, so no
 * device's edits are lost (never last-write-wins for text). Names and hierarchy take the most
 * recently updated record; live hierarchy sync comes with Task 11e.
 */
export async function mergeSnapshots(sealer: Sealer, snapshots: readonly Snapshot[]): Promise<VaultImport> {
  const notes = newest<Note>(snapshots.map((s) => s.notes));
  const noteIds = new Set<string>(notes.map((n) => n.id));
  const contentsByNote = new Map<NoteId, NoteContent[]>();
  for (const content of snapshots.flatMap((s) => s.contents)) {
    if (noteIds.has(content.noteId)) contentsByNote.set(content.noteId, [...(contentsByNote.get(content.noteId) ?? []), content]);
  }
  const contents = await Promise.all(
    [...contentsByNote.entries()].map(async ([noteId, versions]) => {
      const latest = versions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      if (versions.length === 1) return latest;
      const doc = new Y.Doc();
      try {
        for (const version of versions) Y.applyUpdate(doc, await sealer.open(version.yjsUpdates));
        return await encodeNoteContent(sealer, noteId, doc, latest.titleCiphertext, latest.updatedAt);
      } finally {
        doc.destroy();
      }
    }),
  );
  const newestSnapshot = snapshots.reduce<Snapshot | null>((a, b) => (a === null || b.createdAt > a.createdAt ? b : a), null);
  return {
    retentionDays: newestSnapshot?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    categories: newest<Category>(snapshots.map((s) => s.categories)),
    folders: newest<Folder>(snapshots.map((s) => s.folders)),
    notes,
    contents,
  };
}
