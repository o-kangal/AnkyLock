export const SYSTEM_ALL = 'system_all';
export const SYSTEM_ARCHIVE = 'system_archive';
export const SYSTEM_TRASH = 'system_trash';

export const SYSTEM_CATEGORY_IDS = [SYSTEM_ALL, SYSTEM_ARCHIVE, SYSTEM_TRASH] as const;
export type SystemCategoryId = (typeof SYSTEM_CATEGORY_IDS)[number];

/** System categories are views (all notes, archived, trashed), not containers: nothing is assigned to them. */
export function isSystemCategoryId(id: string): id is SystemCategoryId {
  return (SYSTEM_CATEGORY_IDS as readonly string[]).includes(id);
}

export const DEFAULT_RETENTION_DAYS = 28;
/** 0 means manual purge only; otherwise retention must be within 1..=365 days. */
export const MAX_RETENTION_DAYS = 365;
export const MS_PER_DAY = 86_400_000;

export const MAX_FOLDER_DEPTH = 3;

/** BR-NOTE-02: local edits are batched for this long before being encrypted and sent. */
export const SYNC_DEBOUNCE_MS = 150;

/** BR-NOTE-03: display titles fall back to this many leading characters of line 1. */
export const TITLE_FALLBACK_LENGTH = 40;
