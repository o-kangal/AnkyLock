import { createRoot } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWordWrapPreference } from '../src/preferences/devicePreferences.js';
import { AnkyLockApp, createRuntime, workspaceCommand } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string): string | null => this.items.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.items.set(key, value);
}

const preference = (storage: MemoryStorage | null, narrow: boolean) =>
  createRoot(() => createWordWrapPreference(storage, () => narrow));

describe('word wrap preference', () => {
  it('starts off on wide screens and on for narrow ones until the user chooses', () => {
    expect(preference(new MemoryStorage(), false).wordWrap()).toBe(false);
    expect(preference(new MemoryStorage(), true).wordWrap()).toBe(true);
  });

  it("remembers this device's choice over the screen-size default", () => {
    const storage = new MemoryStorage();
    const wide = preference(storage, false);
    wide.toggle();
    expect(wide.wordWrap()).toBe(true);
    expect(storage.items.get('ankylock.wordWrap')).toBe('on');
    preference(storage, true).toggle();
    expect(preference(storage, true).wordWrap()).toBe(false);
  });

  it('works for the session when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const wrap = createRoot(() => createWordWrapPreference(broken, () => false));
    wrap.toggle();
    expect(wrap.wordWrap()).toBe(true);
  });

  it('toggles with Alt+Z on both platforms', () => {
    const altZ = { ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: 'Ω', code: 'KeyZ' };
    expect(workspaceCommand(altZ, 'desktop')).toBe('toggle-wrap');
    expect(workspaceCommand(altZ, 'web')).toBe('toggle-wrap');
    expect(workspaceCommand({ ...altZ, ctrlKey: true }, 'web')).toBeNull();
  });
});

describe('word wrap in the workspace', () => {
  beforeAll(() => {
    // jsdom has no layout; CodeMirror only needs these to exist.
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  });

  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('toggles from the status bar button and Alt+Z, without remounting the editor', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <AnkyLockApp runtime={runtime} platform="web" />, root);
    await until(() => runtime.status() === 'uninitialized', 'vault list');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await runtime.store.createTab();
    await until(() => root.querySelector('.cm-content') !== null, 'editor');
    const content = root.querySelector('.cm-content') as HTMLElement;
    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Wrap (Alt+Z)') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(content.classList.contains('cm-lineWrapping')).toBe(false);

    button.click();
    expect(content.classList.contains('cm-lineWrapping')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('ankylock.wordWrap')).toBe('on');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Ω', code: 'KeyZ', altKey: true, bubbles: true }));
    expect(content.classList.contains('cm-lineWrapping')).toBe(false);
    expect(root.querySelector('.cm-content')).toBe(content);
    await runtime.lock();
  });
});
