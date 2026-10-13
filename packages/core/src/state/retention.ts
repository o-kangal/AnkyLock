import { MAX_RETENTION_DAYS } from '../constants.js';
import { err, ok, type Result } from '../errors.js';
import type { EpochMs } from '../types/entities.js';
import { isPurgeEligible } from './noteLifecycle.js';

/** BR-LIFE-03: 0 (manual purge only) or a whole number of days in 1..=365. */
export function validateRetentionDays(days: number): Result<number> {
  if (Number.isInteger(days) && days >= 0 && days <= MAX_RETENTION_DAYS) return ok(days);
  return err('ERR_INVALID_SETTING', `Trash retention must be 0 (manual purge only) or 1 to ${MAX_RETENTION_DAYS} days.`);
}

export type RetentionChangePlan =
  | { readonly kind: 'apply' }
  /** Shortening retention would purge these trashed items right away; the user must confirm first. */
  | { readonly kind: 'confirm_required'; readonly affected: number };

/**
 * Decides whether a retention change needs explicit confirmation (SPEC §6): it does when the new
 * value would immediately purge items that the old value still kept. Modelled as data so the
 * purge worker can't bypass it.
 */
export function planRetentionChange(
  oldDays: number,
  newDays: number,
  trashedAt: readonly EpochMs[],
  now: EpochMs,
): RetentionChangePlan {
  const affected = trashedAt.filter((t) => isPurgeEligible(t, newDays, now) && !isPurgeEligible(t, oldDays, now)).length;
  return affected === 0 ? { kind: 'apply' } : { kind: 'confirm_required', affected };
}
