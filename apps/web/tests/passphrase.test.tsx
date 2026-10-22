import { describe, expect, it } from 'vitest';
import { isEasyToGuess, MIN_PASSPHRASE_LENGTH } from '../src/components/passphrase.js';
import { createRuntime } from '../src/index.js';
import { TestVaults, localSealer } from './helpers.js';

describe('vault passphrases', () => {
  it('must be at least 12 characters, enforced by the runtime too', async () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(12);
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    await runtime.init();
    expect(await runtime.createVault('Personal', 'eleven char')).toBe('Use at least 12 characters.');
    expect(runtime.vaults()).toEqual([]);
    expect(await runtime.createVault('Personal', 'mavi kedi çay içer')).toBeNull();
    await runtime.lock();
  });

  it('warns about passphrases that are long enough but easy to guess', () => {
    for (const weak of ['aaaaaaaaaaaa', 'abababababab', '123456789012', 'abcdefghijkl', 'lkjihgfedcba', 'MyPassword2024', 'şifre şifre şifre', 'qwertyuiop12', 'ankylock-vault']) {
      expect(isEasyToGuess(weak), weak).toBe(true);
    }
    for (const fine of ['mavi kedi çay içer', 'blue cat drinks tea', 'kırmızı bisiklet 42 deniz', 'correct horse battery']) {
      expect(isEasyToGuess(fine), fine).toBe(false);
    }
  });
});
