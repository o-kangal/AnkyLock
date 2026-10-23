import { TITLE_FALLBACK_LENGTH } from '../constants.js';

/**
 * BR-NOTE-03: the display title is line 1, trimmed, cut to 40 characters. Counts code points so
 * an emoji is never split. Returns null for an empty line; the caller then shows `Untitled-N`.
 * Pass only a bounded prefix of line 1; the text may be a multi-megabyte single line.
 */
export function deriveTitle(firstLine: string): string | null {
  const title = Array.from(firstLine.trim()).slice(0, TITLE_FALLBACK_LENGTH).join('').trimEnd();
  return title === '' ? null : title;
}
