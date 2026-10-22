import type { Bytes } from '@ankylock/core';
import { CryptoError } from './errors.js';

/** New vaults: OWASP's current guidance for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
/** The weakest vault that still opens (vaults created before the stronger default). */
export const MIN_PBKDF2_ITERATIONS = 100_000;
/**
 * The strongest accepted: a vault header from Drive with a huge count would make unlocking hang
 * (denial of service), so such a header is refused rather than run.
 */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
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
  if (params.iterations < MIN_PBKDF2_ITERATIONS || params.salt.length < SALT_LENGTH) {
    throw new CryptoError('ERR_WEAK_KDF_PARAMS', 'KDF parameters are below the minimum strength.');
  }
  if (!Number.isSafeInteger(params.iterations) || params.iterations > MAX_PBKDF2_ITERATIONS) {
    throw new CryptoError('ERR_MALFORMED_PAYLOAD', 'KDF parameters are out of range.');
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
