import { findNext, replaceAll, SearchQuery, setSearchQuery } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { editorBasics, noteSearch, noteText, yjsBinding, type SearchLabels } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

const TURKISH: SearchLabels = {
  Find: 'Bul',
  Replace: 'Değiştir',
  next: 'sonraki',
  previous: 'önceki',
  all: 'tümü',
  'match case': 'büyük/küçük harf',
  regexp: 'regex',
  'by word': 'tam kelime',
  replace: 'değiştir',
  'replace all': 'tümünü değiştir',
  close: 'kapat',
  'current match': 'geçerli eşleşme',
  'on line': 'satırda',
  'replaced $ matches': '$ eşleşme değiştirildi',
  'replaced match on line $': '$. satırdaki eşleşme değiştirildi',
  'Go to line': 'Satıra git',
  go: 'git',
};

function editor(text: string, readOnly = false): { view: EditorView; doc: Y.Doc } {
  const doc = new Y.Doc();
  noteText(doc).insert(0, text);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [editorBasics, noteSearch(TURKISH), yjsBinding(doc), EditorState.readOnly.of(readOnly)],
    }),
  });
  views.push(view);
  return { view, doc };
}

/** Ctrl+F in the editor (jsdom is not macOS, so Mod is Ctrl); true when the editor handled it. */
function ctrlF(view: EditorView): boolean {
  const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, keyCode: 70, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

const field = (view: EditorView, name: string): HTMLInputElement | null =>
  view.dom.querySelector<HTMLInputElement>(`.cm-search input[name=${name}]`);

describe('find and replace', () => {
  it('opens the panel above the text on Ctrl+F, in the app language, instead of the browser search', () => {
    const { view } = editor('hello world');
    expect(ctrlF(view)).toBe(true);
    expect(field(view, 'search')?.placeholder).toBe('Bul');
    expect(view.dom.querySelector('.cm-panels-top .cm-search')).not.toBeNull();
  });

  it('selects the next match', () => {
    const { view } = editor('one two one two');
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'two' })) });
    findNext(view);
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });
    findNext(view);
    expect(view.state.selection.main).toMatchObject({ from: 12, to: 15 });
  });

  it('replaces every match as an ordinary edit of the note text', () => {
    const { view, doc } = editor('const a = 1;\nconst b = a;');
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'const', replace: 'let' })) });
    expect(replaceAll(view)).toBe(true);
    expect(noteText(doc).toString()).toBe('let a = 1;\nlet b = a;');
  });

  it('offers no Replace in a read-only note', () => {
    const { view } = editor('trashed text', true);
    ctrlF(view);
    expect(field(view, 'search')).not.toBeNull();
    expect(field(view, 'replace')).toBeNull();
  });
});
