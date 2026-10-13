export type CryptoErrorCode =
  | 'ERR_DECRYPT_FAILED'
  | 'ERR_MALFORMED_PAYLOAD'
  | 'ERR_WEAK_KDF_PARAMS'
  | 'ERR_EMPTY_PASSPHRASE'
  | 'ERR_WRONG_PASSPHRASE'
  | 'ERR_VAULT_LOCKED'
  | 'ERR_WORKER_FAILURE';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}
