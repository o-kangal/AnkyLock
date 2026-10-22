import { createSignal, type Accessor } from 'solid-js';
import type { EpochMs } from '@ankylock/core';
import { defaultStorage, readPreference, writePreference, type PreferenceStorage } from '../preferences/devicePreferences.js';
import { en, type MessageKey } from './en.js';
import { tr, type Messages } from './tr.js';

export type { MessageKey } from './en.js';

export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];
/** What the user picked: System follows the browser or OS language. */
export type LocaleChoice = 'system' | Locale;
export const LOCALE_CHOICES: readonly LocaleChoice[] = ['system', 'en', 'tr'];

const LOCALE_KEY = 'ankylock.locale';
const DICTIONARIES: Record<Locale, Messages> = { en, tr };
/** BCP 47 tags for `Intl`: times, sorting, plural rules and case changes. */
const TAGS: Record<Locale, string> = { en: 'en-US', tr: 'tr-TR' };

/** Turkish for any `tr` language tag, otherwise English. */
export function systemLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): Locale {
  return languages[0]?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

const parseChoice = (value: string | null): LocaleChoice => (value === 'en' || value === 'tr' ? value : 'system');

let storage: PreferenceStorage | null = defaultStorage();
const [choice, setChoice] = createSignal<LocaleChoice>(parseChoice(readPreference(storage, LOCALE_KEY)));
const [system] = createSignal<Locale>(systemLocale());

/** The language shown now. Reactive: text built from `t()` follows a change. */
export const locale: Accessor<Locale> = () => {
  const picked = choice();
  return picked === 'system' ? system() : picked;
};
export const localeChoice: Accessor<LocaleChoice> = choice;

/** Sets the language on this device for every vault: a preference, neither synced nor encrypted. */
export function chooseLocale(next: LocaleChoice): void {
  setChoice(next);
  writePreference(storage, LOCALE_KEY, next);
}

/** Test seam: a fresh preference read from `store`. */
export function resetLocaleForTests(store: PreferenceStorage | null): void {
  storage = store;
  setChoice(parseChoice(readPreference(store, LOCALE_KEY)));
}

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * The text for `key` in the current language, with `{name}` placeholders filled in. Values are
 * plain text: components render them as text nodes, never as HTML.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = DICTIONARIES[locale()][key];
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Keys with `.one` and `.other` forms, chosen by the language's plural rules for `count`. */
type PluralBase = MessageKey extends infer K ? (K extends `${infer B}.one` ? B : never) : never;

export function tn(base: PluralBase, count: number, params?: MessageParams): string {
  const form = new Intl.PluralRules(TAGS[locale()]).select(count) === 'one' ? 'one' : 'other';
  return t(`${base}.${form}` as MessageKey, { count, ...params });
}

/** Hours and minutes: "06:05 PM" in English, "18:05" in Turkish. */
export const formatTime = (at: EpochMs | number): string =>
  new Date(at).toLocaleTimeString(TAGS[locale()], { hour: '2-digit', minute: '2-digit' });

/** Date and time, e.g. for telling vaults apart before they are unlocked. */
export const formatDateTime = (at: EpochMs | number): string =>
  new Date(at).toLocaleString(TAGS[locale()], { dateStyle: 'medium', timeStyle: 'short' });

/** Orders names as the language does (Ç after C, Ş after S, ı before i in Turkish). */
export const compareNames = (a: string, b: string): number => a.localeCompare(b, TAGS[locale()], { sensitivity: 'base', numeric: true });

/** Error codes from the packages, whose messages stay English (AGENTS.md), and their UI text. */
const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  ERR_CIRCULAR_HIERARCHY: 'error.circularHierarchy',
  ERR_MAX_DEPTH_EXCEEDED: 'error.maxDepth',
  ERR_SYSTEM_CATEGORY_IMMUTABLE: 'error.systemCategory',
  ERR_READ_ONLY_TRASHED_ENTITY: 'error.readOnlyTrashed',
  ERR_INVALID_TRANSITION: 'error.invalidTransition',
  ERR_CATEGORY_NAME_INVALID: 'error.categoryNameInvalid',
  ERR_CATEGORY_NAME_DUPLICATE: 'error.categoryNameDuplicate',
  ERR_NOTE_TOO_LARGE: 'error.noteTooLarge',
  ERR_INVALID_SETTING: 'error.invalidSetting',
  ERR_NOT_FOUND: 'error.notFound',
  ERR_STORAGE: 'error.storage',
  ERR_AUTH: 'error.auth',
  ERR_AUTH_EXPIRED: 'error.authExpired',
  ERR_NETWORK: 'error.network',
  ERR_VAULT_LOCKED: 'error.vaultLocked',
  ERR_WRONG_PASSPHRASE: 'error.wrongPassphrase',
  ERR_EMPTY_PASSPHRASE: 'error.emptyPassphrase',
  ERR_DECRYPT_FAILED: 'error.decryptFailed',
  ERR_MALFORMED_PAYLOAD: 'error.malformed',
  ERR_WEAK_KDF_PARAMS: 'error.weakKdf',
  ERR_WORKER_FAILURE: 'error.worker',
};

/**
 * An error from the packages, for the user: English shows the package's own (more specific)
 * message; other languages show the text for its code, with the English detail for storage
 * errors, and the message itself for unknown codes.
 */
export function errorText(error: { readonly code?: string; readonly message: string }): string {
  if (locale() === 'en') return error.message;
  const key = error.code === undefined ? undefined : ERROR_KEYS[error.code];
  return key === undefined ? error.message : t(key, { detail: error.message });
}
