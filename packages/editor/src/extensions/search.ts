import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/** Every phrase the find/replace panel and the go-to-line dialog show, in CodeMirror's English. */
export type SearchPhrase =
  | 'Find'
  | 'Replace'
  | 'next'
  | 'previous'
  | 'all'
  | 'match case'
  | 'regexp'
  | 'by word'
  | 'replace'
  | 'replace all'
  | 'close'
  | 'current match'
  | 'on line'
  | 'replaced $ matches'
  | 'replaced match on line $'
  | 'Go to line'
  | 'go';

/** The panel's text in the app's language; `$` stands for a number. */
export type SearchLabels = Readonly<Record<SearchPhrase, string>>;

/**
 * Find and replace in the open note: Mod+F opens the panel above the text, F3 or Mod+G jumps to
 * the next match (with Shift, the previous one), Escape closes it. Mod+D adds the next occurrence
 * of the selection as another cursor, Mod+Alt+G goes to a line. A read-only note hides Replace.
 */
export function noteSearch(labels?: SearchLabels): Extension {
  return [search({ top: true }), keymap.of(searchKeymap), labels ? EditorState.phrases.of(labels) : []];
}
