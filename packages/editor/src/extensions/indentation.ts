import { indentLess, indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { countColumn, EditorSelection, EditorState, type Extension, type StateCommand } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/** Columns per indent level, and the width a tab character already in a note is shown with. */
export const INDENT_WIDTH = 4;

/**
 * Tab without a multi-line selection: spaces up to the next tab stop at each cursor (replacing a
 * selection within one line). A selection spanning lines indents those lines instead.
 */
export const insertIndent: StateCommand = ({ state, dispatch }) => {
  const spansLines = state.selection.ranges.some((r) => state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number);
  if (spansLines) return indentMore({ state, dispatch });
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const column = countColumn(line.text.slice(0, range.from - line.from), state.tabSize);
    const spaces = ' '.repeat(INDENT_WIDTH - (column % INDENT_WIDTH));
    return { changes: { from: range.from, to: range.to, insert: spaces }, range: EditorSelection.cursor(range.from + spaces.length) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
};

/**
 * Tab indents and Shift+Tab outdents while typing in a note. Escape, then Tab, still moves focus
 * out of the editor (CodeMirror's built-in escape hatch), so keyboard users are never trapped.
 * Enter keeps the line's indentation through the default keymap.
 */
export const indentation: Extension = [
  indentUnit.of(' '.repeat(INDENT_WIDTH)),
  EditorState.tabSize.of(INDENT_WIDTH),
  keymap.of([{ key: 'Tab', run: insertIndent, shift: indentLess }]),
];
