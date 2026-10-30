import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_DAY, type EpochMs } from '@ankylock/core';
import { InstallBanner } from '../src/pwa/InstallBanner.jsx';
import { createInstallSuggestion, type InstallEnvironment } from '../src/pwa/install.js';
import type { PreferenceStorage } from '../src/preferences/devicePreferences.js';

const ANDROID: InstallEnvironment = {
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36',
  maxTouchPoints: 5,
  standalone: false,
  touch: true,
};
const IPHONE: InstallEnvironment = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  standalone: false,
  touch: true,
};
const DESKTOP: InstallEnvironment = { ...ANDROID, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0', maxTouchPoints: 0, touch: false };

function memoryStorage(): PreferenceStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

function promptEvent(): Event & { prompt: ReturnType<typeof vi.fn> } {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(() => Promise.resolve()) });
}

function suggestionFor(env: InstallEnvironment, storage = memoryStorage(), at = 0) {
  const target = new EventTarget();
  let time = at;
  const state = createInstallSuggestion({ target, env, storage, now: () => time as EpochMs });
  return { state, target, storage, advance: (ms: number) => (time += ms) };
}

describe('install suggestion', () => {
  it('offers the browser install on Android once Chrome allows it, and keeps its mini-infobar away', async () => {
    const { state, target } = suggestionFor(ANDROID);
    expect(state.suggestion()).toBeNull();
    const event = promptEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    const offer = state.suggestion();
    expect(offer?.kind).toBe('prompt');
    if (offer?.kind === 'prompt') await offer.install();
    expect(event.prompt).toHaveBeenCalledOnce();
    // The event works once; nothing is offered until the browser sends a new one.
    expect(state.suggestion()).toBeNull();
  });

  it('explains the Share menu on iOS, but not in in-app browsers that cannot install', () => {
    expect(suggestionFor(IPHONE).state.suggestion()).toEqual({ kind: 'ios' });
    const ipad = { ...IPHONE, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/19.0 Safari/605.1.15' };
    expect(suggestionFor(ipad).state.suggestion()).toEqual({ kind: 'ios' });
    const instagram = { ...IPHONE, userAgent: `${IPHONE.userAgent} Instagram 400.0` };
    expect(suggestionFor(instagram).state.suggestion()).toBeNull();
  });

  it('suggests nothing on desktops or inside the installed app', () => {
    const desktop = suggestionFor(DESKTOP);
    desktop.target.dispatchEvent(promptEvent());
    expect(desktop.state.suggestion()).toBeNull();
    expect(suggestionFor({ ...IPHONE, standalone: true }).state.suggestion()).toBeNull();

    const android = suggestionFor(ANDROID);
    android.target.dispatchEvent(promptEvent());
    android.target.dispatchEvent(new Event('appinstalled'));
    expect(android.state.suggestion()).toBeNull();
  });

  it('"Not now" hides it on this device for 30 days', () => {
    const storage = memoryStorage();
    const first = suggestionFor(IPHONE, storage, 1_000);
    first.state.later();
    expect(first.state.suggestion()).toBeNull();

    expect(suggestionFor(IPHONE, storage, 1_000 + 29 * MS_PER_DAY).state.suggestion()).toBeNull();
    expect(suggestionFor(IPHONE, storage, 1_000 + 30 * MS_PER_DAY).state.suggestion()).toEqual({ kind: 'ios' });
  });

  it('"Don\'t show again" hides it on this device for good', () => {
    const storage = memoryStorage();
    suggestionFor(IPHONE, storage).state.never();
    expect(storage.items.get('ankylock.installSuggestion')).toBe('never');
    expect(suggestionFor(IPHONE, storage, 400 * MS_PER_DAY).state.suggestion()).toBeNull();
  });
});

describe('InstallBanner', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.innerHTML = '';
  });

  it('shows the iOS steps with the Share icon and both ways to dismiss', () => {
    const later = vi.fn();
    const never = vi.fn();
    dispose = render(() => <InstallBanner suggestion={{ kind: 'ios' }} onLater={later} onNever={never} />, document.body);
    expect(document.body.textContent).toContain('Tap Share');
    expect(document.querySelector('svg')).not.toBeNull();
    const buttons = Array.from(document.querySelectorAll('button'), (b) => b.textContent);
    expect(buttons).toEqual(['Don’t show again', 'Not now']);
    document.querySelectorAll('button')[1]?.click();
    expect(later).toHaveBeenCalledOnce();
  });

  it('adds an Install button where the browser can install', () => {
    const install = vi.fn(() => Promise.resolve());
    dispose = render(() => <InstallBanner suggestion={{ kind: 'prompt', install }} onLater={vi.fn()} onNever={vi.fn()} />, document.body);
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Install');
    button?.click();
    expect(install).toHaveBeenCalledOnce();
  });
});
