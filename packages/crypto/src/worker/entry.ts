import type { MessagePortLike } from './protocol.js';
import { serveCrypto } from './serveCrypto.js';

/**
 * Dedicated Web Worker entry. Apps start it with
 * `new Worker(new URL('@ankylock/crypto/worker', import.meta.url), { type: 'module' })`
 * and pass the Worker to `createWorkerSealer`.
 */
// The shared tsconfig types `self` as Window; inside a worker it is the worker's global scope.
serveCrypto(self as unknown as MessagePortLike);
