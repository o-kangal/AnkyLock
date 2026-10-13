import type { Bytes, SealedBytes } from '@ankylock/core';
import { open, seal } from './cipher.js';

/** Encrypts and decrypts opaque payloads under the vault key. Sync code depends only on this. */
export interface Sealer {
  seal(plaintext: Bytes): Promise<SealedBytes>;
  open(sealed: SealedBytes): Promise<Bytes>;
}

/** Same-thread sealer; runs inside the crypto worker and in tests. `getKey` throws while locked. */
export function createKeySealer(getKey: () => CryptoKey): Sealer {
  return {
    seal: async (plaintext) => seal(getKey(), plaintext),
    open: async (sealed) => open(getKey(), sealed),
  };
}
