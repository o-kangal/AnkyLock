import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { createEffect, on, onCleanup, Show, untrack, type JSX } from 'solid-js';
import type * as Y from 'yjs';
import { TRASHED_READ_ONLY_MESSAGE } from '@ankylock/core';
import { editorBasics, editorTheme, type ColorScheme } from '../extensions/theme.js';
import { noteLanguage } from '../extensions/language.js';
import { links, type LinkOptions } from '../extensions/links.js';
import { noteSearch, type SearchLabels } from '../extensions/search.js';
import { titleListener } from '../extensions/title.js';
import { wordWrap } from '../extensions/wordWrap.js';
import { noteText, yjsBinding } from '../extensions/yjsBinding.js';

export interface CodeMirrorViewProps {
  /** Headless doc of the tab, owned by the sync DocManager; it outlives this component's view. */
  readonly doc: Y.Doc;
  /** Only the focused tab is active. Inactive tabs hold no EditorView and no DOM. */
  readonly active: boolean;
  /** Trashed notes are read-only (BR-LIFE-02). */
  readonly readOnly?: boolean;
  /** Shown above a read-only note, in the app's language (default: the English message). */
  readonly readOnlyNotice?: string;
  readonly colorScheme: ColorScheme;
  /** The note's name, or else its BR-NOTE-03 title from line 1; null when both are empty. */
  readonly onTitleChange?: (title: string | null) => void;
  /** Focus the editor when it mounts, so a new or opened note accepts typing immediately. */
  readonly autoFocus?: boolean;
  /** Soft-wrap long lines; toggling it reconfigures the open editor without remounting it. */
  readonly wordWrap?: boolean;
  /** Text size in px (default 13); narrow screens use 16 so iOS does not zoom on focus. */
  readonly fontSize?: number;
  /** Makes http(s) links clickable with the modifier key; without it, links are plain text. */
  readonly links?: LinkOptions;
  /** Find/replace panel text in the app's language (default: English). */
  readonly searchLabels?: SearchLabels;
  /** Each increase opens the find panel: a button for touch screens, which have no Ctrl+F. */
  readonly searchRequests?: number;
}

const readOnlyExtension = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

const containerStyle: JSX.CSSProperties = {
  display: 'flex',
  'flex-direction': 'column',
  height: '100%',
  'min-height': '0',
};

const noticeStyle: JSX.CSSProperties = {
  padding: '6px 12px',
  'font-size': '12px',
  background: '#fff4ce',
  color: '#5c4400',
  'border-bottom': '1px solid #e6d28f',
};

/**
 * CodeMirror 6 editor for the active tab. Mounting is driven by `active` and `doc`: the view is
 * created when the tab becomes active and destroyed (with its Yjs binding) when it becomes
 * inactive or the doc changes. Note text never enters a Solid signal; it lives in the Y.Doc.
 */
export function CodeMirrorView(props: CodeMirrorViewProps): JSX.Element {
  let host!: HTMLDivElement;
  const theme = new Compartment();
  const readOnly = new Compartment();
  const wrap = new Compartment();
  const find = new Compartment();

  createEffect(() => {
    if (!props.active) return;
    const doc = props.doc;
    const view = untrack(
      () =>
        new EditorView({
          parent: host,
          state: EditorState.create({
            doc: noteText(doc).toString(),
            extensions: [
              editorBasics,
              theme.of(editorTheme(props.colorScheme, props.fontSize)),
              readOnly.of(readOnlyExtension(props.readOnly ?? false)),
              wrap.of(wordWrap(props.wordWrap ?? false)),
              find.of(noteSearch(props.searchLabels)),
              yjsBinding(doc),
              noteLanguage(doc),
              titleListener(doc, (title) => props.onTitleChange?.(title)),
              props.links ? links(props.links) : [],
            ],
          }),
        }),
    );
    onCleanup(() => view.destroy());
    // Deferred so the view is attached and laid out before it takes focus.
    if (untrack(() => props.autoFocus)) queueMicrotask(() => view.focus());

    createEffect(() => view.dispatch({ effects: theme.reconfigure(editorTheme(props.colorScheme, props.fontSize)) }));
    createEffect(() => view.dispatch({ effects: readOnly.reconfigure(readOnlyExtension(props.readOnly ?? false)) }));
    createEffect(() => view.dispatch({ effects: wrap.reconfigure(wordWrap(props.wordWrap ?? false)) }));
    createEffect(() => view.dispatch({ effects: find.reconfigure(noteSearch(props.searchLabels)) }));
    createEffect(on(() => props.searchRequests, () => openSearchPanel(view), { defer: true }));
  });

  return (
    <div style={containerStyle}>
      <Show when={props.readOnly}>
        <div role="status" style={noticeStyle}>
          {props.readOnlyNotice ?? TRASHED_READ_ONLY_MESSAGE}
        </div>
      </Show>
      <div ref={host} style={{ flex: '1', 'min-height': '0' }} />
    </div>
  );
}
