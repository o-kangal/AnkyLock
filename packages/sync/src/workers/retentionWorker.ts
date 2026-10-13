import {
  isPurgeEligible,
  planRetentionChange,
  validateRetentionDays,
  type EpochMs,
  type NoteId,
  type RetentionChangePlan,
} from '@ankylock/core';
import { StorageError, type IStorageEngine } from '@ankylock/storage';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  readonly storage: IStorageEngine;
  readonly now?: () => EpochMs;
  /** Called after each purge, e.g. to queue a TOMBSTONE packet so other devices purge too. */
  readonly onPurged?: (noteId: NoteId) => Promise<void>;
  /** Failures for single notes; the run continues with the rest. */
  readonly onError?: (error: unknown) => void;
}

const clock = (deps: RetentionDeps): EpochMs => deps.now?.() ?? (Date.now() as EpochMs);

/**
 * BR-LIFE-04: hard-deletes trashed notes whose retention has elapsed
 * (`deleted_at + retention_days · 86400000 < now`, never when retention is 0). Storage writes
 * the local tombstone in the same transaction as the delete.
 */
export async function purgeExpiredNotes(deps: RetentionDeps): Promise<NoteId[]> {
  const days = await deps.storage.getTrashRetentionDays();
  if (days === 0) return [];
  const now = clock(deps);
  const purged: NoteId[] = [];
  for (const note of await deps.storage.listTrashedNotes()) {
    if (note.deletedAt === null || !isPurgeEligible(note.deletedAt, days, now)) continue;
    try {
      await deps.storage.purgeNote(note.id);
      purged.push(note.id);
      await deps.onPurged?.(note.id);
    } catch (error) {
      deps.onError?.(error);
    }
  }
  return purged;
}

export type RetentionChangeResult = RetentionChangePlan | { readonly kind: 'applied'; readonly purged: NoteId[] };

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
  const [oldDays, trashed] = await Promise.all([deps.storage.getTrashRetentionDays(), deps.storage.listTrashedNotes()]);
  const trashedAt = trashed.flatMap((n) => (n.deletedAt === null ? [] : [n.deletedAt]));
  const plan = planRetentionChange(oldDays, valid.value, trashedAt, clock(deps));
  if (plan.kind === 'confirm_required' && !options.confirmed) return plan;
  await deps.storage.setTrashRetentionDays(valid.value);
  return { kind: 'applied', purged: await purgeExpiredNotes(deps) };
}

export interface RetentionWorker {
  /** Runs a purge now unless one is already running; resolves with the purged ids. */
  runNow(): Promise<NoteId[]>;
  stop(): void;
}

/**
 * Background purge: once at startup and then every 24 hours. It only awaits storage calls
 * (async IPC on desktop, IndexedDB on web), so it never blocks the UI thread.
 */
export function startRetentionWorker(deps: RetentionDeps & { readonly intervalMs?: number }): RetentionWorker {
  let running: Promise<NoteId[]> | null = null;

  const runNow = (): Promise<NoteId[]> => {
    running ??= purgeExpiredNotes(deps)
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
  return { runNow, stop: () => clearInterval(timer) };
}
