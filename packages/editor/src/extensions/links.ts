import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  MatchDecorator,
  showTooltip,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';

/** The key held to open a link: Ctrl, or ⌘ on Apple platforms. */
export type LinkModifier = 'ctrl' | 'meta';

export interface LinkOptions {
  readonly modifier: LinkModifier;
  /** Called only with http(s) URLs (`www.` addresses arrive with `https://`); the app decides how to open them (system browser, new tab). */
  readonly open: (url: string) => void;
}

// http(s) URLs, plus `www.` addresses as people type them. Bare names like `index.ts` or
// `console.log` are code far more often than links, so they stay plain text. Stops at
// whitespace and characters that rarely belong to a URL in prose or code.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Sentence punctuation and closing brackets after a URL usually end the sentence, not the URL.
const TRAILING = /[.,;:!?)\]}]+$/;

/** Only web links open: never `javascript:`, `file:` or any other scheme. */
export function isOpenableUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export interface LinkMatch {
  readonly from: number;
  readonly to: number;
  readonly url: string;
}

/** The URL a matched link opens: `www.` addresses get `https://`. Null when it isn't a web link. */
function toUrl(text: string): string | null {
  const url = /^www\./i.test(text) ? `https://${text}` : text;
  return isOpenableUrl(url) ? url : null;
}

/** Links in one line of text, with document positions (`offset` is the line's start). */
export function findLinks(text: string, offset = 0): LinkMatch[] {
  const links: LinkMatch[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const text = match[0].replace(TRAILING, '');
    const url = toUrl(text);
    if (url === null) continue;
    const from = offset + (match.index ?? 0);
    links.push({ from, to: from + text.length, url });
  }
  return links;
}

/** The link at `pos` (inclusive of both ends), looking only at that line. */
export function linkAt(state: EditorState, pos: number): LinkMatch | null {
  const line = state.doc.lineAt(pos);
  return findLinks(line.text, line.from).find((link) => pos >= link.from && pos <= link.to) ?? null;
}

const linkMark = Decoration.mark({ class: 'cm-link' });

/** Underlines links in the viewport only; long notes are never scanned as a whole. */
const linkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    readonly decorator = new MatchDecorator({
      regexp: URL_PATTERN,
      decorate: (add, from, _to, match) => {
        const text = match[0].replace(TRAILING, '');
        if (toUrl(text) !== null) add(from, from + text.length, linkMark);
      },
    });
    constructor(view: EditorView) {
      this.decorations = this.decorator.createDeco(view);
    }
    update(update: ViewUpdate): void {
      this.decorations = this.decorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const setTouch = StateEffect.define<boolean>();

/**
 * Touch screens have no hover and no modifier keys: tapping into a link shows an "Open link"
 * button above it instead. A mouse click or typing hides it again.
 */
function touchLinkButton(options: LinkOptions): Extension {
  const touch = StateField.define<boolean>({
    create: () => false,
    update: (value, tr) => {
      for (const effect of tr.effects) if (effect.is(setTouch)) return effect.value;
      return tr.docChanged ? false : value;
    },
  });
  const tooltip = StateField.define<Tooltip | null>({
    create: () => null,
    update: (_value, tr) => {
      const { state } = tr;
      const cursor = state.selection.main;
      if (!state.field(touch) || !cursor.empty) return null;
      const link = linkAt(state, cursor.head);
      if (!link) return null;
      return {
        pos: link.from,
        above: true,
        create: () => {
          const dom = document.createElement('button');
          dom.type = 'button';
          dom.className = 'cm-link-open';
          dom.textContent = 'Open link';
          dom.title = link.url;
          dom.addEventListener('click', () => options.open(link.url));
          return { dom };
        },
      };
    },
    provide: (field) => showTooltip.from(field),
  });
  return [
    touch,
    tooltip,
    EditorView.domEventHandlers({
      pointerdown: (event, view) => {
        const isTouch = event.pointerType === 'touch' || event.pointerType === 'pen';
        if (view.state.field(touch) !== isTouch) view.dispatch({ effects: setTouch.of(isTouch) });
        return false;
      },
    }),
  ];
}

const held = (event: MouseEvent, modifier: LinkModifier): boolean => (modifier === 'meta' ? event.metaKey : event.ctrlKey);

/**
 * Clickable links: underlined, a hint on hover, opened with Ctrl+click (⌘+click on macOS).
 * A plain click still places the cursor, so link text stays editable.
 */
export function links(options: LinkOptions): Extension {
  const hint = `${options.modifier === 'meta' ? '⌘' : 'Ctrl'}+Click to open`;
  return [
    linkDecorations,
    hoverTooltip(
      (view, pos) => {
        const link = linkAt(view.state, pos);
        if (!link) return null;
        return {
          pos: link.from,
          end: link.to,
          above: true,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-link-hint';
            dom.textContent = hint;
            return { dom };
          },
        };
      },
      { hoverTime: 350 },
    ),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (event.button !== 0 || !held(event, options.modifier)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const link = pos === null ? null : linkAt(view.state, pos);
        if (!link) return false;
        event.preventDefault();
        options.open(link.url);
        return true;
      },
    }),
    touchLinkButton(options),
  ];
}
