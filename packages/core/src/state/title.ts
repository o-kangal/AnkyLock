import { MAX_NOTE_NAME_LENGTH, TITLE_FALLBACK_LENGTH } from '../constants.js';

/**
 * BR-NOTE-03: the display title is line 1, trimmed, cut to 40 characters. Counts code points so
 * an emoji is never split. Returns null for an empty line; the caller then shows `Untitled-N`.
 * Pass only a bounded prefix of line 1; the text may be a multi-megabyte single line.
 */
export function deriveTitle(firstLine: string): string | null {
  const title = Array.from(firstLine.trim()).slice(0, TITLE_FALLBACK_LENGTH).join('').trimEnd();
  return title === '' ? null : title;
}

/**
 * A name the user gave a note: trimmed, line breaks become spaces, cut to 100 characters. Null
 * for an empty name, which means the note takes its title from line 1 again.
 */
export function normalizeNoteName(name: string): string | null {
  const flat = name.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const cut = Array.from(flat).slice(0, MAX_NOTE_NAME_LENGTH).join('').trimEnd();
  return cut === '' ? null : cut;
}

/** The title shown everywhere: the note's own name, or else line 1 (BR-NOTE-03). */
export function noteTitle(name: string | null, firstLine: string): string | null {
  return (name === null ? null : normalizeNoteName(name)) ?? deriveTitle(firstLine);
}
