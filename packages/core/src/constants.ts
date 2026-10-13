export const SYSTEM_ALL = 'system_all';
export const SYSTEM_ARCHIVE = 'system_archive';
export const SYSTEM_TRASH = 'system_trash';

export const SYSTEM_CATEGORY_IDS = [SYSTEM_ALL, SYSTEM_ARCHIVE, SYSTEM_TRASH] as const;
export type SystemCategoryId = (typeof SYSTEM_CATEGORY_IDS)[number];

export const DEFAULT_RETENTION_DAYS = 28;
/** 0 means manual purge only; otherwise retention must be within 1..=365 days. */
export const MAX_RETENTION_DAYS = 365;
export const MS_PER_DAY = 86_400_000;

export const MAX_FOLDER_DEPTH = 3;
