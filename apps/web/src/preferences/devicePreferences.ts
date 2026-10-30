import { createSignal, type Accessor } from 'solid-js';
import { DEFAULT_SORT, type SortKey, type SortOrder } from '../components/sidebar/treeRows.js';

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

const SORT_KEY = 'ankylock.sortOrder';
const SORT_KEYS: readonly SortKey[] = ['modified', 'created', 'name'];

export interface SortPreference {
  readonly order: Accessor<SortOrder>;
  set(order: SortOrder): void;
}

/** How the sidebar orders notes and folders: a preference of this device, like word wrap. */
export function createSortPreference(storage: PreferenceStorage | null = defaultStorage()): SortPreference {
  const [key = '', direction] = (readPreference(storage, SORT_KEY) ?? '').split(':');
  const saved = SORT_KEYS.find((k) => k === key);
  const [order, setOrder] = createSignal<SortOrder>(saved ? { key: saved, reversed: direction === 'reversed' } : DEFAULT_SORT);
  return {
    order,
    set(next) {
      setOrder(next);
      writePreference(storage, SORT_KEY, next.reversed ? `${next.key}:reversed` : next.key);
    },
  };
}

const RELAY_URL_KEY = 'ankylock.relayUrl';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks a relay address the user typed: `wss://` only, or `ws://` on this machine for a relay
 * in development. The runtime appends the vault id, so the address is a base without query or
 * fragment. Empty input means "no relay".
 */
export type RelayUrlProblem = 'invalid' | 'insecure' | 'extras';

export function parseRelayUrl(input: string): { readonly url: string | null } | { readonly error: RelayUrlProblem } {
  const trimmed = input.trim();
  if (trimmed === '') return { url: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'invalid' };
  }
  const local = url.protocol === 'ws:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'wss:' && !local) return { error: 'insecure' };
  if (url.username || url.password || url.search || url.hash) return { error: 'extras' };
  return { url: url.href.replace(/\/+$/, '') };
}

/**
 * The build's relay: only `VITE_RELAY_URL` when it is set (e.g. a local relay in development,
 * see `.env.example`). Without it, sync runs through Google Drive and nothing tries to reach a
 * relay that is not there.
 */
export function buildRelayUrl(env: { readonly VITE_RELAY_URL?: string }): { relayUrl?: string } {
  const url = env.VITE_RELAY_URL?.trim();
  return url ? { relayUrl: url } : {};
}

/** The user's own relay for instant sync, per device; null syncs through Google Drive only. */
export interface RelayPreference {
  readonly url: Accessor<string | null>;
  set(url: string | null): void;
}

export function createRelayPreference(storage: PreferenceStorage | null = defaultStorage()): RelayPreference {
  const saved = readPreference(storage, RELAY_URL_KEY);
  const parsed = saved === null ? null : parseRelayUrl(saved);
  const [url, setUrl] = createSignal<string | null>(parsed !== null && 'url' in parsed ? parsed.url : null);
  return {
    url,
    set(next) {
      setUrl(next);
      // Empty means none (`parseRelayUrl('')`).
      writePreference(storage, RELAY_URL_KEY, next ?? '');
    },
  };
}
