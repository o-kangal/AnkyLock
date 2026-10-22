import type { Bytes, Ciphertext, SealedBytes } from '@ankylock/core';
import { base64ToBytes, bytesToBase64, open, seal } from './cipher.js';

/**
 * Encrypts and decrypts opaque payloads under the vault key. Sync code depends only on this.
 * `context` (authenticated, not encrypted) must be the same to open as it was to seal.
 */
export interface Sealer {
  seal(plaintext: Bytes, context?: Bytes): Promise<SealedBytes>;
  open(sealed: SealedBytes, context?: Bytes): Promise<Bytes>;
}

/** Same-thread sealer; runs inside the crypto worker and in tests. `getKey` throws while locked. */
export function createKeySealer(getKey: () => CryptoKey): Sealer {
  return {
    seal: async (plaintext, context) => seal(getKey(), plaintext, context),
    open: async (sealed, context) => open(getKey(), sealed, context),
  };
}

/** Encrypts short strings (names, titles) into `*_ciphertext` TEXT values through any Sealer. */
export interface TextCodec {
  encrypt(plaintext: string): Promise<Ciphertext>;
  decrypt(ciphertext: Ciphertext): Promise<string>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function createTextCodec(sealer: Sealer): TextCodec {
  return {
    encrypt: async (plaintext) => bytesToBase64(await sealer.seal(textEncoder.encode(plaintext))) as Ciphertext,
    decrypt: async (ciphertext) => textDecoder.decode(await sealer.open(base64ToBytes(ciphertext) as SealedBytes)),
  };
}
