import { downloadPage } from './content/download.js';
import { homePage } from './content/home.js';
import { privacyPage } from './content/privacy.js';
import { termsPage } from './content/terms.js';
import type { AssetPath, PageContext } from './layout.js';
import { siteHeaders } from './headers.js';
import { faviconSvg } from './logo.js';
import { notFoundPage } from './content/notFound.js';
import { PAGE_IDS, PAGE_LOCALES, pageFile, type PageId } from './pages.js';
import type { Release } from './release.js';

export interface SiteFile {
  /** Path inside the site, without a leading slash, e.g. `tr/download/index.html`. */
  readonly file: string;
  readonly content: string;
}

/** The bundled sources, as root-relative URLs of the folder the pages are written to. */
export interface AssetSources {
  readonly styles: string;
  readonly script: string;
  readonly icon: string;
  readonly screenshot: string;
}

/** Every page in every language it exists in, plus the favicon and Cloudflare's `_headers`. */
export function renderSite(release: Release | null, sources: AssetSources): SiteFile[] {
  const pages = PAGE_IDS.flatMap((id) =>
    PAGE_LOCALES[id].map((locale) => {
      const asset: AssetPath = (name) => sources[name];
      const ctx: PageContext = { id, locale, asset };
      return { file: pageFile(id, locale), content: renderPage(id, ctx, release) };
    }),
  );
  return [...pages, { file: 'favicon.svg', content: faviconSvg() }, { file: '_headers', content: siteHeaders() }];
}

function renderPage(id: PageId, ctx: PageContext, release: Release | null): string {
  switch (id) {
    case 'home':
      return homePage(ctx);
    case 'download':
      return downloadPage(ctx, release);
    case 'privacy':
      return privacyPage(ctx);
    case 'terms':
      return termsPage(ctx);
    case 'notFound':
      return notFoundPage(ctx);
  }
}
