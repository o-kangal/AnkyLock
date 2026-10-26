// Where Playwright serves the production builds (playwright.config.ts starts both servers).
export const APP_PORT = 4173;
export const SITE_PORT = 4174;
export const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;
export const SITE_ORIGIN = `http://localhost:${String(SITE_PORT)}`;

/** The `_headers` files the builds write for Cloudflare Pages. */
export const APP_HEADERS = new URL('../../apps/web/dist/_headers', import.meta.url).pathname;
export const SITE_HEADERS = new URL('../../apps/site/dist/_headers', import.meta.url).pathname;
