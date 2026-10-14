import type { EpochMs, SealedBytes } from '@ankylock/core';
import { DriveError, type DriveErrorKind, type GoogleDriveClient } from './googleDriveClient.js';
import {
  parseVaultHeaderFile,
  serializeVaultHeaderFile,
  vaultHeaderFileName,
  vaultSnapshotFileName,
  type VaultHeaderFile,
} from './vaultCatalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Shown as a non-intrusive status badge. `snapshot`: the local export itself failed.
 * `conflict`: Drive holds a different header for this vault id, so nothing is uploaded.
 */
export type BackupStatus =
  | { readonly kind: 'never' }
  | { readonly kind: 'ok'; readonly at: EpochMs }
  | { readonly kind: 'error'; readonly reason: DriveErrorKind | 'snapshot' | 'conflict'; readonly at: EpochMs };

export interface SnapshotSchedulerOptions {
  readonly drive: Pick<GoogleDriveClient, 'upload' | 'create' | 'download'>;
  /** Produces the sealed snapshot (see `exportSnapshot`). */
  readonly createSnapshot: () => Promise<SealedBytes>;
  /** The open vault's header file, uploaded once so a new device can open the vault. */
  readonly vault: VaultHeaderFile;
  /** This device's id within the vault; names its own snapshot file. */
  readonly deviceId: string;
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

class HeaderConflict extends Error {}

/**
 * Cold backup to Drive every 24 hours, plus opportunistic runs when the network is idle. The
 * vault's header file is created once and never overwritten; if Drive holds a different one for
 * this vault id, backups stop rather than mixing two keys under one vault (BR-SEC-04).
 */
export function createSnapshotScheduler(options: SnapshotSchedulerOptions): SnapshotScheduler {
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  const { vault, drive } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<BackupStatus> | null = null;
  let lastSuccess: EpochMs | null = null;
  let headerChecked = false;

  async function ensureHeader(): Promise<void> {
    if (headerChecked) return;
    const name = vaultHeaderFileName(vault.vaultId);
    const existing = await drive.download(name);
    if (existing === null) {
      await drive.create(name, new TextEncoder().encode(serializeVaultHeaderFile(vault)), 'application/json');
    } else {
      let remoteHeader: string | null = null;
      try {
        remoteHeader = parseVaultHeaderFile(new TextDecoder().decode(existing)).header;
      } catch {
        // A header we cannot read is not ours to replace.
      }
      if (remoteHeader !== vault.header) throw new HeaderConflict();
    }
    headerChecked = true;
  }

  async function backup(): Promise<BackupStatus> {
    let snapshot: SealedBytes;
    try {
      snapshot = await options.createSnapshot();
    } catch {
      return { kind: 'error', reason: 'snapshot', at: now() };
    }
    try {
      await ensureHeader();
      await drive.upload(vaultSnapshotFileName(vault.vaultId, options.deviceId), snapshot, 'application/octet-stream');
    } catch (error) {
      const reason = error instanceof HeaderConflict ? 'conflict' : error instanceof DriveError ? error.kind : 'http';
      return { kind: 'error', reason, at: now() };
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
