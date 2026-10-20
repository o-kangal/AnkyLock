import { createRoot } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyColorScheme,
  createThemePreference,
  initialColorScheme,
  THEME_COLORS,
} from '../src/theme/colorScheme.js';
import { AnkyLockApp, createRuntime } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string): string | null => this.items.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.items.set(key, value);
}

/** Stand-in for `matchMedia('(prefers-color-scheme: dark)')` whose OS setting tests can flip. */
class FakeQuery {
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>();
  constructor(public matches: boolean) {}
  addEventListener = (_type: string, listener: (event: MediaQueryListEvent) => void): void => void this.listeners.add(listener);
  removeEventListener = (_type: string, listener: (event: MediaQueryListEvent) => void): void => void this.listeners.delete(listener);
  flip(dark: boolean): void {
    this.matches = dark;
    for (const listener of this.listeners) listener({ matches: dark } as MediaQueryListEvent);
  }
  asList = (): MediaQueryList => this as unknown as MediaQueryList;
}

const preference = (storage: MemoryStorage | null, query: FakeQuery) =>
  createRoot(() => createThemePreference(storage, query.asList()));

describe('theme preference', () => {
  it('follows the OS by default, live', () => {
    const os = new FakeQuery(true);
    const theme = preference(new MemoryStorage(), os);
    expect(theme.choice()).toBe('system');
    expect(theme.scheme()).toBe('dark');
    os.flip(false);
    expect(theme.scheme()).toBe('light');
  });

  it("remembers this device's choice over the OS setting", () => {
    const storage = new MemoryStorage();
    const os = new FakeQuery(false);
    preference(storage, os).choose('dark');
    expect(storage.items.get('ankylock.theme')).toBe('dark');
    const reopened = preference(storage, os);
    expect(reopened.choice()).toBe('dark');
    expect(reopened.scheme()).toBe('dark');
    os.flip(true);
    reopened.choose('light');
    expect(reopened.scheme()).toBe('light');
    expect(initialColorScheme(storage, os.asList())).toBe('light');
  });

  it('cycles System → Light → Dark → System', () => {
    const theme = preference(new MemoryStorage(), new FakeQuery(false));
    const seen = [theme.choice()];
    for (let i = 0; i < 3; i++) {
      theme.cycle();
      seen.push(theme.choice());
    }
    expect(seen).toEqual(['system', 'light', 'dark', 'system']);
  });

  it('ignores unknown stored values and works when storage is unavailable', () => {
    const storage = new MemoryStorage();
    storage.setItem('ankylock.theme', 'sepia');
    expect(preference(storage, new FakeQuery(false)).choice()).toBe('system');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const theme = createRoot(() => createThemePreference(broken, new FakeQuery(false).asList()));
    theme.choose('dark');
    expect(theme.scheme()).toBe('dark');
    expect(initialColorScheme(broken, null)).toBe('light');
  });
});

describe('applying a scheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.head.replaceChildren();
  });

  it('sets the palette, native control scheme and browser theme color on the root', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    applyColorScheme('dark');
    const root = document.documentElement;
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.getPropertyValue('--al-background')).toBe(THEME_COLORS.dark.background);
    expect(root.style.getPropertyValue('--al-row-border')).toBe(THEME_COLORS.dark.rowBorder);
    expect(meta.content).toBe(THEME_COLORS.dark.surface);
    applyColorScheme('light');
    expect(root.style.getPropertyValue('--al-background')).toBe(THEME_COLORS.light.background);
  });

  it('keeps both palettes complete', () => {
    expect(Object.keys(THEME_COLORS.dark).sort()).toEqual(Object.keys(THEME_COLORS.light).sort());
  });
});

describe('theme in the app', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('style');
    localStorage.clear();
  });

  it('switches from the status bar and the vault menu, for the whole document', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    const os = new FakeQuery(false);
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(
      () => <AnkyLockApp runtime={runtime} platform="web" theme={createThemePreference(localStorage, os.asList())} />,
      root,
    );
    await until(() => runtime.status() === 'uninitialized', 'vault list');
    // The unlock screen is themed too.
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await until(() => root.querySelector('footer') !== null, 'workspace');

    const statusButton = (): HTMLButtonElement =>
      Array.from(root.querySelectorAll('footer button')).find((b) => b.getAttribute('title')?.startsWith('Color theme')) as HTMLButtonElement;
    expect(statusButton().textContent).toBe('System');
    statusButton().click();
    statusButton().click();
    expect(statusButton().textContent).toBe('Dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem('ankylock.theme')).toBe('dark');

    (Array.from(root.querySelectorAll('footer button')).find((b) => b.textContent?.endsWith('▾')) as HTMLButtonElement).click();
    await until(() => document.querySelector('[role="group"][aria-label="Theme"]') !== null, 'vault menu');
    const options = Array.from(document.querySelectorAll('[role="group"][aria-label="Theme"] button')) as HTMLButtonElement[];
    expect(options.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['System', 'false'],
      ['Light', 'false'],
      ['Dark', 'true'],
    ]);
    options[0]?.click();
    expect(statusButton().textContent).toBe('System');
    os.flip(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    await runtime.lock();
  });
});
