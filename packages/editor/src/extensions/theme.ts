import { defaultKeymap } from '@codemirror/commands';
import { EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
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
  readonly searchMatch: string;
  readonly searchMatchSelected: string;
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
    searchMatch: '#f8e08e',
    searchMatchSelected: '#f5b867',
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
    searchMatch: '#623315',
    searchMatchSelected: '#9e6a03',
  },
};

/** Left padding of every line; wrapped rows of indented lines build on it (see `wordWrap`). */
export const LINE_PADDING_LEFT = '8px';

// The app registers "JetBrains Mono Variable" and "Plus Jakarta Sans Variable" (Fontsource names).
const FONT_STACK =
  '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const UI_FONT_STACK = '"Plus Jakarta Sans Variable", system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Scoped CodeMirror theme (no global CSS): colors, monospace font and line padding. Narrow
 * screens pass 16 px: iOS zooms into any focused text smaller than that.
 */
export function editorTheme(scheme: ColorScheme, fontSizePx = 14): Extension {
  const p = PALETTES[scheme];
  return EditorView.theme(
    {
      '&': { height: '100%', color: p.foreground, backgroundColor: p.background, fontSize: `${fontSizePx}px` },
      '&.cm-focused': { outline: 'none' },
      // Ligatures off: `->` and `!=` stay the characters that were typed.
      '.cm-scroller': { fontFamily: FONT_STACK, lineHeight: '1.6', fontVariantLigatures: 'none' },
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
        borderRadius: '8px',
        fontFamily: UI_FONT_STACK,
        fontSize: '12px',
      },
      '.cm-link-hint': { padding: '3px 8px' },
      '.cm-searchMatch': { backgroundColor: p.searchMatch },
      '.cm-searchMatch-selected, .cm-searchMatch-selected .cm-searchMatch': { backgroundColor: p.searchMatchSelected },
      '.cm-panels': { backgroundColor: p.tooltipBackground, color: p.foreground, fontFamily: UI_FONT_STACK, fontSize: '12px' },
      '.cm-panels-top': { borderBottom: `1px solid ${p.tooltipBorder}` },
      '.cm-panel.cm-search': { padding: '6px 32px 6px 8px' },
      // At least 16 px on narrow screens, like the text: iOS zooms into smaller focused fields.
      '.cm-textfield': {
        backgroundColor: p.background,
        color: p.foreground,
        border: `1px solid ${p.tooltipBorder}`,
        borderRadius: '4px',
        fontFamily: FONT_STACK,
        fontSize: fontSizePx >= 16 ? '16px' : '12px',
      },
      '.cm-textfield:focus': { outline: `1px solid ${p.link}`, outlineOffset: '-1px' },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: p.background,
        color: p.foreground,
        border: `1px solid ${p.tooltipBorder}`,
        borderRadius: '4px',
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      '.cm-panel.cm-search [name=close]': { color: p.gutterForeground, fontSize: '18px', cursor: 'pointer' },
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
 * Tab indents (before the default keymap, so it wins). Alt+drag (⌥+drag on macOS) selects a
 * column, one cursor per line, so the same position on every line is edited at once.
 */
export const editorBasics: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  EditorState.allowMultipleSelections.of(true),
  drawSelection(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  scrollPastEnd(),
  indentation,
  keymap.of(defaultKeymap),
];
