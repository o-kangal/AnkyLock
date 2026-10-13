import type { Brand, Bytes } from './brand.js';

export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;

/** In-memory AES-256-GCM output: `iv` is 12 bytes, `tag` is 16 bytes. */
export interface EncryptedPayload {
  readonly iv: Bytes;
  readonly ciphertext: Bytes;
  readonly tag: Bytes;
}

/** Base64 of the packed `iv ‖ ciphertext ‖ tag` layout, stored in `*_ciphertext` TEXT columns. */
export type Ciphertext = Brand<string, 'Ciphertext'>;
