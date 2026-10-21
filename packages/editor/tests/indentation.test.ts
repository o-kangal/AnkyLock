import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { editorBasics, noteText, undoManagerFor, yjsBinding } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

/** An editor bound to a fresh Y.Doc, like a note's tab; `|` marks the cursor, `[` and `]` a selection. */
function editor(marked: string): { view: EditorView; doc: Y.Doc } {
  const doc = new Y.Doc();
  const anchor = marked.indexOf('[');
  const cursor = marked.indexOf('|');
  const text = marked.replace(/[|[\]]/g, '');
  noteText(doc).insert(0, text);
  const selection =
    anchor >= 0 ? EditorSelection.single(anchor, marked.indexOf(']') - 1) : EditorSelection.cursor(cursor >= 0 ? cursor : 0);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: text, selection, extensions: [editorBasics, yjsBinding(doc)] }),
  });
  views.push(view);
  return { view, doc };
}

/** Presses a key in the editor; true when the editor handled it (the browser then does nothing). */
function press(view: EditorView, key: string, options: { shiftKey?: boolean; keyCode?: number } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}
const tab = (view: EditorView, shiftKey = false): boolean => press(view, 'Tab', { shiftKey, keyCode: 9 });

describe('Tab in the editor', () => {
  it('inserts spaces up to the next tab stop at the cursor', () => {
    const { view, doc } = editor('ab|cd');
    expect(tab(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('ab  cd');
    expect(view.state.selection.main.head).toBe(4);
    tab(view);
    expect(view.state.doc.toString()).toBe('ab      cd');
    // Every indent is an ordinary edit of the note's text.
    expect(noteText(doc).toString()).toBe('ab      cd');
  });

  it('replaces a selection within one line, and indents every line of a multi-line selection', () => {
    const one = editor('a[bc]d').view;
    tab(one);
    expect(one.state.doc.toString()).toBe('a   d');

    const many = editor('[one\ntwo]\nthree').view;
    tab(many);
    expect(many.state.doc.toString()).toBe('    one\n    two\nthree');
  });

  it('outdents the current or selected lines with Shift+Tab', () => {
    const current = editor('        de|ep').view;
    expect(tab(current, true)).toBe(true);
    expect(current.state.doc.toString()).toBe('    deep');

    const selected = editor('[    one\n  two]\nthree').view;
    tab(selected, true);
    expect(selected.state.doc.toString()).toBe('one\ntwo\nthree');
  });

  it('shows a tab character four columns wide', () => {
    expect(editor('\tx').view.state.tabSize).toBe(4);
  });

  it('keeps the indentation of the line on Enter', () => {
    const { view } = editor('    item|');
    expect(press(view, 'Enter', { keyCode: 13 })).toBe(true);
    expect(view.state.doc.toString()).toBe('    item\n    ');
  });

  it('lets Escape, then Tab, move focus out of the editor', () => {
    const { view } = editor('ab|cd');
    press(view, 'Escape', { keyCode: 27 });
    expect(tab(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('abcd');
  });

  it('undoes an indent in one step', () => {
    const { view, doc } = editor('[one\ntwo]');
    tab(view);
    undoManagerFor(noteText(doc)).stopCapturing();
    undoManagerFor(noteText(doc)).undo();
    expect(view.state.doc.toString()).toBe('one\ntwo');
    expect(noteText(doc).toString()).toBe('one\ntwo');
  });
});
