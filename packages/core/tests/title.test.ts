import { describe, expect, it } from 'vitest';
import { deriveTitle, normalizeNoteName, noteTitle } from '../src/index.js';

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
    expect(Array.from(title ?? '')).toHaveLength(40);
    expect(title?.endsWith('🔐')).toBe(true);
  });

  it('returns null for an empty or whitespace-only line', () => {
    expect(deriveTitle('')).toBeNull();
    expect(deriveTitle(' \t ')).toBeNull();
  });
});

describe('note names', () => {
  it('trims a name, flattens line breaks and keeps up to 100 characters', () => {
    expect(normalizeNoteName('  deploy.sh ')).toBe('deploy.sh');
    expect(normalizeNoteName('two\n lines')).toBe('two lines');
    expect(normalizeNoteName('n'.repeat(120))).toBe('n'.repeat(100));
  });

  it('treats an empty name as no name', () => {
    expect(normalizeNoteName('')).toBeNull();
    expect(normalizeNoteName(' \n ')).toBeNull();
  });

  it('shows the name when there is one, and line 1 otherwise', () => {
    expect(noteTitle('config.yaml', 'first line')).toBe('config.yaml');
    expect(noteTitle(null, '  first line ')).toBe('first line');
    expect(noteTitle('   ', 'first line')).toBe('first line');
    expect(noteTitle(null, '')).toBeNull();
  });
});
