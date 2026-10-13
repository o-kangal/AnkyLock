import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, planRetentionChange, validateRetentionDays, type EpochMs } from '../src/index.js';

const now = 1_776_100_000_000 as EpochMs;
const daysAgo = (d: number): EpochMs => (now - d * MS_PER_DAY) as EpochMs;

describe('validateRetentionDays (BR-LIFE-03)', () => {
  it('accepts 0 and 1..=365 whole days', () => {
    for (const days of [0, 1, 28, 365]) expect(validateRetentionDays(days)).toEqual({ ok: true, value: days });
  });

  it('rejects negatives, fractions and values above 365', () => {
    for (const days of [-1, 1.5, 366, Number.NaN]) {
      expect(validateRetentionDays(days)).toMatchObject({ ok: false, error: { code: 'ERR_INVALID_SETTING' } });
    }
  });
});

describe('planRetentionChange', () => {
  it('requires confirmation when shortening would purge kept items (SPEC §6)', () => {
    expect(planRetentionChange(28, 7, [daysAgo(10), daysAgo(2)], now)).toEqual({ kind: 'confirm_required', affected: 1 });
  });

  it('applies directly when nothing new would be purged', () => {
    expect(planRetentionChange(28, 7, [daysAgo(2)], now)).toEqual({ kind: 'apply' });
    expect(planRetentionChange(7, 28, [daysAgo(10)], now)).toEqual({ kind: 'apply' });
    expect(planRetentionChange(28, 0, [daysAgo(100)], now)).toEqual({ kind: 'apply' });
  });

  it('counts items newly eligible when leaving manual mode', () => {
    expect(planRetentionChange(0, 28, [daysAgo(100), daysAgo(1)], now)).toEqual({ kind: 'confirm_required', affected: 1 });
  });
});
