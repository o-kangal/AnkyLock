import type { Bytes, SealedBytes } from '@ankylock/core';
import { CryptoError } from '../errors.js';
import type { Sealer } from '../sealer.js';
import { isCryptoResponse, type CryptoRequest, type MessagePortLike } from './protocol.js';

export interface WorkerSealer extends Sealer {
  /** Hands the non-extractable MEK to the worker at unlock, or clears it (`null`) at lock. */
  setKey(key: CryptoKey | null): Promise<void>;
  /** Stops listening and rejects in-flight requests. */
  dispose(): void;
}

type RequestBody = CryptoRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Main-thread client of `serveCrypto`; keeps encryption off the UI thread. */
export function createWorkerSealer(port: MessagePortLike): WorkerSealer {
  let nextId = 1;
  const pending = new Map<number, { resolve: (data: Bytes | null) => void; reject: (error: CryptoError) => void }>();

  const listener = (event: MessageEvent): void => {
    const response: unknown = event.data;
    if (!isCryptoResponse(response)) return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.data);
    else waiter.reject(new CryptoError(response.code, response.message));
  };
  port.addEventListener('message', listener);
  port.start?.();

  function request(body: RequestBody): Promise<Bytes | null> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Inputs are not transferred: callers may still hold and reuse their buffers.
      port.postMessage({ ...body, id }, []);
    });
  }

  async function requireData(body: RequestBody): Promise<Bytes> {
    const data = await request(body);
    if (data === null) throw new CryptoError('ERR_WORKER_FAILURE', 'Crypto worker returned no data.');
    return data;
  }

  return {
    async setKey(key) {
      await request({ op: 'setKey', key });
    },
    async seal(plaintext) {
      return (await requireData({ op: 'seal', data: plaintext })) as SealedBytes;
    },
    open(sealed) {
      return requireData({ op: 'open', data: sealed });
    },
    dispose() {
      port.removeEventListener('message', listener);
      for (const waiter of pending.values()) {
        waiter.reject(new CryptoError('ERR_WORKER_FAILURE', 'Crypto worker was disposed.'));
      }
      pending.clear();
    },
  };
}
