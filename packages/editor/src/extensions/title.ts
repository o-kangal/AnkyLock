import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { deriveTitle } from '@ankylock/core';

/** Line 1 may be a multi-megabyte single line; reading this much is always enough for a title. */
const TITLE_SCAN_LIMIT = 1024;

function readTitle(view: EditorView): string | null {
  const { doc } = view.state;
  const line = doc.line(1);
  return deriveTitle(doc.sliceString(line.from, Math.min(line.to, line.from + TITLE_SCAN_LIMIT)));
}

/**
 * Reports the BR-NOTE-03 title on mount and whenever line 1 changes, local or remote. Reads only
 * a bounded prefix of line 1 and skips edits below it, so typing elsewhere costs nothing.
 */
export function titleListener(onTitle: (title: string | null) => void): Extension {
  return ViewPlugin.define((view) => {
    let last = readTitle(view);
    onTitle(last);
    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        const lineOneEnd = update.startState.doc.line(1).to;
        let touchesLineOne = false;
        update.changes.iterChangedRanges((fromA) => {
          if (fromA <= lineOneEnd) touchesLineOne = true;
        });
        if (!touchesLineOne) return;
        const title = readTitle(update.view);
        if (title !== last) {
          last = title;
          onTitle(title);
        }
      },
    };
  });
}
