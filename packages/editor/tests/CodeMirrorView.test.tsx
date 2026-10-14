import { EditorView } from '@codemirror/view';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TRASHED_READ_ONLY_MESSAGE } from '@ankylock/core';
import { REMOTE_ORIGIN, TEXT_FIELD } from '@ankylock/sync';
import { CodeMirrorView, undoManagerFor, type ColorScheme } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  const rect = (): DOMRect => new DOMRect(0, 0, 0, 0);
  const rects = (): DOMRectList => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = rects;
});

let dispose: (() => void) | undefined;
let root: HTMLDivElement;

afterEach(() => {
  dispose?.();
  root?.remove();
});

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(TEXT_FIELD).insert(0, text);
  return doc;
}

function mount(initial: { doc: Y.Doc; active?: boolean; readOnly?: boolean; titles?: (string | null)[] }) {
  const [doc, setDoc] = createSignal(initial.doc);
  const [active, setActive] = createSignal(initial.active ?? true);
  const [readOnly, setReadOnly] = createSignal(initial.readOnly ?? false);
  const [scheme, setScheme] = createSignal<ColorScheme>('light');
  root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => (
      <CodeMirrorView
        doc={doc()}
        active={active()}
        readOnly={readOnly()}
        colorScheme={scheme()}
        onTitleChange={(t) => initial.titles?.push(t)}
      />
    ),
    root,
  );
  return { setDoc, setActive, setReadOnly, setScheme };
}

const editors = (): NodeListOf<Element> => root.querySelectorAll('.cm-editor');

function view(): EditorView {
  const element = root.querySelector('.cm-editor');
  const found = element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
  if (!found) throw new Error('no mounted editor');
  return found;
}

describe('CodeMirrorView', () => {
  it('mounts an editor showing the doc text only while active', () => {
    const doc = docWith('hello');
    const { setActive } = mount({ doc, active: false });
    expect(editors()).toHaveLength(0);

    setActive(true);
    expect(editors()).toHaveLength(1);
    expect(view().state.doc.toString()).toBe('hello');

    setActive(false);
    expect(editors()).toHaveLength(0);
    expect(root.querySelector('.cm-content')).toBeNull();
  });

  it('keeps edits in the Y.Doc after the view is destroyed', () => {
    const doc = docWith('');
    const { setActive } = mount({ doc });
    view().dispatch({ changes: { from: 0, insert: 'typed text' } });
    setActive(false);
    expect(doc.getText(TEXT_FIELD).toString()).toBe('typed text');

    // Background tab: a remote update lands in the headless doc and shows up on remount.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getText(TEXT_FIELD).insert(10, ' + remote');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), REMOTE_ORIGIN);
    setActive(true);
    expect(view().state.doc.toString()).toBe('typed text + remote');
  });

  it('applies remote updates to the mounted editor', () => {
    const doc = docWith('abc');
    mount({ doc });
    doc.transact(() => doc.getText(TEXT_FIELD).insert(3, 'def'), REMOTE_ORIGIN);
    expect(view().state.doc.toString()).toBe('abcdef');
  });

  it('switches documents by destroying the old view and binding a new one', () => {
    const first = docWith('first');
    const second = docWith('second');
    const { setDoc } = mount({ doc: first });
    const before = view();
    setDoc(second);
    expect(editors()).toHaveLength(1);
    expect(view()).not.toBe(before);
    expect(view().state.doc.toString()).toBe('second');

    view().dispatch({ changes: { from: 0, insert: '2nd ' } });
    expect(first.getText(TEXT_FIELD).toString()).toBe('first');
    expect(second.getText(TEXT_FIELD).toString()).toBe('2nd second');
  });

  it('keeps undo history across tab switches', () => {
    const doc = docWith('');
    const { setActive } = mount({ doc });
    view().dispatch({ changes: { from: 0, insert: 'undo me' } });
    setActive(false);
    setActive(true);
    undoManagerFor(doc.getText(TEXT_FIELD)).undo();
    expect(view().state.doc.toString()).toBe('');
  });

  it('shows the trash notice and blocks edits for read-only notes', () => {
    const doc = docWith('Config_Backup');
    const { setReadOnly } = mount({ doc, readOnly: true });
    expect(root.textContent).toContain(TRASHED_READ_ONLY_MESSAGE);
    expect(view().state.readOnly).toBe(true);
    expect(root.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');

    setReadOnly(false);
    expect(root.textContent).not.toContain(TRASHED_READ_ONLY_MESSAGE);
    expect(view().state.readOnly).toBe(false);
  });

  it('reconfigures the theme without remounting', () => {
    const { setScheme } = mount({ doc: docWith('x') });
    const before = view();
    setScheme('dark');
    expect(view()).toBe(before);
    expect(before.dom.classList.contains('cm-editor')).toBe(true);
  });

  it('takes focus on mount only when autoFocus is set', async () => {
    const plain = mount({ doc: docWith('a') });
    await Promise.resolve();
    expect(view().hasFocus).toBe(false);
    void plain;
    dispose?.();
    root.remove();

    root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <CodeMirrorView doc={docWith('b')} active={true} colorScheme="light" autoFocus={true} />, root);
    await Promise.resolve();
    expect(view().hasFocus).toBe(true);
  });

  it('reports titles from line 1 and ignores edits on other lines', () => {
    const titles: (string | null)[] = [];
    const doc = docWith('   const secret = 42;\nbody');
    mount({ doc, titles });
    expect(titles).toEqual(['const secret = 42;']);

    const length = view().state.doc.length;
    view().dispatch({ changes: { from: length, insert: ' more body' } });
    expect(titles).toHaveLength(1);

    view().dispatch({ changes: { from: 0, to: view().state.doc.line(1).to, insert: '' } });
    expect(titles).toEqual(['const secret = 42;', null]);
  });
});
