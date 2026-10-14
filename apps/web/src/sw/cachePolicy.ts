/** Message from the page telling a waiting ServiceWorker to take over. */
export const SKIP_WAITING = 'ankylock:skip-waiting';

/** Public files outside the bundle that the offline shell needs. */
export const PUBLIC_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

/** Public shell plus every hashed build asset compiled into sw.js (none in tests). */
export function precacheUrls(buildAssets: readonly string[]): string[] {
  return [...PUBLIC_SHELL, ...buildAssets.map((path) => `/${path}`)];
}

/**
 * The ServiceWorker itself, and the Google sign-in landing page: it carries tokens in its URL
 * fragment and must never be cached, least of all in place of the app shell.
 */
const BYPASS_PATHS = new Set(['/sw.js', '/oauth-callback.html', '/oauth-callback.js']);

export type CacheStrategy =
  /** Pages: try the network for the newest app, fall back to the cached shell when offline. */
  | 'network-first'
  /** Content-hashed build assets never change under the same URL. */
  | 'cache-first'
  /** Not ours to touch: cross-origin (Google, relay), non-GET, or the ServiceWorker itself. */
  | 'bypass';

export interface RequestInfo {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
}

/**
 * Decides how the ServiceWorker treats a request. It only ever caches the app's own static shell,
 * which contains no user data: notes live encrypted in IndexedDB, never in the HTTP cache.
 */
export function cacheStrategy(request: RequestInfo, origin: string): CacheStrategy {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin || BYPASS_PATHS.has(url.pathname)) return 'bypass';
  if (request.mode === 'navigate') return 'network-first';
  if (url.pathname.startsWith('/assets/')) return 'cache-first';
  if (url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/')) return 'network-first';
  return 'bypass';
}
