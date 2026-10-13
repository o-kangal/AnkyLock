import type { Bytes } from '@ankylock/core';
import { CryptoError } from './errors.js';

export const PBKDF2_ITERATIONS = 100_000;
export const SALT_LENGTH = 16;

/** Stored next to the vault so iterations can be raised later without breaking existing vaults. */
export interface KdfParams {
  readonly algorithm: 'PBKDF2-SHA256';
  readonly salt: Bytes;
  readonly iterations: number;
}

export function generateKdfParams(): KdfParams {
  return {
    algorithm: 'PBKDF2-SHA256',
    salt: crypto.getRandomValues(new Uint8Array(SALT_LENGTH)),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Derives the non-extractable AES-256-GCM Master Encryption Key from the user's passphrase.
 * Never pass OAuth tokens or account identifiers here (BR-SEC-03).
 */
export async function deriveMasterKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  if (params.iterations < PBKDF2_ITERATIONS || params.salt.length < SALT_LENGTH) {
    throw new CryptoError('ERR_WEAK_KDF_PARAMS', 'KDF parameters are below the minimum strength.');
  }
  if (passphrase.length === 0) {
    throw new CryptoError('ERR_EMPTY_PASSPHRASE', 'Passphrase must not be empty.');
  }
  // NFC so the same passphrase typed on different platforms derives the same key.
  const material = new TextEncoder().encode(passphrase.normalize('NFC'));
  const baseKey = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: params.salt, iterations: params.iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
