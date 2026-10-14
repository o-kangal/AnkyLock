import { createSignal, onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { WebVaultDirectory } from '@ankylock/storage';
import { AnkyLockApp } from './components/AnkyLockApp.jsx';
import { UpdateBanner } from './pwa/UpdateBanner.jsx';
import { watchForUpdates } from './pwa/updates.js';
import { createRuntime } from './runtime/createRuntime.js';

/**
 * Web composition: each vault's notes persist encrypted in their own IndexedDB database and all encryption runs in a Dedicated
 * Web Worker holding the vault key. Same shell as the desktop app.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const runtime = createRuntime({
    vaults: new WebVaultDirectory(indexedDB),
    sealer,
    onError: (message) => console.error(message),
  });
  onCleanup(() => {
    sealer.dispose();
    worker.terminate();
  });

  // Offline app shell (installable PWA). Skipped in dev so stale caches never hide code changes.
  const [activateUpdate, setActivateUpdate] = createSignal<(() => void) | null>(null);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) =>
        watchForUpdates(navigator.serviceWorker, registration, (activate) => setActivateUpdate(() => activate), () => {
          window.location.reload();
        }),
      )
      .catch((error: unknown) => console.error('ServiceWorker registration failed', error));
  }

  return (
    <>
      <AnkyLockApp runtime={runtime} />
      <UpdateBanner activate={activateUpdate()} beforeReload={() => runtime.flush()} />
    </>
  );
}
