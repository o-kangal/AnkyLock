import { onCleanup, type JSX } from 'solid-js';
import { createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import { AnkyLockApp } from './components/AnkyLockApp.jsx';
import { createRuntime } from './runtime/createRuntime.js';

/**
 * Web composition: notes persist encrypted in IndexedDB and all encryption runs in a Dedicated
 * Web Worker holding the vault key. Same shell as the desktop app.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const runtime = createRuntime({
    storage: new WebIndexedDbAdapter(indexedDB),
    sealer,
    onError: (message) => console.error(message),
  });
  onCleanup(() => {
    sealer.dispose();
    worker.terminate();
  });
  return <AnkyLockApp runtime={runtime} />;
}
