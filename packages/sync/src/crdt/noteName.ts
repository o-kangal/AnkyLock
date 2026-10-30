import * as Y from 'yjs';
import { normalizeNoteName, noteTitle } from '@ankylock/core';
import { TEXT_FIELD } from './docManager.js';

/**
 * Name of the `Y.Map` beside the note body that holds the note's own name. It lives in the doc,
 * so a rename is an ordinary Yjs update: sealed, synced and backed up like the text. Versions
 * without names ignore the map and keep showing line 1.
 */
export const META_FIELD = 'meta';
const NAME_KEY = 'name';

/** Titles come from the first line; a longer line is cut before searching for its end. */
const LINE_ONE_LIMIT = 1024;

/** The name the user gave the note, or null when its title comes from line 1. */
export function noteName(doc: Y.Doc): string | null {
  const name: unknown = doc.getMap(META_FIELD).get(NAME_KEY);
  return typeof name === 'string' ? normalizeNoteName(name) : null;
}

/** Names the note; an empty name removes it, so the title follows line 1 again. */
export function setNoteName(doc: Y.Doc, name: string): void {
  const normalized = normalizeNoteName(name);
  const meta = doc.getMap(META_FIELD);
  if (normalized === null) meta.delete(NAME_KEY);
  else meta.set(NAME_KEY, normalized);
}

/** The note's title: its name, or else line 1 (BR-NOTE-03). */
export function docTitle(doc: Y.Doc): string | null {
  const firstLine = doc.getText(TEXT_FIELD).toString().slice(0, LINE_ONE_LIMIT).split('\n', 1)[0] ?? '';
  return noteTitle(noteName(doc), firstLine);
}
