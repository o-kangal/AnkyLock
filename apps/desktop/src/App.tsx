import { invoke } from '@tauri-apps/api/core';
import { onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { TauriVaultDirectory } from '@ankylock/storage';
import { createAuthSession } from '@ankylock/sync';
import { AnkyLockApp, createRuntime } from '@ankylock/web/workspace';
import { createTauriAuthTransport } from './googleAuthTransport.js';
import { TitleBar } from './TitleBar.jsx';

/**
 * Desktop composition: notes persist through Tauri IPC into one SQLite database per vault in the
 * Rust host, and all
 * encryption runs in a Dedicated Web Worker holding the vault key.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const auth = createAuthSession(createTauriAuthTransport(), { onError: (error) => console.error(error) });
  const runtime = createRuntime({
    vaults: new TauriVaultDirectory(),
    sealer,
    auth,
    relayUrl: import.meta.env.VITE_RELAY_URL ?? 'ws://127.0.0.1:8787/ws',
    onError: (message) => console.error(message),
  });
  onCleanup(() => {
    auth.dispose();
    sealer.dispose();
    worker.terminate();
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
      <TitleBar />
      <div style={{ flex: '1', 'min-height': '0' }}>
        <AnkyLockApp
          runtime={runtime}
          platform="desktop"
          // The host checks the scheme again and hands the link to the system browser.
          openLink={(url) => void invoke('link_open', { url }).catch((error: unknown) => console.error(error))}
        />
      </div>
    </div>
  );
}
