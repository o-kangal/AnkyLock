import type { EpochMs, NoteId, SealedBytes, VaultId } from '@ankylock/core';
import type { Sealer } from '@ankylock/crypto';
import type { IStorageEngine } from '@ankylock/storage';
import type { DriveFile, GoogleDriveClient } from '../backup/googleDriveClient.js';
import { openSnapshot, type Snapshot } from '../backup/snapshot.js';
import { vaultSnapshotFileName, vaultSnapshotPrefix } from '../backup/vaultCatalog.js';
import type { DocManager } from '../crdt/docManager.js';
import { applyRemoteRecords, applyRemoteTombstone } from '../hierarchy/hierarchySync.js';
import { mergeNoteUpdate } from '../persistence/notePersistence.js';

export interface CatchUpOptions {
  readonly drive: Pick<GoogleDriveClient, 'listFiles' | 'downloadFile'>;
  readonly storage: IStorageEngine;
  readonly sealer: Sealer;
  readonly docs: DocManager;
  readonly vaultId: VaultId;
  /** This device's own snapshot holds nothing it is missing. */
  readonly deviceId: string;
}

export interface CatchUpResult {
  /** Notes added, changed or removed here. */
  readonly changedNotes: NoteId[];
  /** Hierarchy or metadata may have changed: reload the sidebar. */
  readonly changed: boolean;
  /** Snapshots that could not be opened with this vault's key and were skipped. */
  readonly unreadable: number;
}

export interface CatchUp {
  /** Merges the snapshots other devices uploaded since the last run. Runs never overlap. */
  run(): Promise<CatchUpResult>;
}

/**
 * The relay keeps no history, so a device that was closed misses what others sent meanwhile.
 * Catching up merges the other devices' Drive snapshots into local data: purges first, then
 * records (newer clock wins, hierarchy repaired), then note text through Yjs (never
 * last-write-wins). Snapshots already merged are skipped until their device uploads again.
 */
export function createCatchUp(options: CatchUpOptions): CatchUp {
  const { drive, storage, sealer, docs } = options;
  const ownFile = vaultSnapshotFileName(options.vaultId, options.deviceId);
  const prefix = vaultSnapshotPrefix(options.vaultId);
  /** Drive file id → modified time of the version already merged. */
  const merged = new Map<string, EpochMs>();
  let running: Promise<CatchUpResult> | null = null;

  async function apply(snapshot: Snapshot, changedNotes: Set<NoteId>): Promise<void> {
    for (const tombstone of snapshot.tombstones) {
      if (await applyRemoteTombstone(storage, tombstone.entityId, tombstone.entityType)) {
        if (tombstone.entityType === 'note') changedNotes.add(tombstone.entityId as NoteId);
      }
    }
    await applyRemoteRecords(storage, { categories: snapshot.categories, folders: snapshot.folders, notes: snapshot.notes });
    const purged = new Set((await storage.listTombstones()).map((t) => t.entityId));
    for (const content of snapshot.contents) {
      if (purged.has(content.noteId)) continue;
      const update = await sealer.open(content.yjsUpdates);
      const changed = docs.applyRemote(content.noteId, update) || (await mergeNoteUpdate({ storage, sealer }, content.noteId, update));
      if (changed) changedNotes.add(content.noteId);
    }
  }

  async function run(): Promise<CatchUpResult> {
    const fresh = (await drive.listFiles(prefix)).filter(
      (file: DriveFile) => file.name !== ownFile && (merged.get(file.id) ?? -1) < file.modifiedTime,
    );
    const changedNotes = new Set<NoteId>();
    let unreadable = 0;
    for (const file of fresh) {
      let snapshot: Snapshot;
      try {
        snapshot = await openSnapshot(sealer, (await drive.downloadFile(file.id)) as SealedBytes);
      } catch {
        unreadable++;
        continue;
      }
      await apply(snapshot, changedNotes);
      merged.set(file.id, file.modifiedTime);
    }
    return { changedNotes: [...changedNotes], changed: fresh.length > unreadable, unreadable };
  }

  return {
    run() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
