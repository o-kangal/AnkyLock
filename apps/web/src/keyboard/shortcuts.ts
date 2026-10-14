/** Where the app runs; decides which keys the workspace shortcuts use. */
export type Platform = 'desktop' | 'web';

export type WorkspaceCommand = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab';

type Keys = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>;

/**
 * Browsers keep Ctrl+N, Ctrl+W and Ctrl+Tab for their own windows and tabs and never pass them
 * to the page, so the web app uses Alt combinations. Alt keys are matched by physical key
 * (`code`): with Alt held, macOS and some layouts type a different character.
 */
export function workspaceCommand(event: Keys, platform: Platform): WorkspaceCommand | null {
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

const LABELS: Record<Platform, Record<WorkspaceCommand, string>> = {
  desktop: { 'new-tab': 'Ctrl+N', 'close-tab': 'Ctrl+W', 'next-tab': 'Ctrl+Tab', 'previous-tab': 'Ctrl+Shift+Tab' },
  web: { 'new-tab': 'Alt+N', 'close-tab': 'Alt+W', 'next-tab': 'Alt+]', 'previous-tab': 'Alt+[' },
};

export const shortcutLabel = (command: WorkspaceCommand, platform: Platform): string => LABELS[platform][command];
