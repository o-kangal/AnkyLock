import { defaultKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  scrollPastEnd,
} from '@codemirror/view';

export type ColorScheme = 'light' | 'dark';

interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly gutterBackground: string;
  readonly gutterForeground: string;
  readonly activeLine: string;
  readonly selection: string;
  readonly cursor: string;
}

// Minimal Notepad++-like palettes: plain background, muted gutter, soft active-line band.
const PALETTES: Record<ColorScheme, Palette> = {
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    gutterBackground: '#f3f3f3',
    gutterForeground: '#8a8a8a',
    activeLine: '#e8f2fe',
    selection: '#c0d8f5',
    cursor: '#1f1f1f',
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    gutterBackground: '#252526',
    gutterForeground: '#6e7681',
    activeLine: '#2a2d2e',
    selection: '#264f78',
    cursor: '#aeafad',
  },
};

const FONT_STACK = '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace';

/** Scoped CodeMirror theme (no global CSS): colors, monospace font and line padding. */
export function editorTheme(scheme: ColorScheme): Extension {
  const p = PALETTES[scheme];
  return EditorView.theme(
    {
      '&': { height: '100%', color: p.foreground, backgroundColor: p.background, fontSize: '13px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: FONT_STACK, lineHeight: '1.5' },
      '.cm-content': { padding: '6px 0', caretColor: p.cursor },
      '.cm-line': { padding: '0 12px 0 8px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
      '.cm-gutters': { backgroundColor: p.gutterBackground, color: p.gutterForeground, border: 'none' },
      '.cm-activeLine': { backgroundColor: p.activeLine },
      '.cm-activeLineGutter': { backgroundColor: p.activeLine },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: p.selection,
      },
    },
    { dark: scheme === 'dark' },
  );
}

/**
 * Plain-text editing basics. CodeMirror already renders only the lines in the viewport,
 * so multi-megabyte scratchpads stay cheap. Syntax highlighting is out of MVP scope.
 */
export const editorBasics: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  drawSelection(),
  highlightActiveLine(),
  scrollPastEnd(),
  keymap.of(defaultKeymap),
];
