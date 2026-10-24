import type { Locale } from './i18n/index.js';

export type PageId = 'home' | 'download' | 'privacy' | 'terms';
export const PAGE_IDS: readonly PageId[] = ['home', 'download', 'privacy', 'terms'];

/** Languages each page exists in: privacy and terms stay in English until a legal review. */
export const PAGE_LOCALES: Record<PageId, readonly Locale[]> = {
  home: ['en', 'tr'],
  download: ['en', 'tr'],
  privacy: ['en'],
  terms: ['en'],
};

/** The page's URL path: English at the root, Turkish under `/tr/`. */
export const pagePath = (id: PageId, locale: Locale): string => `${locale === 'tr' ? '/tr' : ''}/${id === 'home' ? '' : `${id}/`}`;

/** The page in `locale`, or its English original when it is not translated yet. */
export const linkTo = (id: PageId, locale: Locale): string => pagePath(id, PAGE_LOCALES[id].includes(locale) ? locale : 'en');
