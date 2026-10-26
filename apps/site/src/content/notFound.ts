import { html } from '../html.js';
import { LOCALES, t } from '../i18n/index.js';
import { layout, type PageContext } from '../layout.js';
import { pagePath } from '../pages.js';

/** The 404 page: one address for every language, so it says everything in both. */
export function notFoundPage(ctx: PageContext): string {
  return layout(ctx, {
    title: `${t('en', 'notFound.title')} · AnkyLock`,
    description: t('en', 'notFound.text'),
    noIndex: true,
    main: html`
<section class="section narrow">
  ${LOCALES.map(
    (locale) => html`<div lang="${locale}">
  <h1>${t(locale, 'notFound.title')}</h1>
  <p class="lead">${t(locale, 'notFound.text')}</p>
  <p><a class="button primary" href="${pagePath('home', locale)}">${t(locale, 'notFound.home')}</a></p>
</div>`,
  )}
</section>`,
  });
}
