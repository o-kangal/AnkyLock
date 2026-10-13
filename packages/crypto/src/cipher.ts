import { IV_LENGTH, TAG_LENGTH, type Bytes, type Ciphertext, type EncryptedPayload, type SealedBytes } from '@ankylock/core';
import { CryptoError } from './errors.js';

const TAG_BITS = TAG_LENGTH * 8;
const BASE64_CHUNK = 0x8000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Encrypts with AES-256-GCM under a fresh random 12-byte IV (BR-SEC-02). */
export async function encryptPayload(key: CryptoKey, plaintext: Bytes): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  // Web Crypto returns `ciphertext ‖ tag`.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: TAG_BITS }, key, plaintext),
  );
  const split = sealed.length - TAG_LENGTH;
  return { iv, ciphertext: sealed.slice(0, split), tag: sealed.slice(split) };
}

/** Throws `ERR_DECRYPT_FAILED` on a wrong key or tampered data; never returns partial plaintext. */
export async function decryptPayload(key: CryptoKey, payload: EncryptedPayload): Promise<Bytes> {
  assertLengths(payload);
  const sealed = new Uint8Array(payload.ciphertext.length + TAG_LENGTH);
  sealed.set(payload.ciphertext);
  sealed.set(payload.tag, payload.ciphertext.length);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.iv, tagLength: TAG_BITS }, key, sealed),
    );
  } catch {
    throw new CryptoError('ERR_DECRYPT_FAILED', 'Decryption failed: wrong key or tampered data.');
  }
}

/** Serializes to the SPEC §5.1 layout: `iv (12) ‖ ciphertext ‖ tag (16)`. */
export function pack(payload: EncryptedPayload): Bytes {
  assertLengths(payload);
  const out = new Uint8Array(IV_LENGTH + payload.ciphertext.length + TAG_LENGTH);
  out.set(payload.iv);
  out.set(payload.ciphertext, IV_LENGTH);
  out.set(payload.tag, IV_LENGTH + payload.ciphertext.length);
  return out;
}

export function unpack(bytes: Bytes): EncryptedPayload {
  if (bytes.length < IV_LENGTH + TAG_LENGTH) {
    throw new CryptoError('ERR_MALFORMED_PAYLOAD', 'Encrypted payload is shorter than IV + tag.');
  }
  const tagStart = bytes.length - TAG_LENGTH;
  return {
    iv: bytes.slice(0, IV_LENGTH),
    ciphertext: bytes.slice(IV_LENGTH, tagStart),
    tag: bytes.slice(tagStart),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Bytes {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new CryptoError('ERR_MALFORMED_PAYLOAD', 'Encrypted payload is not valid base64.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypts to the packed SPEC §5.1 layout; the only producer of `SealedBytes`. */
export async function seal(key: CryptoKey, plaintext: Bytes): Promise<SealedBytes> {
  return pack(await encryptPayload(key, plaintext)) as SealedBytes;
}

export async function open(key: CryptoKey, sealed: SealedBytes): Promise<Bytes> {
  return decryptPayload(key, unpack(sealed));
}

/** Encrypts a string for a `*_ciphertext` TEXT column. */
export async function encryptText(key: CryptoKey, text: string): Promise<Ciphertext> {
  return bytesToBase64(await seal(key, encoder.encode(text))) as Ciphertext;
}

export async function decryptText(key: CryptoKey, ciphertext: Ciphertext): Promise<string> {
  const plaintext = await decryptPayload(key, unpack(base64ToBytes(ciphertext)));
  try {
    return decoder.decode(plaintext);
  } catch {
    throw new CryptoError('ERR_DECRYPT_FAILED', 'Decrypted payload is not valid UTF-8.');
  }
}

function assertLengths(payload: EncryptedPayload): void {
  if (payload.iv.length !== IV_LENGTH || payload.tag.length !== TAG_LENGTH) {
    throw new CryptoError('ERR_MALFORMED_PAYLOAD', 'IV must be 12 bytes and tag must be 16 bytes.');
  }
}
