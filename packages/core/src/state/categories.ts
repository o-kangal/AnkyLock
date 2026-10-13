import { MAX_CATEGORY_NAME_LENGTH } from '../constants.js';
import { err, ok, type Result } from '../errors.js';

/**
 * BR-HIER-02: trims the name, requires 1..=50 characters and case-insensitive uniqueness.
 * Names are stored encrypted, so this runs on the client against the decrypted names.
 * Returns the trimmed name to encrypt and store.
 */
export function validateCategoryName(name: string, existingNames: readonly string[]): Result<string> {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_CATEGORY_NAME_LENGTH) {
    return err('ERR_CATEGORY_NAME_INVALID', `Category names must be 1 to ${MAX_CATEGORY_NAME_LENGTH} characters.`);
  }
  const key = trimmed.toLocaleLowerCase('en-US');
  if (existingNames.some((existing) => existing.trim().toLocaleLowerCase('en-US') === key)) {
    return err('ERR_CATEGORY_NAME_DUPLICATE', 'A category with this name already exists.');
  }
  return ok(trimmed);
}
