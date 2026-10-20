import type { Runtime } from './createRuntime.js';

/** How long closing waits for a last backup before asking the user (desktop) or giving up (web). */
export const CLOSE_BACKUP_WAIT_MS = 10_000;

type Guarded = Pick<Runtime, 'hasUnbackedChanges' | 'backUpBeforeClose'>;
type EventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface PageCloseGuard {
  /** Lets the next unload pass without a warning (e.g. reloading into a new app version). */
  release(): void;
  dispose(): void;
}

/**
 * Web: leaving the page with changes not yet on Google Drive shows the browser's own warning
 * (browsers do not let pages wait or choose its text) and starts a backup meanwhile. Notes are
 * already saved on this device; only the Drive copy is behind. No backups (signed out, local
 * only), no warning.
 */
export function guardPageClose(runtime: Guarded, target: EventTarget = window): PageCloseGuard {
  let released = false;
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (released || !runtime.hasUnbackedChanges()) return;
    event.preventDefault();
    void runtime.backUpBeforeClose(CLOSE_BACKUP_WAIT_MS);
  };
  target.addEventListener('beforeunload', onBeforeUnload);
  return {
    release: () => {
      released = true;
    },
    dispose: () => target.removeEventListener('beforeunload', onBeforeUnload),
  };
}
