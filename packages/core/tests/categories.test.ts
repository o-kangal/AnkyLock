import { describe, expect, it } from 'vitest';
import { validateCategoryName } from '../src/index.js';

describe('validateCategoryName (BR-HIER-02)', () => {
  it('returns the trimmed name', () => {
    expect(validateCategoryName('  Work  ', [])).toEqual({ ok: true, value: 'Work' });
  });

  it('rejects empty and over-long names', () => {
    expect(validateCategoryName('   ', [])).toMatchObject({ ok: false, error: { code: 'ERR_CATEGORY_NAME_INVALID' } });
    expect(validateCategoryName('x'.repeat(51), [])).toMatchObject({ ok: false });
    expect(validateCategoryName('x'.repeat(50), []).ok).toBe(true);
  });

  it('counts emoji as one character', () => {
    expect(validateCategoryName('🔐'.repeat(50), []).ok).toBe(true);
  });

  it('rejects case-insensitive duplicates', () => {
    expect(validateCategoryName('work', ['Home', ' WORK '])).toMatchObject({
      ok: false,
      error: { code: 'ERR_CATEGORY_NAME_DUPLICATE' },
    });
  });
});
