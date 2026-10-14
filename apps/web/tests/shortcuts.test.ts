import { describe, expect, it } from 'vitest';
import { shortcutLabel, workspaceCommand } from '../src/keyboard/shortcuts.js';

const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...init });

describe('workspaceCommand', () => {
  it('uses Ctrl (or Cmd) on desktop', () => {
    expect(workspaceCommand(key({ ctrlKey: true, key: 'n' }), 'desktop')).toBe('new-tab');
    expect(workspaceCommand(key({ metaKey: true, key: 'W' }), 'desktop')).toBe('close-tab');
    expect(workspaceCommand(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }), 'desktop')).toBe('previous-tab');
    expect(workspaceCommand(key({ altKey: true, code: 'KeyN' }), 'desktop')).toBeNull();
  });

  it('uses Alt by physical key on the web, leaving Ctrl to the browser', () => {
    expect(workspaceCommand(key({ altKey: true, key: '˜', code: 'KeyN' }), 'web')).toBe('new-tab');
    expect(workspaceCommand(key({ altKey: true, code: 'KeyW' }), 'web')).toBe('close-tab');
    expect(workspaceCommand(key({ altKey: true, code: 'BracketRight' }), 'web')).toBe('next-tab');
    expect(workspaceCommand(key({ altKey: true, code: 'BracketLeft' }), 'web')).toBe('previous-tab');
    expect(workspaceCommand(key({ ctrlKey: true, key: 'n' }), 'web')).toBeNull();
    expect(workspaceCommand(key({ ctrlKey: true, altKey: true, code: 'KeyN' }), 'web')).toBeNull();
  });

  it('labels shortcuts per platform', () => {
    expect(shortcutLabel('new-tab', 'desktop')).toBe('Ctrl+N');
    expect(shortcutLabel('new-tab', 'web')).toBe('Alt+N');
  });
});
