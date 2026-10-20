import { createSignal, type Accessor } from 'solid-js';

/** Screens narrower than this (the mobile PWA) start with word wrap on. */
export const NARROW_SCREEN_PX = 600;
const WORD_WRAP_KEY = 'ankylock.wordWrap';

export interface WordWrapPreference {
  readonly wordWrap: Accessor<boolean>;
  toggle(): void;
}

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPreference(storage: PreferenceStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(storage: PreferenceStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts for this session.
  }
}

const isNarrowScreen = (): boolean =>
  typeof matchMedia === 'function'
    ? matchMedia(`(max-width: ${NARROW_SCREEN_PX - 0.02}px)`).matches
    : window.innerWidth < NARROW_SCREEN_PX;

/**
 * Word wrap is a preference of this device, for every vault: a phone and a desktop may want it
 * differently. It holds no note content, so it is neither synced nor encrypted. Until the user
 * chooses, it is on for narrow screens only.
 */
export function createWordWrapPreference(
  storage: PreferenceStorage | null = defaultStorage(),
  narrow: () => boolean = isNarrowScreen,
): WordWrapPreference {
  const saved = readPreference(storage, WORD_WRAP_KEY);
  const [wordWrap, setWordWrap] = createSignal(saved === null ? narrow() : saved === 'on');
  return {
    wordWrap,
    toggle() {
      const next = !wordWrap();
      setWordWrap(next);
      writePreference(storage, WORD_WRAP_KEY, next ? 'on' : 'off');
    },
  };
}
