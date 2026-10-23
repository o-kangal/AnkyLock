import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findLinks, isOpenableUrl, links, type LinkModifier } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

describe('link detection', () => {
  it('finds http(s) links and leaves trailing punctuation out', () => {
    const text = 'See https://ankylock.com/docs?a=1#top, and (http://example.org/x). Not ftp://a or javascript:alert(1)';
    expect(findLinks(text).map((l) => l.url)).toEqual(['https://ankylock.com/docs?a=1#top', 'http://example.org/x']);
    const [first] = findLinks(text, 100);
    expect(first).toEqual({ from: 104, to: 104 + 'https://ankylock.com/docs?a=1#top'.length, url: 'https://ankylock.com/docs?a=1#top' });
  });

  it('treats www. addresses as https links, but not bare names', () => {
    const text = 'Go to www.ankylock.com/pricing. Not ankylock.com, index.ts, console.log or awww.x';
    expect(findLinks(text)).toEqual([{ from: 6, to: 6 + 'www.ankylock.com/pricing'.length, url: 'https://www.ankylock.com/pricing' }]);
    expect(findLinks('WWW.Example.org').map((l) => l.url)).toEqual(['https://WWW.Example.org']);
  });

  it('stops at quotes and brackets used in code', () => {
    expect(findLinks('fetch("https://api.test/v1/items")').map((l) => l.url)).toEqual(['https://api.test/v1/items']);
    expect(findLinks('<a href=https://x.test>').map((l) => l.url)).toEqual(['https://x.test']);
  });

  it('opens web schemes only', () => {
    expect(isOpenableUrl('https://ankylock.com')).toBe(true);
    expect(isOpenableUrl('HTTP://ankylock.com')).toBe(true);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'mailto:a@b.c', 'not a url']) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });
});

const TEXT = 'docs: https://ankylock.com/help and more';
const LINK_POS = TEXT.indexOf('https') + 5;

describe('links in the editor', () => {
  let view: EditorView | undefined;
  afterEach(() => {
    view?.destroy();
    document.body.replaceChildren();
  });

  function mount(modifier: LinkModifier = 'ctrl') {
    const opened: string[] = [];
    view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: TEXT, extensions: links({ modifier, open: (url) => opened.push(url) }) }),
    });
    return { view, opened };
  }

  /** A press at document position `pos` (jsdom has no layout, so coordinates map to it directly). */
  function press(target: EditorView, pos: number, init: MouseEventInit): void {
    target.posAtCoords = () => pos;
    target.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
  }

  it('underlines links', () => {
    const { view } = mount();
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-link')).map((e) => e.textContent)).toEqual(['https://ankylock.com/help']);
  });

  it('opens a link with Ctrl+click, and a plain click only places the cursor', () => {
    const { view, opened } = mount();
    press(view, LINK_POS, {});
    expect(opened).toEqual([]);
    press(view, LINK_POS, { ctrlKey: true });
    expect(opened).toEqual(['https://ankylock.com/help']);
    press(view, 2, { ctrlKey: true });
    expect(opened).toHaveLength(1);
    view.dispatch({ changes: { from: 0, insert: 'www.ankylock.com ' } });
    press(view, 3, { ctrlKey: true });
    expect(opened).toEqual(['https://ankylock.com/help', 'https://www.ankylock.com']);
  });

  it('uses ⌘ instead of Ctrl on Apple platforms', () => {
    const { view, opened } = mount('meta');
    press(view, LINK_POS, { ctrlKey: true });
    expect(opened).toEqual([]);
    press(view, LINK_POS, { metaKey: true });
    expect(opened).toEqual(['https://ankylock.com/help']);
  });

  it('shows an "Open link" button when a link is tapped on a touch screen', () => {
    const { view, opened } = mount();
    const touch = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    view.contentDOM.dispatchEvent(touch);
    view.dispatch({ selection: { anchor: LINK_POS } });
    const button = (): HTMLButtonElement | null => view.dom.querySelector('.cm-link-open');
    expect(button()?.textContent).toBe('Open link');
    button()?.click();
    expect(opened).toEqual(['https://ankylock.com/help']);

    // Moving off the link, or typing, hides it.
    view.dispatch({ selection: { anchor: 1 } });
    expect(button()).toBeNull();
    view.dispatch({ selection: { anchor: LINK_POS } });
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(button()).toBeNull();
  });

  it('never shows the touch button for mouse clicks', () => {
    const { view } = mount();
    const mouse = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperty(mouse, 'pointerType', { value: 'mouse' });
    view.contentDOM.dispatchEvent(mouse);
    view.dispatch({ selection: { anchor: LINK_POS } });
    expect(view.dom.querySelector('.cm-link-open')).toBeNull();
  });
});
