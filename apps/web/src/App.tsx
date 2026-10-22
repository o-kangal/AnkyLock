import { createSignal, onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { WebVaultDirectory } from '@ankylock/storage';
import { createAuthSession } from '@ankylock/sync';
import { createWebAuthTransport } from './auth/webGoogleAuth.js';
import { AnkyLockApp } from './components/AnkyLockApp.jsx';
import { UpdateBanner } from './pwa/UpdateBanner.jsx';
import { watchForUpdates } from './pwa/updates.js';
import { guardPageClose } from './runtime/closeGuard.js';
import { createRuntime } from './runtime/createRuntime.js';
import { buildRelayUrl } from './preferences/devicePreferences.js';

/**
 * Web composition: each vault's notes persist encrypted in their own IndexedDB database and all encryption runs in a Dedicated
 * Web Worker holding the vault key. Same shell as the desktop app.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  // Without a configured Google client the app is local-only (no sync, no Drive backup).
  const auth = clientId
    ? createAuthSession(
        createWebAuthTransport({ clientId, redirectUri: `${window.location.origin}/oauth-callback.html` }),
        { onError: (error) => console.error(error) },
      )
    : undefined;
  const runtime = createRuntime({
    vaults: new WebVaultDirectory(indexedDB),
    sealer,
    // No own-relay setting: the production CSP allows only the relay this build was given.
    ...(auth ? { auth, ...buildRelayUrl(import.meta.env) } : {}),
    onError: (message) => console.error(message),
  });
  const closeGuard = guardPageClose(runtime);
  onCleanup(() => {
    closeGuard.dispose();
    auth?.dispose();
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
          // Edits were saved before activating (beforeReload); a reload is not leaving the app.
          closeGuard.release();
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
