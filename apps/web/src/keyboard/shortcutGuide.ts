import type { MessageKey } from '../i18n/index.js';
import { shortcutKeys, type Platform } from './shortcuts.js';

/** One action and the keys that run it; alternatives are listed in order of preference. */
export interface GuideEntry {
  readonly action: MessageKey;
  /** Each like `Mod+Shift+K` (see `formatKeys`); `Click` and `Drag` are mouse actions. */
  readonly keys: readonly string[];
}

export interface GuideGroup {
  readonly title: MessageKey;
  readonly entries: readonly GuideEntry[];
}

/**
 * Every shortcut the app answers to, for the guide (F1). The editor keys are CodeMirror's
 * defaults plus search; keep this list in step when a keymap changes.
 */
export function shortcutGuide(platform: Platform, apple: boolean): readonly GuideGroup[] {
  return [
    {
      title: 'guide.tabs',
      entries: [
        { action: 'guide.newTab', keys: [shortcutKeys('new-tab', platform)] },
        { action: 'guide.closeTab', keys: [shortcutKeys('close-tab', platform)] },
        { action: 'guide.nextTab', keys: [shortcutKeys('next-tab', platform)] },
        { action: 'guide.previousTab', keys: [shortcutKeys('previous-tab', platform)] },
        { action: 'guide.wordWrap', keys: [shortcutKeys('toggle-wrap', platform)] },
      ],
    },
    {
      title: 'guide.find',
      entries: [
        { action: 'guide.findReplace', keys: ['Mod+F'] },
        { action: 'guide.findNext', keys: ['F3', 'Mod+G'] },
        { action: 'guide.findPrevious', keys: ['Shift+F3', 'Mod+Shift+G'] },
        { action: 'guide.goToLine', keys: ['Mod+Alt+G'] },
        { action: 'guide.closePanel', keys: ['Esc'] },
      ],
    },
    {
      title: 'guide.cursors',
      entries: [
        { action: 'guide.columnSelect', keys: ['Alt+Drag'] },
        { action: 'guide.addCursor', keys: ['Mod+Click'] },
        { action: 'guide.selectNext', keys: ['Mod+D'] },
        { action: 'guide.selectAll', keys: ['Mod+Shift+L'] },
        { action: 'guide.cursorAboveBelow', keys: ['Mod+Alt+↑', 'Mod+Alt+↓'] },
      ],
    },
    {
      title: 'guide.lines',
      entries: [
        { action: 'guide.moveLine', keys: ['Alt+↑', 'Alt+↓'] },
        { action: 'guide.copyLine', keys: ['Shift+Alt+↑', 'Shift+Alt+↓'] },
        { action: 'guide.deleteLine', keys: ['Mod+Shift+K'] },
        { action: 'guide.toggleComment', keys: ['Mod+/'] },
        { action: 'guide.indent', keys: ['Tab'] },
        { action: 'guide.outdent', keys: ['Shift+Tab'] },
      ],
    },
    {
      title: 'guide.general',
      entries: [
        { action: 'guide.undo', keys: ['Mod+Z'] },
        // Mod+Y is not redo on Apple platforms.
        { action: 'guide.redo', keys: apple ? ['Mod+Shift+Z'] : ['Mod+Y', 'Mod+Shift+Z'] },
        { action: 'guide.openLink', keys: ['Mod+Click'] },
        { action: 'guide.guide', keys: [shortcutKeys('shortcut-guide', platform)] },
      ],
    },
  ];
}
