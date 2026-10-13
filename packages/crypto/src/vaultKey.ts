import type { Ciphertext } from '@ankylock/core';
import { base64ToBytes, bytesToBase64, decryptText, encryptText } from './cipher.js';
import { CryptoError } from './errors.js';
import { deriveMasterKey, generateKdfParams, type KdfParams } from './kdf.js';

const KEY_CHECK_PLAINTEXT = 'ankylock-key-check-v1';

/** Non-secret vault metadata; `keyCheck` lets unlock detect a wrong passphrase. */
export interface VaultHeader {
  readonly kdf: KdfParams;
  readonly keyCheck: Ciphertext;
}

export interface VaultKey {
  /** Creates a new vault for `passphrase` and unlocks it. Persist the returned header. */
  initialize(passphrase: string): Promise<VaultHeader>;
  /** Throws `ERR_WRONG_PASSPHRASE` if the passphrase does not match the header. */
  unlock(passphrase: string, header: VaultHeader): Promise<void>;
  lock(): void;
  isUnlocked(): boolean;
  /** Returns the non-extractable MEK; throws `ERR_VAULT_LOCKED` while locked. */
  getKey(): CryptoKey;
}

/** Holds the MEK as a non-extractable CryptoKey in a closure; raw key bytes never exist in JS memory. */
export function createVaultKey(): VaultKey {
  let key: CryptoKey | null = null;

  return {
    async initialize(passphrase) {
      const kdf = generateKdfParams();
      const derived = await deriveMasterKey(passphrase, kdf);
      const keyCheck = await encryptText(derived, KEY_CHECK_PLAINTEXT);
      key = derived;
      return { kdf, keyCheck };
    },

    async unlock(passphrase, header) {
      const derived = await deriveMasterKey(passphrase, header.kdf);
      try {
        if ((await decryptText(derived, header.keyCheck)) !== KEY_CHECK_PLAINTEXT) throw new Error();
      } catch {
        throw new CryptoError('ERR_WRONG_PASSPHRASE', 'The passphrase does not unlock this vault.');
      }
      key = derived;
    },

    lock() {
      key = null;
    },

    isUnlocked() {
      return key !== null;
    },

    getKey() {
      if (key === null) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
      return key;
    },
  };
}

/**
 * JSON form of the vault header, uploaded next to Drive snapshots so a new device can derive the
 * MEK from the passphrase. It holds no secret: a random salt, the iteration count and a key check.
 */
export function serializeVaultHeader(header: VaultHeader): string {
  return JSON.stringify({
    version: 1,
    kdf: { algorithm: header.kdf.algorithm, salt: bytesToBase64(header.kdf.salt), iterations: header.kdf.iterations },
    keyCheck: header.keyCheck,
  });
}

export function parseVaultHeader(json: string): VaultHeader {
  const malformed = (): CryptoError => new CryptoError('ERR_MALFORMED_PAYLOAD', 'Vault header is malformed.');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw malformed();
  }
  if (typeof value !== 'object' || value === null) throw malformed();
  const { version, kdf, keyCheck } = value as Record<string, unknown>;
  if (version !== 1 || typeof keyCheck !== 'string' || typeof kdf !== 'object' || kdf === null) throw malformed();
  const { algorithm, salt, iterations } = kdf as Record<string, unknown>;
  if (algorithm !== 'PBKDF2-SHA256' || typeof salt !== 'string' || typeof iterations !== 'number') throw malformed();
  return { kdf: { algorithm, salt: base64ToBytes(salt), iterations }, keyCheck: keyCheck as Ciphertext };
}
