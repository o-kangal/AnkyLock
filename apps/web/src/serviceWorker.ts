import { SKIP_WAITING, cacheStrategy, precacheUrls } from './sw/cachePolicy.js';

declare const self: ServiceWorkerGlobalScope;

/** Compiled in by the `serviceWorker` Vite plugin. */
declare const __ANKYLOCK_PRECACHE__: string[];
declare const __ANKYLOCK_BUILD_ID__: string;

// A new build gets a new cache name, and activation drops the old one.
const CACHE_VERSION = `ankylock-shell-${__ANKYLOCK_BUILD_ID__}`;
/** Everything needed to boot offline, fetched at install so the app works after one visit. */
const SHELL = precacheUrls(__ANKYLOCK_PRECACHE__);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL)),
  );
});

// A new version waits until the user chooses to reload (UpdateBanner), so an open tab never
// runs old code against a new cache.
self.addEventListener('message', (event) => {
  // Only the app's own pages may ask; browsers deliver nothing else here, this makes it explicit.
  if (event.origin === self.location.origin && event.data === SKIP_WAITING) void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request.mode === 'navigate' ? '/' : request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request.mode === 'navigate' ? '/' : request);
    if (cached) return cached;
    throw new Error('Offline and not cached.');
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const strategy = cacheStrategy(event.request, self.location.origin);
  if (strategy === 'network-first') event.respondWith(networkFirst(event.request));
  else if (strategy === 'cache-first') event.respondWith(cacheFirst(event.request));
});
