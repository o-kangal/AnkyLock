import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { noteTitle } from '@ankylock/core';
import { noteName } from '@ankylock/sync';
import type * as Y from 'yjs';

/** Line 1 may be a multi-megabyte single line; reading this much is always enough for a title. */
const TITLE_SCAN_LIMIT = 1024;

function readTitle(view: EditorView, doc: Y.Doc): string | null {
  const { doc: text } = view.state;
  const line = text.line(1);
  return noteTitle(noteName(doc), text.sliceString(line.from, Math.min(line.to, line.from + TITLE_SCAN_LIMIT)));
}

/**
 * Reports the note's title on mount and whenever line 1 changes, local or remote: its name, or
 * else line 1 (BR-NOTE-03). Reads only a bounded prefix of line 1 and skips edits below it, so
 * typing elsewhere costs nothing. Renames are reported by whoever owns the doc, not here.
 */
export function titleListener(doc: Y.Doc, onTitle: (title: string | null) => void): Extension {
  return ViewPlugin.define((view) => {
    let last = readTitle(view, doc);
    onTitle(last);
    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        const lineOneEnd = update.startState.doc.line(1).to;
        if (!update.changes.touchesRange(0, lineOneEnd)) return;
        const title = readTitle(update.view, doc);
        if (title !== last) {
          last = title;
          onTitle(title);
        }
      },
    };
  });
}
