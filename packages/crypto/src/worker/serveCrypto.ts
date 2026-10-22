import type { Bytes } from '@ankylock/core';
import { CryptoError } from '../errors.js';
import { createKeySealer } from '../sealer.js';
import { isCryptoRequest, type CryptoResponse, type MessagePortLike } from './protocol.js';

/**
 * Worker side of the crypto bridge: holds the MEK and answers seal/open requests.
 * Returns a function that stops listening.
 */
export function serveCrypto(port: MessagePortLike): () => void {
  let key: CryptoKey | null = null;
  const sealer = createKeySealer(() => {
    if (key === null) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
    return key;
  });

  const listener = (event: MessageEvent): void => {
    const request: unknown = event.data;
    if (!isCryptoRequest(request)) return;
    void (async () => {
      let response: CryptoResponse;
      let data: Bytes | null = null;
      try {
        if (request.op === 'setKey') key = request.key;
        else if (request.op === 'seal') data = await sealer.seal(request.data, request.context);
        else data = await sealer.open(request.data, request.context);
        response = { id: request.id, ok: true, data };
      } catch (error) {
        const known = error instanceof CryptoError ? error : new CryptoError('ERR_WORKER_FAILURE', 'Crypto worker failed.');
        response = { id: request.id, ok: false, code: known.code, message: known.message };
      }
      // Results are freshly allocated in the worker, so their buffers can be transferred.
      port.postMessage(response, data === null ? [] : [data.buffer]);
    })();
  };

  port.addEventListener('message', listener);
  port.start?.();
  return () => port.removeEventListener('message', listener);
}
