/** Public files outside the bundle that the offline shell needs. */
export const PUBLIC_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

/**
 * Parses the comma-separated asset list the `precacheManifest` Vite plugin injects into sw.js.
 * An unreplaced placeholder (it starts with `__`; asset paths never do) means no build assets.
 * The placeholder text must appear only in serviceWorker.ts, or the plugin would replace it here too.
 */
export function precacheUrls(injected: string): string[] {
  const assets = injected === '' || injected.startsWith('__') ? [] : injected.split(',').map((path) => `/${path}`);
  return [...PUBLIC_SHELL, ...assets];
}

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
  if (request.method !== 'GET' || url.origin !== origin || url.pathname === '/sw.js') return 'bypass';
  if (request.mode === 'navigate') return 'network-first';
  if (url.pathname.startsWith('/assets/')) return 'cache-first';
  if (url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/')) return 'network-first';
  return 'bypass';
}
