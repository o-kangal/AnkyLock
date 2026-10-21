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
import { indentation } from './indentation.js';

export type ColorScheme = 'light' | 'dark';

interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly gutterBackground: string;
  readonly gutterForeground: string;
  readonly activeLine: string;
  readonly selection: string;
  readonly cursor: string;
  readonly link: string;
  readonly tooltipBackground: string;
  readonly tooltipBorder: string;
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
    link: '#0067c0',
    tooltipBackground: '#f3f3f3',
    tooltipBorder: '#c8c8c8',
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    gutterBackground: '#252526',
    gutterForeground: '#6e7681',
    activeLine: '#2a2d2e',
    selection: '#264f78',
    cursor: '#aeafad',
    link: '#4fa3ff',
    tooltipBackground: '#252526',
    tooltipBorder: '#454545',
  },
};

/** Left padding of every line; wrapped rows of indented lines build on it (see `wordWrap`). */
export const LINE_PADDING_LEFT = '8px';

const FONT_STACK = '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace';

/**
 * Scoped CodeMirror theme (no global CSS): colors, monospace font and line padding. Narrow
 * screens pass 16 px: iOS zooms into any focused text smaller than that.
 */
export function editorTheme(scheme: ColorScheme, fontSizePx = 13): Extension {
  const p = PALETTES[scheme];
  return EditorView.theme(
    {
      '&': { height: '100%', color: p.foreground, backgroundColor: p.background, fontSize: `${fontSizePx}px` },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: FONT_STACK, lineHeight: '1.5' },
      '.cm-content': { padding: '6px 0', caretColor: p.cursor },
      '.cm-line': { padding: `0 12px 0 ${LINE_PADDING_LEFT}` },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
      '.cm-gutters': { backgroundColor: p.gutterBackground, color: p.gutterForeground, border: 'none' },
      '.cm-activeLine': { backgroundColor: p.activeLine },
      '.cm-activeLineGutter': { backgroundColor: p.activeLine },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: p.selection,
      },
      '.cm-link': { color: p.link, textDecoration: 'underline' },
      '.cm-tooltip': {
        backgroundColor: p.tooltipBackground,
        color: p.foreground,
        border: `1px solid ${p.tooltipBorder}`,
        borderRadius: '4px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: '12px',
      },
      '.cm-link-hint': { padding: '3px 8px' },
      '.cm-link-open': {
        minHeight: '40px',
        padding: '0 14px',
        border: 'none',
        background: 'transparent',
        color: p.link,
        font: 'inherit',
        fontSize: '15px',
        cursor: 'pointer',
      },
    },
    { dark: scheme === 'dark' },
  );
}

/**
 * Plain-text editing basics. CodeMirror already renders only the lines in the viewport,
 * so multi-megabyte scratchpads stay cheap. Syntax highlighting is out of MVP scope.
 * Tab indents (before the default keymap, so it wins).
 */
export const editorBasics: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  drawSelection(),
  highlightActiveLine(),
  scrollPastEnd(),
  indentation,
  keymap.of(defaultKeymap),
];
