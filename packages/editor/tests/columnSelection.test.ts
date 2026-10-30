import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { editorBasics, noteText, yjsBinding } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

/** A note's editor with one cursor at `column` on every line, as an Alt+drag leaves it. */
function columnCursors(text: string, column: number): { view: EditorView; doc: Y.Doc } {
  const doc = new Y.Doc();
  noteText(doc).insert(0, text);
  const state = EditorState.create({ doc: text, extensions: [editorBasics, yjsBinding(doc)] });
  const ranges = Array.from({ length: state.doc.lines }, (_, i) => EditorSelection.cursor(state.doc.line(i + 1).from + column));
  const view = new EditorView({ parent: document.body, state: state.update({ selection: EditorSelection.create(ranges) }).state });
  views.push(view);
  return { view, doc };
}

describe('column selection', () => {
  it('keeps a cursor on every line of the column', () => {
    const { view } = columnCursors('alpha\nbravo\ncharlie', 2);
    expect(view.state.selection.ranges.map((r) => r.head)).toEqual([2, 8, 14]);
  });

  it('types at the same position on every line, and the note text follows', () => {
    const { view, doc } = columnCursors('let a = 1;\nlet b = 2;\nlet c = 3;', 4);
    view.dispatch(view.state.replaceSelection('my_'));
    expect(view.state.doc.toString()).toBe('let my_a = 1;\nlet my_b = 2;\nlet my_c = 3;');
    expect(noteText(doc).toString()).toBe(view.state.doc.toString());
  });
});
