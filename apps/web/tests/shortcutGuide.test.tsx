import { render } from 'solid-js/web';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatKeys, shortcutLabel, workspaceCommand } from '../src/keyboard/shortcuts.js';
import { shortcutGuide } from '../src/keyboard/shortcutGuide.js';
import { AnkyLockApp, createRuntime } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', ...init });

describe('shortcut keys', () => {
  it('opens the guide with F1 alone, on the web and the desktop', () => {
    expect(workspaceCommand(key({ key: 'F1', code: 'F1' }), 'web')).toBe('shortcut-guide');
    expect(workspaceCommand(key({ key: 'F1', code: 'F1' }), 'desktop')).toBe('shortcut-guide');
    expect(workspaceCommand(key({ key: 'F1', code: 'F1', shiftKey: true }), 'web')).toBeNull();
  });

  it('prints modifiers as symbols on Apple platforms and as words elsewhere', () => {
    expect(formatKeys('Mod+Shift+K', false)).toEqual(['Ctrl', 'Shift', 'K']);
    expect(formatKeys('Mod+Shift+K', true)).toEqual(['⌘', '⇧', 'K']);
    expect(formatKeys('Alt+Drag', true)).toEqual(['⌥', 'Drag']);
    expect(shortcutLabel('new-tab', 'desktop', true)).toBe('⌘N');
    // ⌘+Tab switches apps on macOS, so tabs keep Ctrl there.
    expect(shortcutLabel('next-tab', 'desktop', true)).toBe('⌃Tab');
    expect(shortcutLabel('new-tab', 'desktop', false)).toBe('Ctrl+N');
  });

  it('lists the platform keys for tabs', () => {
    const tabs = (platform: 'web' | 'desktop') => shortcutGuide(platform, false)[0]?.entries.map((e) => e.keys[0]);
    expect(tabs('web')).toEqual(['Alt+N', 'Alt+W', 'Alt+]', 'Alt+[', 'Alt+Z']);
    expect(tabs('desktop')).toEqual(['Mod+N', 'Mod+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Alt+Z']);
  });

  it('lists only the redo keys each platform has', () => {
    const redo = (apple: boolean) =>
      shortcutGuide('web', apple)
        .flatMap((g) => g.entries)
        .find((e) => e.action === 'guide.redo')?.keys;
    expect(redo(false)).toEqual(['Mod+Y', 'Mod+Shift+Z']);
    expect(redo(true)).toEqual(['Mod+Shift+Z']);
  });
});

describe('shortcut guide', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.innerHTML = '';
  });

  it('opens with F1 or the status bar button and closes with Escape', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <AnkyLockApp runtime={runtime} platform="web" />, root);
    await until(() => runtime.status() === 'uninitialized', 'vault list');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]');
    await until(() => document.querySelector('button[aria-label="Keyboard shortcuts (F1)"]') !== null, 'status bar');

    const f1 = new KeyboardEvent('keydown', { key: 'F1', code: 'F1', bubbles: true, cancelable: true });
    window.dispatchEvent(f1);
    expect(f1.defaultPrevented).toBe(true);
    expect(dialog()?.textContent).toContain('Comment or uncomment');
    const kbds = Array.from(dialog()?.querySelectorAll('kbd') ?? [], (k) => k.textContent);
    expect(kbds.slice(0, 2)).toEqual(['Alt', 'N']);

    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();

    document.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts (F1)"]')?.click();
    expect(dialog()).not.toBeNull();
    await runtime.lock();
  });
});
