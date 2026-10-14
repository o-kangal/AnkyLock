import * as Y from 'yjs';
import {
  DEFAULT_RETENTION_DAYS,
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
import type { DriveFile, GoogleDriveClient } from './googleDriveClient.js';
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
}

export function serializeVaultHeaderFile(file: VaultHeaderFile): string {
  return JSON.stringify({ version: 1, ...file });
}

export function parseVaultHeaderFile(json: string): VaultHeaderFile {
  const value: unknown = JSON.parse(json);
  const { version, vaultId, createdAt, header, nameCiphertext } = (typeof value === 'object' && value !== null
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
  };
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
