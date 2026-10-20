import type { Runtime } from '@ankylock/web/workspace';

/** `backing-up`: a last backup runs before the window closes. `unbacked`: it failed or took too long. */
export type CloseState = 'open' | 'backing-up' | 'unbacked';

export interface ClosableWindow {
  onCloseRequested(handler: (event: { preventDefault(): void }) => Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

export interface WindowCloseGuard {
  /** Closes now, without waiting for a backup ("Quit anyway"). */
  quit(): Promise<void>;
  /** Keeps the app open ("Wait"); closing again tries the backup again. */
  stay(): void;
  dispose(): void;
}

/**
 * Desktop: closing the window with changes not yet on Google Drive backs up first, then closes.
 * If the backup fails or takes longer than `waitMs`, the window stays open and the user chooses.
 * Edits are saved on this device either way; only the Drive copy would be behind.
 */
export function guardWindowClose(
  appWindow: ClosableWindow,
  runtime: Pick<Runtime, 'hasUnbackedChanges' | 'backUpBeforeClose'>,
  onState: (state: CloseState) => void,
  waitMs: number,
): WindowCloseGuard {
  let quitting = false;
  const unlisten = appWindow.onCloseRequested(async (event) => {
    if (quitting) return;
    if (runtime.hasUnbackedChanges()) onState('backing-up');
    // Also saves pending edits locally, so even a clean close loses no typing.
    const result = await runtime.backUpBeforeClose(waitMs);
    if (result === 'clean' || result === 'ok') return;
    event.preventDefault();
    onState('unbacked');
  });
  return {
    async quit() {
      quitting = true;
      await appWindow.destroy();
    },
    stay: () => onState('open'),
    dispose: () => void unlisten.then((stop) => stop()),
  };
}
