/** Shared with Rust `AppError::code()` in apps/desktop/src-tauri/src/error.rs. */
export const ERROR_CODES = [
  'ERR_CIRCULAR_HIERARCHY',
  'ERR_MAX_DEPTH_EXCEEDED',
  'ERR_SYSTEM_CATEGORY_IMMUTABLE',
  'ERR_READ_ONLY_TRASHED_ENTITY',
  'ERR_INVALID_TRANSITION',
  'ERR_CATEGORY_NAME_INVALID',
  'ERR_CATEGORY_NAME_DUPLICATE',
  'ERR_NOTE_TOO_LARGE',
  'ERR_INVALID_SETTING',
  'ERR_NOT_FOUND',
  'ERR_STORAGE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DomainError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = (code: ErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});
