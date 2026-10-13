import { describe, expect, it } from 'vitest';
import { deriveTitle } from '../src/index.js';

describe('deriveTitle (BR-NOTE-03)', () => {
  it('trims line 1 and keeps the first 40 characters', () => {
    expect(deriveTitle('   const secret = 42;  ')).toBe('const secret = 42;');
    expect(deriveTitle('x'.repeat(50))).toBe('x'.repeat(40));
  });

  it('does not end with whitespace after cutting', () => {
    expect(deriveTitle(`${'a'.repeat(39)} tail`)).toBe('a'.repeat(39));
  });

  it('counts emoji as single characters and never splits them', () => {
    const title = deriveTitle('🔐'.repeat(45));
    expect([...(title ?? '')]).toHaveLength(40);
    expect(title?.endsWith('🔐')).toBe(true);
  });

  it('returns null for an empty or whitespace-only line', () => {
    expect(deriveTitle('')).toBeNull();
    expect(deriveTitle(' \t ')).toBeNull();
  });
});
