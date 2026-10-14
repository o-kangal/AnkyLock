import { cacheStrategy, precacheUrls } from './sw/cachePolicy.js';

declare const self: ServiceWorkerGlobalScope;

// Both strings are replaced at build time; a new build gets a new cache and drops the old one.
const CACHE_VERSION = `ankylock-shell-${'__ANKYLOCK_BUILD_ID__'}`;
/** Everything needed to boot offline, fetched at install so the app works after one visit. */
const SHELL = precacheUrls('__ANKYLOCK_PRECACHE__');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
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
