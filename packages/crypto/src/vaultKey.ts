import type { Ciphertext } from '@ankylock/core';
import { decryptText, encryptText } from './cipher.js';
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
