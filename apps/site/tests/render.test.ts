import { describe, expect, it } from 'vitest';
import { SITE_CSP } from '../src/headers.js';
import { renderSite } from '../src/render.js';
import { APP_URL, CONTACT_EMAIL, REPO_URL, SITE_URL } from '../src/site.js';
import { RELEASE, renderedPages, SOURCES } from './helpers.js';

const pages = renderedPages();
const page = (file: string): Document => {
  const doc = pages.get(file);
  if (!doc) throw new Error(`no page ${file}`);
  return doc;
};

/** Hosts a page may link to; it loads nothing from any of them. */
const LINK_HOSTS = new Set([
  new URL(SITE_URL).host,
  new URL(APP_URL).host,
  'github.com',
  'developers.google.com',
  'policies.google.com',
  'myaccount.google.com',
  'www.cloudflare.com',
  'docs.github.com',
  'okangal.com',
]);

describe('site pages', () => {
  it('renders home and download in both languages, privacy and terms in English', () => {
    expect([...pages.keys()].sort()).toEqual([
      '404.html',
      'download/index.html',
      'index.html',
      'privacy/index.html',
      'terms/index.html',
      'tr/download/index.html',
      'tr/index.html',
    ]);
    expect(page('index.html').documentElement.lang).toBe('en');
    expect(page('tr/index.html').documentElement.lang).toBe('tr');
    expect(page('tr/index.html').querySelector('h1')?.textContent).toBe('Yalnızca sizin okuyabildiğiniz notlar.');
  });

  it('has no inline script, inline style or event handler, so the CSP can forbid them all', () => {
    for (const [file, doc] of pages) {
      // JSON-LD is a data block: browsers never run it, so the CSP does not apply.
      for (const script of Array.from(doc.querySelectorAll('script:not([type="application/ld+json"])'))) {
        expect(script.getAttribute('src'), file).toBeTruthy();
        expect(script.textContent, file).toBe('');
      }
      expect(doc.querySelectorAll('style, [style]'), file).toHaveLength(0);
      const handlers = Array.from(doc.querySelectorAll('*')).flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith('on')));
      expect(handlers, file).toEqual([]);
    }
  });

  it('loads only its own files and links only to known sites', () => {
    for (const [file, doc] of pages) {
      for (const el of Array.from(doc.querySelectorAll('[src], link[href]'))) {
        const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
        if (el.matches('link[rel="canonical"], link[rel="alternate"]')) continue;
        expect(url, `${file}: ${url}`).not.toMatch(/^(https?:)?\/\//);
      }
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('/') || href.startsWith('#')) continue;
        if (href.startsWith('mailto:')) {
          expect(href).toBe(`mailto:${CONTACT_EMAIL}`);
          continue;
        }
        expect(LINK_HOSTS.has(new URL(href).host), `${file}: ${href}`).toBe(true);
      }
    }
  });

  it('links each language version to the other for search engines, and marks the Turkish one for init.js', () => {
    const alternates = (doc: Document): string[] =>
      Array.from(doc.querySelectorAll('link[rel="alternate"]')).map((l) => `${l.getAttribute('hreflang') ?? ''} ${l.getAttribute('href') ?? ''}`);
    expect(alternates(page('download/index.html'))).toEqual([
      `en ${SITE_URL}/download/`,
      `tr ${SITE_URL}/tr/download/`,
      `x-default ${SITE_URL}/download/`,
    ]);
    expect(page('index.html').documentElement.dataset['tr']).toBe('/tr/');
    expect(page('tr/index.html').documentElement.dataset['tr']).toBeUndefined();
    // Privacy has no Turkish version yet: nothing to send a Turkish browser to.
    expect(page('privacy/index.html').documentElement.dataset['tr']).toBeUndefined();
    expect(alternates(page('privacy/index.html'))).toEqual([]);
  });

  it('links Turkish visitors to the English legal pages, marked as English', () => {
    const footer = page('tr/index.html').querySelector('footer');
    expect(footer?.querySelector('a[href="/privacy/"]')?.textContent).toBe('Gizlilik');
    expect(footer?.textContent).toContain('(İngilizce)');
    // The language switch on an English-only page leads to the Turkish home page.
    expect(page('privacy/index.html').querySelector('a[data-language="tr"]')?.getAttribute('href')).toBe('/tr/');
  });

  it('points every page at the same bundled sources', () => {
    expect(page('index.html').querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe(SOURCES.styles);
    expect(page('tr/download/index.html').querySelector('script[type="module"]')?.getAttribute('src')).toBe(SOURCES.script);
  });

  it('leads back home from every other page, in its language', () => {
    expect(page('index.html').querySelector('.back')).toBeNull();
    expect(page('privacy/index.html').querySelector('.back a')?.getAttribute('href')).toBe('/');
    expect(page('tr/download/index.html').querySelector('.back a')?.getAttribute('href')).toBe('/tr/');
    expect(page('tr/download/index.html').querySelector('.back a')?.textContent).toContain('Ana sayfa');
  });

  it('credits the author with a link to their site', () => {
    expect(page('index.html').querySelector('footer a[href="https://okangal.com"]')?.textContent).toBe('Onur Kangal');
  });

  it('keeps the theme switch hidden until the script can work it', () => {
    expect(page('index.html').querySelector('[data-theme-switch]')?.hasAttribute('hidden')).toBe(true);
  });

  it('answers unknown addresses with a 404 page in both languages, kept out of search results', () => {
    const doc = page('404.html');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(doc.querySelector('link[rel="canonical"], meta[property="og:url"]')).toBeNull();
    expect(Array.from(doc.querySelectorAll('main h1')).map((h) => h.textContent)).toEqual(['Page not found', 'Sayfa bulunamadı']);
    expect(doc.querySelector('main [lang="tr"] a')?.getAttribute('href')).toBe('/tr/');
    // A Turkish browser is not sent away from the 404 page.
    expect(doc.documentElement.dataset['tr']).toBeUndefined();
  });

  it('serves every page with a strict CSP and the security headers', () => {
    const headers = renderSite(null, SOURCES).find((f) => f.file === '_headers')?.content ?? '';
    const all = headers.split('\n\n')[0] ?? '';
    expect(all.split('\n')[0]).toBe('/*');
    expect(all).toContain(`Content-Security-Policy: ${SITE_CSP}`);
    for (const name of [
      'Strict-Transport-Security',
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      'Permissions-Policy',
      'Cross-Origin-Opener-Policy: same-origin',
      'Cross-Origin-Resource-Policy: same-origin',
      '! Access-Control-Allow-Origin',
    ]) {
      expect(all).toContain(name);
    }
    expect(SITE_CSP).toContain("default-src 'none'");
    expect(SITE_CSP).toContain("frame-ancestors 'none'");
    expect(SITE_CSP).not.toContain('unsafe');
    expect(headers).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
  });

  it('describes the app to search engines on the home pages only, as JSON that cannot close its element', () => {
    for (const [file, doc] of pages) {
      const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
      expect(blocks, file).toHaveLength(file === 'index.html' || file === 'tr/index.html' ? 1 : 0);
      for (const block of blocks) {
        expect(block.parentElement?.tagName, file).toBe('HEAD');
        expect(block.textContent, file).not.toMatch(/[<>&]/);
      }
    }
    const data: unknown = JSON.parse(page('tr/index.html').querySelector('script[type="application/ld+json"]')?.textContent ?? '');
    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', url: `${SITE_URL}/`, name: 'AnkyLock' },
        { '@type': 'SoftwareApplication', name: 'AnkyLock', url: `${SITE_URL}/tr/`, downloadUrl: `${SITE_URL}/tr/download/`, offers: { price: '0' } },
      ],
    });
  });

  it('lists every indexable page in the sitemap, with its language versions, and points robots.txt at it', () => {
    const files = renderSite(null, SOURCES);
    const xml = new DOMParser().parseFromString(files.find((f) => f.file === 'sitemap.xml')?.content ?? '', 'application/xml');
    expect(xml.querySelector('parsererror')).toBeNull();
    const urls = Array.from(xml.getElementsByTagName('url'));
    expect(urls.map((u) => u.getElementsByTagName('loc')[0]?.textContent)).toEqual(
      ['/', '/tr/', '/download/', '/tr/download/', '/privacy/', '/terms/'].map((path) => SITE_URL + path),
    );
    const alternates = (i: number): string[] => Array.from(urls[i]?.getElementsByTagName('xhtml:link') ?? []).map((l) => `${l.getAttribute('hreflang') ?? ''} ${l.getAttribute('href') ?? ''}`);
    expect(alternates(3)).toEqual([`en ${SITE_URL}/download/`, `tr ${SITE_URL}/tr/download/`]);
    expect(alternates(4)).toEqual([]);
    expect(files.find((f) => f.file === 'robots.txt')?.content).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  });

  it('writes a favicon that parses as SVG', () => {
    const favicon = renderSite(null, SOURCES).find((f) => f.file === 'favicon.svg')?.content ?? '';
    const doc = new DOMParser().parseFromString(favicon, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('viewBox')).toBe('-6 0 252 210');
  });
});

describe('download page', () => {
  it('without a release, says one is coming and offers the web app and the source', () => {
    const main = page('download/index.html').querySelector('main');
    expect(main?.querySelector('.notice')?.textContent).toContain('first release is on its way');
    expect(main?.querySelector(`a[href="${APP_URL}"]`)).not.toBeNull();
    expect(main?.querySelector(`a[href="${REPO_URL}#build-from-source"]`)).not.toBeNull();
  });

  it('lists each package with its link, checksum and install steps', () => {
    const doc = renderedPages(RELEASE).get('download/index.html');
    const cards = Array.from(doc?.querySelectorAll('.package') ?? []);
    expect(cards.map((c) => c.querySelector('h3')?.textContent)).toEqual(['AppImage', '.deb']);
    const [appImage, deb] = RELEASE.packages;
    expect(cards[0]?.querySelector('a[download]')?.getAttribute('href')).toBe(appImage?.url);
    // A short button, named for screen readers, and the file name beside it.
    expect(cards[0]?.querySelector('a[download]')?.textContent).toBe('Download');
    expect(cards[0]?.querySelector('a[download]')?.getAttribute('aria-label')).toBe(`Download ${appImage?.name ?? ''}`);
    expect(cards[0]?.querySelector('.file code')?.textContent).toBe(appImage?.name);
    expect(cards[0]?.querySelector('.checksum code')?.textContent).toBe('a'.repeat(64));
    expect(cards[0]?.querySelector('pre')?.textContent).toBe(`chmod +x ${appImage?.name ?? ''}\n./${appImage?.name ?? ''}`);
    // Not in SHA256SUMS: no checksum shown rather than a wrong one.
    expect(cards[1]?.querySelector('.checksum')).toBeNull();
    expect(cards[1]?.querySelector('pre')?.textContent).toBe(`sudo apt install ./${deb?.name ?? ''}`);
    expect(doc?.querySelector('main')?.textContent).toContain('Version 1.2.0, released on November 3, 2026.');
    expect(renderedPages(RELEASE).get('tr/download/index.html')?.querySelector('main')?.textContent).toContain('Sürüm 1.2.0, 3 Kasım 2026 tarihinde yayımlandı.');
  });
});
