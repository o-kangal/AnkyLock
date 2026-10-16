import {
  isPurgeEligible,
  planRetentionChange,
  validateRetentionDays,
  type EpochMs,
  type FolderId,
  type NoteId,
  type RetentionChangePlan,
} from '@ankylock/core';
import { StorageError, type IStorageEngine } from '@ankylock/storage';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PurgedEntity =
  | { readonly entityType: 'note'; readonly id: NoteId }
  | { readonly entityType: 'folder'; readonly id: FolderId };

export interface RetentionDeps {
  readonly storage: IStorageEngine;
  readonly now?: () => EpochMs;
  /** Called for every purged entity, e.g. to queue a TOMBSTONE packet so other devices purge too. */
  readonly onPurged?: (entity: PurgedEntity) => Promise<void>;
  /** Failures for single items; the run continues with the rest. */
  readonly onError?: (error: unknown) => void;
  /** Checked before each purge; a run stops early once it returns false (the vault locked). */
  readonly active?: () => boolean;
}

const clock = (deps: RetentionDeps): EpochMs => deps.now?.() ?? (Date.now() as EpochMs);

/**
 * BR-LIFE-04: hard-deletes trashed folders and notes whose retention has elapsed
 * (`deleted_at + retention_days · 86400000 < now`, never when retention is 0). Folders go first:
 * purging one takes the notes and subfolders trashed with it. Storage writes the local
 * tombstones in the same transaction as each delete.
 */
export async function purgeExpired(deps: RetentionDeps): Promise<PurgedEntity[]> {
  const days = await deps.storage.getTrashRetentionDays();
  if (days === 0) return [];
  const now = clock(deps);
  const expired = (deletedAt: EpochMs | null): boolean => deletedAt !== null && isPurgeEligible(deletedAt, days, now);
  const purged: PurgedEntity[] = [];
  const report = async (entity: PurgedEntity): Promise<void> => {
    purged.push(entity);
    await deps.onPurged?.(entity);
  };

  const gone = new Set<FolderId>();
  const active = deps.active ?? (() => true);
  for (const folder of await deps.storage.listTrashedFolders()) {
    if (!active()) return purged;
    if (gone.has(folder.id) || !expired(folder.deletedAt)) continue;
    try {
      const result = await deps.storage.purgeFolder(folder.id);
      for (const id of result.folders) {
        gone.add(id);
        await report({ entityType: 'folder', id });
      }
      for (const id of result.notes) await report({ entityType: 'note', id });
    } catch (error) {
      deps.onError?.(error);
    }
  }
  for (const note of await deps.storage.listTrashedNotes()) {
    if (!active()) return purged;
    if (!expired(note.deletedAt)) continue;
    try {
      await deps.storage.purgeNote(note.id);
      await report({ entityType: 'note', id: note.id });
    } catch (error) {
      deps.onError?.(error);
    }
  }
  return purged;
}

export type RetentionChangeResult = RetentionChangePlan | { readonly kind: 'applied'; readonly purged: PurgedEntity[] };

/**
 * Changes the retention setting (BR-LIFE-03). If the shorter value would purge items right away,
 * nothing is stored or purged until the caller repeats the call with `confirmed: true` (SPEC §6).
 */
export async function changeTrashRetention(
  deps: RetentionDeps,
  newDays: number,
  options: { readonly confirmed: boolean },
): Promise<RetentionChangeResult> {
  const valid = validateRetentionDays(newDays);
  if (!valid.ok) throw new StorageError(valid.error.code, valid.error.message);
  const [oldDays, notes, folders] = await Promise.all([
    deps.storage.getTrashRetentionDays(),
    deps.storage.listTrashedNotes(),
    deps.storage.listTrashedFolders(),
  ]);
  const trashedAt = [...notes, ...folders].flatMap((item) => (item.deletedAt === null ? [] : [item.deletedAt]));
  const plan = planRetentionChange(oldDays, valid.value, trashedAt, clock(deps));
  if (plan.kind === 'confirm_required' && !options.confirmed) return plan;
  await deps.storage.setTrashRetentionDays(valid.value);
  return { kind: 'applied', purged: await purgeExpired(deps) };
}

export interface RetentionWorker {
  /** Runs a purge now unless one is already running; resolves with what was purged. */
  runNow(): Promise<PurgedEntity[]>;
  stop(): void;
}

/**
 * Background purge: once at startup and then every 24 hours. It only awaits storage calls
 * (async IPC on desktop, IndexedDB on web), so it never blocks the UI thread.
 */
export function startRetentionWorker(deps: RetentionDeps & { readonly intervalMs?: number }): RetentionWorker {
  let running: Promise<PurgedEntity[]> | null = null;
  let stopped = false;

  const runNow = (): Promise<PurgedEntity[]> => {
    running ??= purgeExpired({ ...deps, active: () => !stopped && (deps.active?.() ?? true) })
      .catch((error: unknown) => {
        deps.onError?.(error);
        return [];
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? DAY_MS);
  return {
    runNow,
    // Also ends a run in progress: nothing is purged once the vault is locked.
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
