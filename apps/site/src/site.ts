/** Addresses the site links to. */
export const SITE_URL = 'https://ankylock.com';
export const APP_URL = 'https://app.ankylock.com';
export const REPO = 'o-kangal/AnkyLock';
export const REPO_URL = `https://github.com/${REPO}`;
export const CONTACT_EMAIL = 'privacy@ankylock.com';
export const AUTHOR = 'Onur Kangal';
export const AUTHOR_URL = 'https://okangal.com';
export const COPYRIGHT_YEAR = '2026';

/** Device-only preferences (localStorage); public/init.js reads the same keys before paint. */
export const THEME_KEY = 'ankylock.site.theme';
export const LANGUAGE_KEY = 'ankylock.site.language';

export const docUrl = (path: string): string => `${REPO_URL}/blob/main/${path}`;
