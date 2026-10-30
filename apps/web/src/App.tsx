import { createSignal, onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { WebVaultDirectory } from '@ankylock/storage';
import { createAuthSession } from '@ankylock/sync';
import { createWebAuthTransport, OAUTH_CALLBACK_PATH } from './auth/webGoogleAuth.js';
import { AnkyLockApp } from './components/AnkyLockApp.jsx';
import { t } from './i18n/index.js';
import { InstallBanner } from './pwa/InstallBanner.jsx';
import { createInstallSuggestion } from './pwa/install.js';
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
  const sealer = createWorkerSealer(worker);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  // Without a configured Google client the app is local-only (no sync, no Drive backup).
  const auth = clientId
    ? createAuthSession(
        createWebAuthTransport({ clientId, redirectUri: `${window.location.origin}${OAUTH_CALLBACK_PATH}` }),
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
  const install = createInstallSuggestion();
  onCleanup(() => {
    closeGuard.dispose();
    install.dispose();
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
      {/* Asked once a vault is open, and never over a pending update. */}
      <InstallBanner
        suggestion={runtime.status() === 'unlocked' && activateUpdate() === null ? install.suggestion() : null}
        onLater={() => install.later()}
        onNever={() => install.never()}
      />
      <UpdateBanner
        update={(() => {
          const activate = activateUpdate();
          return activate
            ? {
                message: t('update.available'),
                action: t('update.reload'),
                busy: t('update.saving'),
                apply: async () => {
                  await runtime.flush();
                  activate();
                },
              }
            : null;
        })()}
      />
    </>
  );
}
