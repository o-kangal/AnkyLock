import { createSignal, type Accessor } from 'solid-js';
import { MS_PER_DAY, type EpochMs } from '@ankylock/core';
import { defaultStorage, readPreference, writePreference, type PreferenceStorage } from '../preferences/devicePreferences.js';

const INSTALL_KEY = 'ankylock.installSuggestion';
/** "Not now" hides the suggestion for this long. */
export const INSTALL_SNOOZE_MS = 30 * MS_PER_DAY;

/** Chromium's install event; TypeScript's DOM types do not have it. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const isInstallEvent = (event: Event): event is BeforeInstallPromptEvent =>
  'prompt' in event && typeof event.prompt === 'function';

/** Android and other Chromium browsers install on a tap; iOS only from the Share menu. */
export type InstallSuggestion = { readonly kind: 'prompt'; install(): Promise<void> } | { readonly kind: 'ios' };

export interface InstallEnvironment {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** Already running as the installed app. */
  readonly standalone: boolean;
  /** A touch screen is the main input: phones and tablets, not desktops. */
  readonly touch: boolean;
}

export function browserEnvironment(): InstallEnvironment {
  const media = (query: string): boolean => typeof matchMedia === 'function' && matchMedia(query).matches;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    // Safari reports the home-screen app through `navigator.standalone`.
    standalone: media('(display-mode: standalone)') || ('standalone' in navigator && navigator.standalone === true),
    touch: media('(pointer: coarse)'),
  };
}

/** Safari and other iOS browsers can add to the home screen; in-app browsers (Instagram, the Google app…) cannot. */
export function canInstallOnIos(env: InstallEnvironment): boolean {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  return ios && !/FBAN|FBAV|Instagram|Line\/|GSA\/|Twitter/.test(env.userAgent);
}

export interface InstallSuggestionState {
  /** What to suggest now, or null: not a touch device, already installed, or dismissed. */
  readonly suggestion: Accessor<InstallSuggestion | null>;
  /** "Not now": hides it for 30 days on this device. */
  later(): void;
  /** "Don't show again" on this device. */
  never(): void;
  dispose(): void;
}

/**
 * Suggests installing the web app on phones and tablets. Listens from app start: Chromium fires
 * `beforeinstallprompt` once, early, and the app shows the suggestion only later (once a vault
 * is open). The choice is a preference of this device, like word wrap.
 */
export function createInstallSuggestion(
  options: {
    readonly target?: EventTarget;
    readonly env?: InstallEnvironment;
    readonly storage?: PreferenceStorage | null;
    readonly now?: () => EpochMs;
  } = {},
): InstallSuggestionState {
  const target = options.target ?? window;
  const env = options.env ?? browserEnvironment();
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);

  const saved = readPreference(storage, INSTALL_KEY) ?? '';
  const snoozedAt = saved.startsWith('later:') ? Number(saved.slice('later:'.length)) : Number.NaN;
  const [dismissed, setDismissed] = createSignal(saved === 'never' || now() - snoozedAt < INSTALL_SNOOZE_MS);
  const [pending, setPending] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = createSignal(env.standalone);

  const onPrompt = (event: Event): void => {
    if (!isInstallEvent(event)) return;
    // Keeps the browser's own mini-infobar away; the app asks at a better moment.
    event.preventDefault();
    setPending(event);
  };
  const onInstalled = (): void => {
    setInstalled(true);
    setPending(null);
  };
  target.addEventListener('beforeinstallprompt', onPrompt);
  target.addEventListener('appinstalled', onInstalled);

  const suggestion = (): InstallSuggestion | null => {
    if (!env.touch || installed() || dismissed()) return null;
    const event = pending();
    if (event) {
      return {
        kind: 'prompt',
        async install() {
          // A prompt event works once; the browser fires a new one if the user declines.
          setPending(null);
          await event.prompt();
        },
      };
    }
    return canInstallOnIos(env) ? { kind: 'ios' } : null;
  };

  return {
    suggestion,
    later() {
      writePreference(storage, INSTALL_KEY, `later:${now()}`);
      setDismissed(true);
    },
    never() {
      writePreference(storage, INSTALL_KEY, 'never');
      setDismissed(true);
    },
    dispose() {
      target.removeEventListener('beforeinstallprompt', onPrompt);
      target.removeEventListener('appinstalled', onInstalled);
    },
  };
}
