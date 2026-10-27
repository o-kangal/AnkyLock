import { html, type Html } from './html.js';
import { LOCALES, t, type Locale } from './i18n/index.js';
import { logoSvg } from './logo.js';
import { linkTo, PAGE_LOCALES, pagePath, type PageId } from './pages.js';
import { APP_URL, AUTHOR, AUTHOR_URL, COPYRIGHT_YEAR, REPO_URL, SITE_URL } from './site.js';

/** Files Vite bundles, as root-relative URLs. */
export type AssetPath = (file: 'styles' | 'script' | 'icon' | 'screenshot') => string;

export interface PageContext {
  readonly id: PageId;
  readonly locale: Locale;
  readonly asset: AssetPath;
}

export interface PageContent {
  readonly title: string;
  readonly description: string;
  readonly main: Html;
  /** Kept out of search results, with no canonical address (the 404 page). */
  readonly noIndex?: boolean;
  /** A schema.org JSON-LD block for the head (the home page). */
  readonly structuredData?: Html;
}

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };
const THEMES = ['system', 'light', 'dark'] as const;

/** A complete HTML document: no inline script or style, so the CSP can forbid both. */
export function layout(ctx: PageContext, content: PageContent): string {
  const { id, locale } = ctx;
  const locales = PAGE_LOCALES[id];
  const turkish = locale === 'en' && locales.includes('tr') ? pagePath(id, 'tr') : null;
  const alternates =
    locales.length > 1
      ? [
          ...locales.map((l) => html`<link rel="alternate" hreflang="${l}" href="${SITE_URL}${pagePath(id, l)}">`),
          html`<link rel="alternate" hreflang="x-default" href="${SITE_URL}${pagePath(id, 'en')}">`,
        ]
      : [];
  const englishOnly = (page: PageId): Html | '' => (PAGE_LOCALES[page].includes(locale) ? '' : html` <span class="muted">${t(locale, 'footer.englishOnly')}</span>`);

  return html`<!doctype html>
<html lang="${locale}"${turkish ? html` data-tr="${turkish}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${content.title}</title>
<meta name="description" content="${content.description}">
${content.noIndex ? html`<meta name="robots" content="noindex">` : html`<link rel="canonical" href="${SITE_URL}${pagePath(id, locale)}">`}
${alternates}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1e1e1e">
<meta property="og:type" content="website">
<meta property="og:title" content="${content.title}">
<meta property="og:description" content="${content.description}">
${content.noIndex ? '' : html`<meta property="og:url" content="${SITE_URL}${pagePath(id, locale)}">
`}<meta property="og:locale" content="${locale === 'tr' ? 'tr_TR' : 'en_US'}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${ctx.asset('icon')}">
<link rel="stylesheet" href="${ctx.asset('styles')}">
<script src="/init.js"></script>
<script type="module" src="${ctx.asset('script')}"></script>
${content.structuredData ?? ''}
</head>
<body>
<a class="skip" href="#main">${t(locale, 'nav.skip')}</a>
<header class="header">
  <a class="brand" href="${pagePath('home', locale)}" aria-label="${t(locale, 'nav.home')}">${logoSvg('brand-logo')}<span class="wordmark">AnkyLock</span></a>
  <nav class="nav" aria-label="${t(locale, 'nav.main')}">
    <a href="${linkTo('download', locale)}"${id === 'download' ? html` aria-current="page"` : ''}>${t(locale, 'nav.download')}</a>
    <a href="${REPO_URL}">${t(locale, 'nav.github')}</a>
    <a class="button primary" href="${APP_URL}">${t(locale, 'nav.openApp')}</a>
  </nav>
</header>
<main id="main">
${id === 'home' ? '' : html`<p class="back"><a href="${pagePath('home', locale)}"><span aria-hidden="true">←</span> ${t(locale, 'nav.back')}</a></p>`}
${content.main}
</main>
<footer class="footer">
  <p class="footer-links">
    <span><a href="${linkTo('privacy', locale)}">${t(locale, 'footer.privacy')}</a>${englishOnly('privacy')}</span>
    <span><a href="${linkTo('terms', locale)}">${t(locale, 'footer.terms')}</a>${englishOnly('terms')}</span>
    <a href="${REPO_URL}">${t(locale, 'nav.github')}</a>
    <a href="${REPO_URL}/blob/main/LICENSE">${t(locale, 'footer.license')}</a>
  </p>
  <div class="footer-controls">
    <nav class="switch" aria-label="${t(locale, 'footer.language')}">
      ${LOCALES.map((l) =>
        l === locale
          ? html`<span class="switch-option" aria-current="true">${LANGUAGE_NAMES[l]}</span>`
          : html`<a class="switch-option" href="${pagePath(PAGE_LOCALES[id].includes(l) ? id : 'home', l)}" hreflang="${l}" lang="${l}" data-language="${l}">${LANGUAGE_NAMES[l]}</a>`,
      )}
    </nav>
    <div class="switch" role="group" aria-label="${t(locale, 'footer.theme')}" data-theme-switch hidden>
      ${THEMES.map((theme) => html`<button type="button" class="switch-option" data-theme-choice="${theme}" aria-pressed="false">${t(locale, `theme.${theme}`)}</button>`)}
    </div>
  </div>
  <p class="muted">© ${COPYRIGHT_YEAR} <a href="${AUTHOR_URL}">${AUTHOR}</a></p>
</footer>
</body>
</html>
`.value;
}
