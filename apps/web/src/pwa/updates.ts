import { SKIP_WAITING } from '../sw/cachePolicy.js';

/** The parts of `ServiceWorkerRegistration` / `ServiceWorkerContainer` used here; fakeable in tests. */
export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

export interface ContainerLike {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Calls `onUpdateReady` once a new ServiceWorker is installed and waiting behind the one that
 * controls this page. The callback receives `activate`, which tells the waiting worker to take
 * over; the page reloads once it does. The very first install (no controller yet) is not an update.
 */
export function watchForUpdates(
  container: ContainerLike,
  registration: RegistrationLike,
  onUpdateReady: (activate: () => void) => void,
  reload: () => void,
): void {
  let reloading = false;
  // A first visit gets its first controller when the new worker claims the page: not an update,
  // and reloading then would wipe whatever the user is typing (say, a new vault's passphrase).
  let controlled = Boolean(container.controller);
  container.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    reload();
  });

  const offer = (worker: WorkerLike): void => {
    if (container.controller) onUpdateReady(() => worker.postMessage(SKIP_WAITING));
  };

  if (registration.waiting) offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(installing);
    });
  });
}
