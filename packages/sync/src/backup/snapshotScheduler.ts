import type { EpochMs, SealedBytes } from '@ankylock/core';
import { DriveError, type DriveErrorKind, type GoogleDriveClient } from './googleDriveClient.js';
import { SNAPSHOT_FILE_NAME, VAULT_HEADER_FILE_NAME } from './snapshot.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Shown as a non-intrusive status badge; `snapshot` means the local export itself failed. */
export type BackupStatus =
  | { readonly kind: 'never' }
  | { readonly kind: 'ok'; readonly at: EpochMs }
  | { readonly kind: 'error'; readonly reason: DriveErrorKind | 'snapshot'; readonly at: EpochMs };

export interface SnapshotSchedulerOptions {
  readonly drive: Pick<GoogleDriveClient, 'upload'>;
  /** Produces the sealed snapshot (see `exportSnapshot`). */
  readonly createSnapshot: () => Promise<SealedBytes>;
  /** Serialized vault header for recovery on a new device; null while no vault exists. */
  readonly vaultHeader: () => string | null;
  readonly onStatus: (status: BackupStatus) => void;
  readonly now?: () => EpochMs;
  readonly intervalMs?: number;
  /** Idle-triggered runs are skipped if a backup succeeded more recently than this. */
  readonly idleMinGapMs?: number;
}

export interface SnapshotScheduler {
  start(): void;
  stop(): void;
  /** Never throws: failures are reported through `onStatus` and never block local saves or sync. */
  runNow(): Promise<BackupStatus>;
  /** Hint that the network is idle (e.g. outbox drained); backs up if the last success is old enough. */
  notifyIdle(): void;
}

/** Cold backup to Drive every 24 hours, plus opportunistic runs when the network is idle. */
export function createSnapshotScheduler(options: SnapshotSchedulerOptions): SnapshotScheduler {
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<BackupStatus> | null = null;
  let lastSuccess: EpochMs | null = null;

  async function backup(): Promise<BackupStatus> {
    let snapshot: SealedBytes;
    try {
      snapshot = await options.createSnapshot();
    } catch {
      return { kind: 'error', reason: 'snapshot', at: now() };
    }
    try {
      const header = options.vaultHeader();
      if (header !== null) {
        await options.drive.upload(VAULT_HEADER_FILE_NAME, new TextEncoder().encode(header), 'application/json');
      }
      await options.drive.upload(SNAPSHOT_FILE_NAME, snapshot, 'application/octet-stream');
    } catch (error) {
      return { kind: 'error', reason: error instanceof DriveError ? error.kind : 'http', at: now() };
    }
    lastSuccess = now();
    return { kind: 'ok', at: lastSuccess };
  }

  function runNow(): Promise<BackupStatus> {
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

  return {
    runNow,
    start() {
      timer ??= setInterval(() => void runNow(), options.intervalMs ?? DAY_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    notifyIdle() {
      if (lastSuccess === null || now() - lastSuccess >= (options.idleMinGapMs ?? HOUR_MS)) void runNow();
    },
  };
}
