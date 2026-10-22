/** Passphrases are the only thing protecting the vault; short ones fall to offline guessing. */
export const MIN_PASSPHRASE_LENGTH = 12;

// Fragments that appear in most leaked password lists, in English and Turkish.
const COMMON = [
  'password',
  'passw0rd',
  'parola',
  'sifre',
  'şifre',
  'qwerty',
  'asdfgh',
  'zxcvbn',
  'qazwsx',
  '123456',
  '654321',
  '111111',
  'abc123',
  'iloveyou',
  'seniseviyorum',
  'letmein',
  'welcome',
  'admin',
  'ankylock',
];

/** Each character one code point after (or before) the previous one: `123456…`, `abcdef…`. */
function isSequence(chars: readonly string[]): boolean {
  const codes = chars.map((c) => c.codePointAt(0) ?? 0);
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);
  return Math.abs(step) === 1 && codes.every((code, i) => i === 0 || code - (codes[i - 1] ?? 0) === step);
}

/**
 * Whether a passphrase that meets the length rule is still easy to guess: very few distinct
 * characters, a plain sequence, or a fragment of the most common passwords. Only a warning:
 * the user may still choose it.
 */
export function isEasyToGuess(passphrase: string): boolean {
  const lower = passphrase.normalize('NFC').toLocaleLowerCase('tr-TR');
  const chars = [...lower.replace(/\s+/g, '')];
  if (new Set(chars).size < 5) return true;
  if (isSequence(chars)) return true;
  return COMMON.some((fragment) => lower.replace(/\s+/g, '').includes(fragment));
}
