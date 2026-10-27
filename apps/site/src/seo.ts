import { Html } from './html.js';
import { t, type Locale } from './i18n/index.js';
import { linkTo, PAGE_IDS, PAGE_LOCALES, pagePath } from './pages.js';
import { AUTHOR, AUTHOR_URL, REPO_URL, SITE_URL } from './site.js';

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Every indexable page with its language versions, so search engines find them without crawling. */
export function sitemapXml(): string {
  const urls = PAGE_IDS.filter((id) => id !== 'notFound').flatMap((id) =>
    PAGE_LOCALES[id].map((locale) => {
      const alternates =
        PAGE_LOCALES[id].length > 1
          ? PAGE_LOCALES[id].map((l) => `\n    <xhtml:link rel="alternate" hreflang="${l}" href="${escapeXml(SITE_URL + pagePath(id, l))}"/>`).join('')
          : '';
      return `  <url>\n    <loc>${escapeXml(SITE_URL + pagePath(id, locale))}</loc>${alternates}\n  </url>`;
    }),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** Crawlers may read everything; the sitemap lists the pages. Cloudflare prepends its content signals. */
export const robotsTxt = (): string => ['User-agent: *', 'Allow: /', '', `Sitemap: ${SITE_URL}/sitemap.xml`, ''].join('\n');

/**
 * schema.org data for the home page: the site's name, so search results title it AnkyLock, and the
 * app itself. A JSON data block, which the CSP does not treat as script; `<`, `>` and `&` are
 * escaped so no text can close the element.
 */
export function structuredData(locale: Locale): Html {
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: `${SITE_URL}/`, name: 'AnkyLock', inLanguage: ['en', 'tr'] },
      {
        '@type': 'SoftwareApplication',
        name: 'AnkyLock',
        description: t(locale, 'meta.description'),
        url: SITE_URL + pagePath('home', locale),
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web, Linux',
        downloadUrl: SITE_URL + linkTo('download', locale),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: `${REPO_URL}/blob/main/LICENSE`,
        author: { '@type': 'Person', name: AUTHOR, url: AUTHOR_URL },
        sameAs: [REPO_URL],
        isPartOf: { '@id': `${SITE_URL}/#website` },
      },
    ],
  };
  const json = JSON.stringify(data).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return new Html(`<script type="application/ld+json">${json}</script>`);
}
