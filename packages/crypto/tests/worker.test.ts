import { afterEach, describe, expect, it } from 'vitest';
import type { Bytes, SealedBytes } from '@ankylock/core';
import {
  CryptoError,
  createKeySealer,
  createTextCodec,
  decryptText,
  createWorkerSealer,
  open,
  seal,
  serveCrypto,
  type MessagePortLike,
  type WorkerSealer,
} from '../src/index.js';

const encode = (s: string): Bytes => new TextEncoder().encode(s);
const decode = (b: Bytes): string => new TextDecoder().decode(b);

const newKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

describe('seal / open', () => {
  it('round-trips through the packed iv ‖ ciphertext ‖ tag layout', async () => {
    const key = await newKey();
    const sealed = await seal(key, encode('const secret = 42;'));
    expect(sealed.length).toBe(12 + 18 + 16);
    expect(decode(await open(key, sealed))).toBe('const secret = 42;');
  });

  it('opens only with the context it was sealed for', async () => {
    const key = await newKey();
    const sealed = await seal(key, encode('purge'), encode('TOMBSTONE\nnote-a'));
    expect(decode(await open(key, sealed, encode('TOMBSTONE\nnote-a')))).toBe('purge');
    await expect(open(key, sealed, encode('TOMBSTONE\nnote-b'))).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
    await expect(open(key, sealed)).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
    // And a payload sealed without one does not open with one.
    await expect(open(key, await seal(key, encode('x')), encode('ctx'))).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
  });
});

describe('createKeySealer', () => {
  it('uses the current key and fails while locked', async () => {
    let key: CryptoKey | null = null;
    const sealer = createKeySealer(() => {
      if (key === null) throw new CryptoError('ERR_VAULT_LOCKED', 'locked');
      return key;
    });
    await expect(sealer.seal(encode('x'))).rejects.toMatchObject({ code: 'ERR_VAULT_LOCKED' });
    key = await newKey();
    expect(decode(await sealer.open(await sealer.seal(encode('x'))))).toBe('x');
  });
});

describe('createTextCodec', () => {
  it('produces Ciphertext values interchangeable with encryptText/decryptText', async () => {
    const key = await newKey();
    const codec = createTextCodec(createKeySealer(() => key));
    const ciphertext = await codec.encrypt('Klasör 🔐');
    expect(ciphertext).not.toContain('Klasör');
    expect(await decryptText(key, ciphertext)).toBe('Klasör 🔐');
    expect(await codec.decrypt(ciphertext)).toBe('Klasör 🔐');
  });
});

describe('worker bridge over MessageChannel', () => {
  let channel: MessageChannel;
  let client: WorkerSealer;
  let stop: () => void;

  function connect(): void {
    channel = new MessageChannel();
    stop = serveCrypto(channel.port1 as unknown as MessagePortLike);
    client = createWorkerSealer(channel.port2 as unknown as MessagePortLike);
  }

  afterEach(() => {
    client.dispose();
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('rejects work until a key is set', async () => {
    connect();
    await expect(client.seal(encode('x'))).rejects.toMatchObject({ name: 'CryptoError', code: 'ERR_VAULT_LOCKED' });
  });

  it('seals in the worker and opens with the same key on this thread', async () => {
    connect();
    const key = await newKey();
    await client.setKey(key);
    const sealed = await client.seal(encode('Line A'));
    expect(decode(await open(key, sealed))).toBe('Line A');
    expect(decode(await client.open(sealed))).toBe('Line A');
  });

  it('passes the context through to the worker', async () => {
    connect();
    const key = await newKey();
    await client.setKey(key);
    const sealed = await client.seal(encode('Line B'), encode('CRDT_DELTA\nn1'));
    expect(decode(await open(key, sealed, encode('CRDT_DELTA\nn1')))).toBe('Line B');
    expect(decode(await client.open(sealed, encode('CRDT_DELTA\nn1')))).toBe('Line B');
    await expect(client.open(sealed, encode('CRDT_DELTA\nn2'))).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
  });

  it('does not detach the caller’s input buffer', async () => {
    connect();
    await client.setKey(await newKey());
    const input = encode('keep me');
    await client.seal(input);
    expect(decode(input)).toBe('keep me');
  });

  it('reports tampering as ERR_DECRYPT_FAILED', async () => {
    connect();
    await client.setKey(await newKey());
    const sealed = await client.seal(encode('x'));
    const tampered = sealed.slice() as SealedBytes;
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    await expect(client.open(tampered)).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
  });

  it('locks again when the key is cleared', async () => {
    connect();
    await client.setKey(await newKey());
    await client.setKey(null);
    await expect(client.seal(encode('x'))).rejects.toMatchObject({ code: 'ERR_VAULT_LOCKED' });
  });

  it('answers concurrent requests by id', async () => {
    connect();
    await client.setKey(await newKey());
    const texts = ['one', 'two', 'three', 'four'];
    const sealed = await Promise.all(texts.map((t) => client.seal(encode(t))));
    const opened = await Promise.all(sealed.map((s) => client.open(s)));
    expect(opened.map(decode)).toEqual(texts);
  });

  it('rejects in-flight requests on dispose', async () => {
    connect();
    stop(); // worker side stops answering
    const pending = client.seal(encode('x'));
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'ERR_WORKER_FAILURE' });
  });
});
