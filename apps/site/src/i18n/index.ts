import { en, type MessageKey, type Messages } from './en.js';
import { tr } from './tr.js';

export type Locale = 'en' | 'tr';
export const LOCALES: readonly Locale[] = ['en', 'tr'];

const MESSAGES: Record<Locale, Messages> = { en, tr };

/** The text for `key`, with `{name}` replaced by `params[name]`. */
export function t(locale: Locale, key: MessageKey, params: Record<string, string> = {}): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/** A release date as the locale writes it, in UTC so the build machine's zone does not matter. */
export const formatDate = (locale: Locale, iso: string): string =>
  new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
