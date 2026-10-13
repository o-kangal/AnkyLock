import { describe, expect, it } from 'vitest';
import type { Bytes, Ciphertext } from '@ankylock/core';
import {
  CryptoError,
  PBKDF2_ITERATIONS,
  base64ToBytes,
  bytesToBase64,
  createVaultKey,
  parseVaultHeader,
  serializeVaultHeader,
  decryptPayload,
  decryptText,
  deriveMasterKey,
  encryptPayload,
  encryptText,
  generateKdfParams,
  pack,
  unpack,
  type CryptoErrorCode,
} from '../src/index.js';

const encode = (s: string): Bytes => new TextEncoder().encode(s);

const newKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

async function expectCryptoError(promise: Promise<unknown>, code: CryptoErrorCode): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof CryptoError && e.code === code);
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function flipBit(bytes: Bytes, index: number): Bytes {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('encryptPayload / decryptPayload', () => {
  it('round-trips plaintext', async () => {
    const key = await newKey();
    const payload = await encryptPayload(key, encode('const secret = 42;'));
    expect(new TextDecoder().decode(await decryptPayload(key, payload))).toBe('const secret = 42;');
  });

  it('produces a 12-byte IV and 16-byte tag', async () => {
    const payload = await encryptPayload(await newKey(), encode('abc'));
    expect(payload.iv).toHaveLength(12);
    expect(payload.tag).toHaveLength(16);
    expect(payload.ciphertext).toHaveLength(3);
  });

  it('uses a fresh IV for every encryption of the same plaintext', async () => {
    const key = await newKey();
    const a = await encryptPayload(key, encode('same'));
    const b = await encryptPayload(key, encode('same'));
    expect(a.iv).not.toEqual(b.iv);
    expect(pack(a)).not.toEqual(pack(b));
  });

  it('round-trips empty plaintext', async () => {
    const key = await newKey();
    const payload = await encryptPayload(key, new Uint8Array(0));
    expect(payload.ciphertext).toHaveLength(0);
    expect(await decryptPayload(key, payload)).toHaveLength(0);
  });

  it('round-trips a 10 MB plaintext', async () => {
    const key = await newKey();
    const big = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const restored = await decryptPayload(key, unpack(base64ToBytes(bytesToBase64(pack(await encryptPayload(key, big))))));
    // Compare digests: element-wise equality on 10M entries is far slower than the crypto itself.
    expect(await sha256(restored)).toEqual(await sha256(big));
  });

  it.each(['iv', 'ciphertext', 'tag'] as const)('rejects a single flipped bit in the %s', async (field) => {
    const key = await newKey();
    const payload = await encryptPayload(key, encode('tamper me'));
    const tampered = { ...payload, [field]: flipBit(payload[field], 0) };
    await expectCryptoError(decryptPayload(key, tampered), 'ERR_DECRYPT_FAILED');
  });

  it('rejects decryption under the wrong key', async () => {
    const payload = await encryptPayload(await newKey(), encode('secret'));
    await expectCryptoError(decryptPayload(await newKey(), payload), 'ERR_DECRYPT_FAILED');
  });

  it('rejects malformed IV or tag lengths', async () => {
    const key = await newKey();
    const payload = await encryptPayload(key, encode('x'));
    await expectCryptoError(decryptPayload(key, { ...payload, iv: payload.iv.slice(1) }), 'ERR_MALFORMED_PAYLOAD');
    await expectCryptoError(decryptPayload(key, { ...payload, tag: payload.tag.slice(1) }), 'ERR_MALFORMED_PAYLOAD');
  });
});

describe('pack / unpack', () => {
  it('lays out iv ‖ ciphertext ‖ tag and round-trips', async () => {
    const payload = await encryptPayload(await newKey(), encode('layout'));
    const packed = pack(payload);
    expect(packed).toHaveLength(12 + payload.ciphertext.length + 16);
    expect(packed.slice(0, 12)).toEqual(payload.iv);
    expect(packed.slice(-16)).toEqual(payload.tag);
    expect(unpack(packed)).toEqual(payload);
  });

  it('rejects input shorter than IV + tag', () => {
    expect(() => unpack(new Uint8Array(27))).toThrow(CryptoError);
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('rejects invalid base64', () => {
    expect(() => base64ToBytes('not base64!')).toThrow(CryptoError);
  });
});

describe('encryptText / decryptText', () => {
  it('round-trips unicode text through a base64 Ciphertext', async () => {
    const key = await newKey();
    const ciphertext = await encryptText(key, 'Klasör adı — 🔐');
    expect(ciphertext).not.toContain('Klasör');
    expect(await decryptText(key, ciphertext)).toBe('Klasör adı — 🔐');
  });

  it('rejects a corrupted Ciphertext', async () => {
    const key = await newKey();
    const bytes = base64ToBytes(await encryptText(key, 'title'));
    const corrupted = bytesToBase64(flipBit(bytes, 20)) as Ciphertext;
    await expectCryptoError(decryptText(key, corrupted), 'ERR_DECRYPT_FAILED');
  });
});

describe('deriveMasterKey', () => {
  it('derives the same non-extractable key for the same passphrase and params', async () => {
    const params = generateKdfParams();
    const a = await deriveMasterKey('correct horse', params);
    const b = await deriveMasterKey('correct horse', params);
    expect(a.extractable).toBe(false);
    expect(a.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(await decryptText(b, await encryptText(a, 'x'))).toBe('x');
  });

  it('normalizes the passphrase to NFC', async () => {
    const params = generateKdfParams();
    const composed = await deriveMasterKey('ç', params); // ç
    const decomposed = await deriveMasterKey('ç', params); // c + combining cedilla
    expect(await decryptText(decomposed, await encryptText(composed, 'x'))).toBe('x');
  });

  it('uses a random 16-byte salt per vault', () => {
    const a = generateKdfParams();
    const b = generateKdfParams();
    expect(a.salt).toHaveLength(16);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.iterations).toBe(PBKDF2_ITERATIONS);
  });

  it('derives different keys for different salts', async () => {
    const a = await deriveMasterKey('pw', generateKdfParams());
    const b = await deriveMasterKey('pw', generateKdfParams());
    await expectCryptoError(decryptText(b, await encryptText(a, 'x')), 'ERR_DECRYPT_FAILED');
  });

  it('rejects weak parameters and empty passphrases', async () => {
    const params = generateKdfParams();
    await expectCryptoError(deriveMasterKey('pw', { ...params, iterations: 1_000 }), 'ERR_WEAK_KDF_PARAMS');
    await expectCryptoError(deriveMasterKey('pw', { ...params, salt: new Uint8Array(8) }), 'ERR_WEAK_KDF_PARAMS');
    await expectCryptoError(deriveMasterKey('', params), 'ERR_EMPTY_PASSPHRASE');
  });
});

describe('createVaultKey', () => {
  it('starts locked and refuses to hand out a key', () => {
    const vault = createVaultKey();
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.getKey()).toThrow(expect.objectContaining({ code: 'ERR_VAULT_LOCKED' }));
  });

  it('initializes, locks and unlocks with the right passphrase', async () => {
    const vault = createVaultKey();
    const header = await vault.initialize('vault passphrase');
    const sealed = await encryptText(vault.getKey(), 'note body');

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);

    await vault.unlock('vault passphrase', header);
    expect(vault.getKey().extractable).toBe(false);
    expect(await decryptText(vault.getKey(), sealed)).toBe('note body');
  });

  it('rejects a wrong passphrase and stays locked', async () => {
    const header = await createVaultKey().initialize('right');
    const vault = createVaultKey();
    await expectCryptoError(vault.unlock('wrong', header), 'ERR_WRONG_PASSPHRASE');
    expect(vault.isUnlocked()).toBe(false);
  });

  it('never stores the passphrase or key bytes in the header', async () => {
    const header = await createVaultKey().initialize('super secret passphrase');
    expect(JSON.stringify({ ...header, kdf: { ...header.kdf, salt: [...header.kdf.salt] } })).not.toContain('super secret');
  });
});

describe('vault header serialization', () => {
  it('round-trips and still unlocks the vault', async () => {
    const header = await createVaultKey().initialize('passphrase');
    const restored = parseVaultHeader(serializeVaultHeader(header));
    expect(restored.kdf.salt).toEqual(header.kdf.salt);
    const vault = createVaultKey();
    await vault.unlock('passphrase', restored);
    expect(vault.isUnlocked()).toBe(true);
  });

  it('rejects malformed headers', () => {
    for (const json of ['nope', '{}', '{"version":2,"kdf":{},"keyCheck":"x"}']) {
      expect(() => parseVaultHeader(json)).toThrow(CryptoError);
    }
  });
});
