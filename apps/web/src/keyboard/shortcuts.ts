/** Where the app runs; decides which keys the workspace shortcuts use. */
export type Platform = 'desktop' | 'web';

export type WorkspaceCommand = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'toggle-wrap' | 'shortcut-guide';

type Keys = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>;

/**
 * Browsers keep Ctrl+N, Ctrl+W and Ctrl+Tab for their own windows and tabs and never pass them
 * to the page, so the web app uses Alt combinations. Alt keys are matched by physical key
 * (`code`): with Alt held, macOS and some layouts type a different character.
 */
export function workspaceCommand(event: Keys, platform: Platform): WorkspaceCommand | null {
  if (event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return 'shortcut-guide';
  // Alt+Z (as in VS Code) on both platforms: browsers leave it to the page.
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyZ') return 'toggle-wrap';
  if (platform === 'desktop') {
    if (!(event.ctrlKey || event.metaKey)) return null;
    switch (event.key.toLowerCase()) {
      case 'n':
        return 'new-tab';
      case 'w':
        return 'close-tab';
      case 'tab':
        return event.shiftKey ? 'previous-tab' : 'next-tab';
      default:
        return null;
    }
  }
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.code) {
    case 'KeyN':
      return 'new-tab';
    case 'KeyW':
      return 'close-tab';
    case 'BracketRight':
      return 'next-tab';
    case 'BracketLeft':
      return 'previous-tab';
    default:
      return null;
  }
}

// `Mod` is Ctrl, or ⌘ on Apple platforms (Ctrl+Tab stays Ctrl there: ⌘+Tab switches apps).
const KEYS: Record<Platform, Record<WorkspaceCommand, string>> = {
  desktop: {
    'new-tab': 'Mod+N',
    'close-tab': 'Mod+W',
    'next-tab': 'Ctrl+Tab',
    'previous-tab': 'Ctrl+Shift+Tab',
    'toggle-wrap': 'Alt+Z',
    'shortcut-guide': 'F1',
  },
  web: {
    'new-tab': 'Alt+N',
    'close-tab': 'Alt+W',
    'next-tab': 'Alt+]',
    'previous-tab': 'Alt+[',
    'toggle-wrap': 'Alt+Z',
    'shortcut-guide': 'F1',
  },
};

/** The keys of a workspace command, as `formatKeys` takes them. */
export const shortcutKeys = (command: WorkspaceCommand, platform: Platform): string => KEYS[platform][command];

// `navigator.platform` is deprecated but still the reliable source: user agents may claim to be a
// Mac for compatibility, and `userAgentData` exists in Chromium only.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export const isApplePlatform = (platform: string = navigator.platform): boolean => /^(Mac|iPhone|iPad|iPod)/.test(platform);

const APPLE_MODIFIERS: Readonly<Record<string, string>> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };

/** `Mod+Shift+K` → `['Ctrl', 'Shift', 'K']`, or `['⌘', '⇧', 'K']` on Apple platforms. */
export function formatKeys(keys: string, apple: boolean = isApplePlatform()): string[] {
  return keys.split('+').map((key) => (apple ? (APPLE_MODIFIERS[key] ?? key) : key === 'Mod' ? 'Ctrl' : key));
}

export const shortcutLabel = (command: WorkspaceCommand, platform: Platform, apple: boolean = isApplePlatform()): string =>
  formatKeys(shortcutKeys(command, platform), apple).join(apple ? '' : '+');

/** Ctrl+click opens links, ⌘+click on Apple platforms (where Ctrl+click is a right click). */
export function linkModifier(platform?: string): 'ctrl' | 'meta' {
  return isApplePlatform(platform) ? 'meta' : 'ctrl';
}
