import type { Locale } from './i18n/index.js';

/** `notFound` is the 404 page Cloudflare serves for unknown paths (`/404.html`), in both languages. */
export type PageId = 'home' | 'download' | 'privacy' | 'terms' | 'notFound';
export const PAGE_IDS: readonly PageId[] = ['home', 'download', 'privacy', 'terms', 'notFound'];

/** Languages each page exists in: privacy and terms stay in English until a legal review. */
export const PAGE_LOCALES: Record<PageId, readonly Locale[]> = {
  home: ['en', 'tr'],
  download: ['en', 'tr'],
  privacy: ['en'],
  terms: ['en'],
  notFound: ['en'],
};

/** The page's URL path: English at the root, Turkish under `/tr/`. */
export const pagePath = (id: PageId, locale: Locale): string =>
  id === 'notFound' ? '/404.html' : `${locale === 'tr' ? '/tr' : ''}/${id === 'home' ? '' : `${id}/`}`;

/** The file a page is written to inside the site. */
export const pageFile = (id: PageId, locale: Locale): string => (id === 'notFound' ? '404.html' : `${pagePath(id, locale).slice(1)}index.html`);

/** The page in `locale`, or its English original when it is not translated yet. */
export const linkTo = (id: PageId, locale: Locale): string => pagePath(id, PAGE_LOCALES[id].includes(locale) ? locale : 'en');
