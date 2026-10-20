import type { EpochMs, SealedBytes } from '@ankylock/core';
import { AuthError } from '../auth/googleAuth.js';
import { DriveError, type DriveErrorKind, type GoogleDriveClient } from './googleDriveClient.js';

/** Periodic backups run this often, and only when something changed. */
export const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Shown as a non-intrusive status badge. `snapshot`: the local export itself failed.
 * `conflict`: Drive holds a different header for this vault id, so nothing is uploaded.
 * `deleted`: another device deleted the vault from Drive; it is not uploaded again.
 */
export type BackupStatus =
  | { readonly kind: 'never' }
  /** A backup is being exported and uploaded right now. */
  | { readonly kind: 'running' }
  | { readonly kind: 'ok'; readonly at: EpochMs }
  | { readonly kind: 'error'; readonly reason: DriveErrorKind | 'snapshot' | 'conflict' | 'deleted'; readonly at: EpochMs };

export interface SnapshotSchedulerOptions {
  readonly drive: Pick<GoogleDriveClient, 'upload'>;
  /** Produces the sealed snapshot (see `exportSnapshot`). */
  readonly createSnapshot: () => Promise<SealedBytes>;
  /** This device's own snapshot file (see `vaultSnapshotFileName`). */
  readonly snapshotFile: string;
  /** Makes sure the vault's header file is in place first (see `syncHeaderFile`); null when ready. */
  readonly prepare: () => Promise<'conflict' | 'deleted' | null>;
  readonly onStatus: (status: BackupStatus) => void;
  readonly now?: () => EpochMs;
  /** Default `BACKUP_INTERVAL_MS`. */
  readonly intervalMs?: number;
  /** Idle-triggered runs are skipped if a backup succeeded more recently than this. */
  readonly idleMinGapMs?: number;
}

export interface SnapshotScheduler {
  start(): void;
  stop(): void;
  /** Never throws: failures are reported through `onStatus` and never block local saves or sync. */
  runNow(): Promise<BackupStatus>;
  /** Like `runNow`, but only when something changed since the last successful backup; else null. */
  runIfChanged(): Promise<BackupStatus | null>;
  /** Hint that the network is idle (e.g. outbox drained); backs up changes if the last success is old enough. */
  notifyIdle(): void;
  /** The vault changed (text, hierarchy or settings). */
  markChanged(): void;
  /** Something changed since the last successful backup. True until the first one succeeds. */
  hasChanges(): boolean;
}

/**
 * Cold backup to Drive every few minutes while something changed, plus opportunistic runs when
 * the network is idle. A new scheduler starts out changed: whatever happened before it existed
 * (e.g. edits while signed out) has not been backed up.
 */
export function createSnapshotScheduler(options: SnapshotSchedulerOptions): SnapshotScheduler {
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<BackupStatus> | null = null;
  let lastSuccess: EpochMs | null = null;
  // Change counters: a backup covers the changes made before its snapshot was taken.
  let changes = 1;
  let backedUp = 0;
  const hasChanges = (): boolean => changes !== backedUp;

  async function backup(): Promise<BackupStatus> {
    const covers = changes;
    let snapshot: SealedBytes;
    try {
      snapshot = await options.createSnapshot();
    } catch {
      return { kind: 'error', reason: 'snapshot', at: now() };
    }
    try {
      const blocked = await options.prepare();
      if (blocked !== null) return { kind: 'error', reason: blocked, at: now() };
      await options.drive.upload(options.snapshotFile, snapshot, 'application/octet-stream');
    } catch (error) {
      const reason = error instanceof DriveError ? error.kind : error instanceof AuthError ? 'auth' : 'http';
      return { kind: 'error', reason, at: now() };
    }
    lastSuccess = now();
    backedUp = covers;
    return { kind: 'ok', at: lastSuccess };
  }

  function runNow(): Promise<BackupStatus> {
    if (!running) options.onStatus({ kind: 'running' });
    running ??= backup()
      .then((status) => {
        options.onStatus(status);
        return status;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  const runIfChanged = (): Promise<BackupStatus | null> => (hasChanges() ? runNow() : Promise.resolve(null));

  return {
    runNow,
    runIfChanged,
    hasChanges,
    markChanged() {
      changes++;
    },
    start() {
      timer ??= setInterval(() => void runIfChanged(), options.intervalMs ?? BACKUP_INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    notifyIdle() {
      if (!hasChanges()) return;
      if (lastSuccess === null || now() - lastSuccess >= (options.idleMinGapMs ?? HOUR_MS)) void runNow();
    },
  };
}
