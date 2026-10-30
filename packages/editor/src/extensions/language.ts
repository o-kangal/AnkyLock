import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { META_FIELD, noteName } from '@ankylock/sync';
import type * as Y from 'yjs';

/** Line 1 may be a multi-megabyte single line; a file name or shebang is always shorter. */
const LINE_ONE_SCAN_LIMIT = 256;

// Common file names the language list does not know, mapped to a language name or alias.
const EXTRA_FILE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^\.env(\..+)?$/i, 'properties'],
  [/^\.(bashrc|bash_profile|bash_aliases|zshrc|zprofile|profile)$/i, 'sh'],
  [/^(\.gitconfig|\.editorconfig)$/i, 'ini'],
  [/^(Containerfile|Dockerfile\..+)$/i, 'dockerfile'],
];

// Interpreters whose shebang name is not a language name or alias already.
const INTERPRETERS: Readonly<Record<string, string>> = {
  ash: 'sh',
  dash: 'sh',
  ksh: 'sh',
  bun: 'js',
  deno: 'ts',
  pwsh: 'powershell',
};

function byFileName(fileName: string): LanguageDescription | null {
  const extra = EXTRA_FILE_NAMES.find(([pattern]) => pattern.test(fileName));
  if (extra) return LanguageDescription.matchLanguageName(languages, extra[1], false);
  // Extensions are listed in lower case (`README.MD` is still Markdown).
  const dot = fileName.lastIndexOf('.');
  const lowered = dot > 0 ? fileName.slice(0, dot) + fileName.slice(dot).toLowerCase() : fileName;
  return LanguageDescription.matchFilename(languages, fileName) ?? LanguageDescription.matchFilename(languages, lowered);
}

const isVersionChar = (char: string): boolean => char === '.' || (char >= '0' && char <= '9');

/**
 * `#!/bin/bash`, `#!/usr/bin/env python3`, `#!/usr/bin/env -S node --flags`. Plain string work,
 * no backtracking regex: line 1 is note text, possibly from another device.
 */
function byShebang(firstLine: string): LanguageDescription | null {
  if (!firstLine.startsWith('#!')) return null;
  const [path = '', ...args] = firstLine.slice(2).trim().split(/\s+/);
  let program = path.slice(path.lastIndexOf('/') + 1);
  if (program === 'env') program = args.find((word) => !word.startsWith('-')) ?? '';
  // `python3.12` → `python`.
  let end = program.length;
  while (end > 0 && isVersionChar(program.charAt(end - 1))) end--;
  const name = program.slice(0, end).toLowerCase();
  if (name === '') return null;
  return LanguageDescription.matchLanguageName(languages, INTERPRETERS[name] ?? name, false);
}

/**
 * The note's language, from cheap hints only (no content sniffing): the extension of its name
 * (`deploy.sh`, `Dockerfile`), else a shebang on line 1, else line 1 itself when it reads like a
 * file name (`README.md`, no spaces). Null means plain text.
 */
export function detectLanguage(name: string | null, firstLine: string): LanguageDescription | null {
  const line = firstLine.trim();
  const named = name === null ? null : byFileName(name);
  if (named) return named;
  const shebang = byShebang(line);
  if (shebang) return shebang;
  return name === null && /^\S+$/.test(line) ? byFileName(line) : null;
}

/**
 * Highlights the note in the language its name or line 1 suggests, and follows renames (here or
 * remote) and edits of line 1. Each language is a separate chunk loaded on first use; the
 * parser then works incrementally on the visible part of the text, off the critical path.
 */
export function noteLanguage(doc: Y.Doc): Extension {
  const slot = new Compartment();
  const plugin = ViewPlugin.define((view: EditorView) => {
    let current: LanguageDescription | null = null;
    let destroyed = false;

    const detect = (): void => {
      const line = view.state.doc.line(1);
      const found = detectLanguage(noteName(doc), view.state.doc.sliceString(line.from, Math.min(line.to, line.from + LINE_ONE_SCAN_LIMIT)));
      if (found === current) return;
      current = found;
      // Views cannot be updated while they update; apply it once this update is over. A language
      // that fails to load leaves the note as plain text.
      (found ? found.load() : Promise.resolve([]))
        .then((support) => {
          if (!destroyed && current === found) view.dispatch({ effects: slot.reconfigure(support) });
        })
        .catch(() => undefined);
    };

    const meta = doc.getMap(META_FIELD);
    meta.observe(detect);
    detect();
    return {
      update(update: ViewUpdate) {
        if (update.docChanged && update.changes.touchesRange(0, update.startState.doc.line(1).to)) detect();
      },
      destroy() {
        destroyed = true;
        meta.unobserve(detect);
      },
    };
  });
  return [slot.of([]), plugin];
}
