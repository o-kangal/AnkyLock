import { onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { TauriSqliteAdapter } from '@ankylock/storage';
import { AnkyLockApp, createRuntime } from '@ankylock/web/workspace';
import { TitleBar } from './TitleBar.jsx';

/**
 * Desktop composition: notes persist through Tauri IPC into SQLite in the Rust host, and all
 * encryption runs in a Dedicated Web Worker holding the vault key.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const runtime = createRuntime({
    storage: new TauriSqliteAdapter(),
    sealer,
    onError: (message) => console.error(message),
  });
  onCleanup(() => {
    sealer.dispose();
    worker.terminate();
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
      <TitleBar />
      <div style={{ flex: '1', 'min-height': '0' }}>
        <AnkyLockApp runtime={runtime} />
      </div>
    </div>
  );
}
