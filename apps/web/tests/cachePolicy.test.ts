import { describe, expect, it } from 'vitest';
import { cacheStrategy, precacheUrls } from '../src/sw/cachePolicy.js';

const ORIGIN = 'https://app.ankylock.dev';
const req = (path: string, method = 'GET', mode = 'cors') => ({ url: new URL(path, ORIGIN).href, method, mode });

describe('ServiceWorker cache policy', () => {
  it('serves pages network-first so updates arrive, with the cached shell offline', () => {
    expect(cacheStrategy(req('/', 'GET', 'navigate'), ORIGIN)).toBe('network-first');
    expect(cacheStrategy(req('/any/deep/link', 'GET', 'navigate'), ORIGIN)).toBe('network-first');
  });

  it('serves content-hashed assets cache-first', () => {
    expect(cacheStrategy(req('/assets/index-abc123.js'), ORIGIN)).toBe('cache-first');
  });

  it('keeps the manifest and icons fresh but available offline', () => {
    expect(cacheStrategy(req('/manifest.webmanifest'), ORIGIN)).toBe('network-first');
    expect(cacheStrategy(req('/icons/icon-192.png'), ORIGIN)).toBe('network-first');
  });

  it('never touches cross-origin traffic, writes or the worker script itself', () => {
    expect(cacheStrategy({ url: 'https://www.googleapis.com/drive/v3/files', method: 'GET', mode: 'cors' }, ORIGIN)).toBe('bypass');
    expect(cacheStrategy({ url: 'https://relay.ankylock.dev/ws', method: 'GET', mode: 'cors' }, ORIGIN)).toBe('bypass');
    expect(cacheStrategy(req('/assets/x.js', 'POST'), ORIGIN)).toBe('bypass');
    expect(cacheStrategy(req('/sw.js'), ORIGIN)).toBe('bypass');
    expect(cacheStrategy(req('/unknown.json'), ORIGIN)).toBe('bypass');
  });

  it('precaches the public shell plus every injected build asset', () => {
    expect(precacheUrls(['assets/main-1.js', 'assets/entry-2.js'])).toEqual([
      '/',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/assets/main-1.js',
      '/assets/entry-2.js',
    ]);
    expect(precacheUrls([])).toHaveLength(4);
  });
});
