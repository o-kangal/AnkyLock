import { RangeSetBuilder, countColumn, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { LINE_PADDING_LEFT } from './theme.js';

const INDENT = /^[ \t]*/;

/** Decorates visible indented lines so their wrapped continuation starts at the indentation. */
function hangingIndents(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const indent = INDENT.exec(line.text)?.[0] ?? '';
      if (indent.length > 0) {
        const columns = countColumn(indent, view.state.tabSize);
        // Keeps the theme's 8px line padding; text-indent pulls the first row back.
        const style = `padding-left: calc(${columns}ch + ${LINE_PADDING_LEFT}); text-indent: -${columns}ch`;
        builder.add(line.from, line.from, Decoration.line({ attributes: { style } }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hangingIndents(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = hangingIndents(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Soft line wrapping. Wrapped rows of an indented line stay aligned with its indentation, and
 * line numbers only mark logical lines (CodeMirror numbers lines, not rows). Off: nothing.
 */
export const wordWrap = (on: boolean): Extension => (on ? [EditorView.lineWrapping, hangingIndent] : []);
