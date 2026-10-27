import { html } from '../html.js';
import type { MessageKey } from '../i18n/en.js';
import { t } from '../i18n/index.js';
import { layout, type PageContext } from '../layout.js';
import { logoSvg } from '../logo.js';
import { linkTo } from '../pages.js';
import { structuredData } from '../seo.js';
import { APP_URL, docUrl, REPO_URL } from '../site.js';

const FEATURES = ['scratchpad', 'organize', 'sync', 'offline', 'vaults', 'export', 'editor'] as const;
const STEPS = ['passphrase', 'key', 'encrypt', 'drive'] as const;
const PROMISES = ['nobody', 'key', 'tracking', 'open'] as const;
const LIMITS = ['recovery', 'device', 'metadata'] as const;

export function homePage(ctx: PageContext): string {
  const { locale } = ctx;
  const say = (key: MessageKey): string => t(locale, key);
  return layout(ctx, {
    title: `AnkyLock · ${say('hero.title')}`,
    description: say('meta.description'),
    structuredData: structuredData(locale),
    main: html`
<section class="hero">
  <button type="button" class="hero-logo" aria-label="${say('logo.toggle')}" data-logo>${logoSvg('logo')}</button>
  <h1>${say('hero.title')}</h1>
  <p class="lead">${say('hero.lead')}</p>
  <p class="actions">
    <a class="button primary" href="${APP_URL}">${say('nav.openApp')}</a>
    <a class="button" href="${linkTo('download', locale)}">${say('hero.download')}</a>
    <a class="button" href="${REPO_URL}">${say('hero.github')}</a>
  </p>
  <p class="muted">${say('hero.note')}</p>
</section>

<section class="section" aria-labelledby="features">
  <h2 id="features">${say('features.title')}</h2>
  <ul class="cards">
    ${FEATURES.map((f) => html`<li class="card"><h3>${say(`features.${f}.title`)}</h3><p>${say(`features.${f}.text`)}</p></li>`)}
  </ul>
  <img class="screenshot" src="${ctx.asset('screenshot')}" width="1600" height="1067" loading="lazy" decoding="async" alt="${say('features.screenshot')}">
</section>

<section class="section" aria-labelledby="how">
  <h2 id="how">${say('how.title')}</h2>
  <p class="lead">${say('how.lead')}</p>
  <ol class="steps">
    ${STEPS.map((s) => html`<li class="step"><h3>${say(`how.${s}.title`)}</h3><p>${say(`how.${s}.text`)}</p></li>`)}
  </ol>
</section>

<section class="section columns">
  <div>
    <h2>${say('promise.title')}</h2>
    <ul class="checks">${PROMISES.map((p) => html`<li>${say(`promise.${p}`)}</li>`)}</ul>
  </div>
  <div>
    <h2>${say('limits.title')}</h2>
    <ul class="limits">${LIMITS.map((l) => html`<li>${say(`limits.${l}`)}</li>`)}</ul>
    <p><a href="${docUrl('docs/security/threat-model.md')}">${say('limits.more')}</a></p>
  </div>
</section>

<section class="section" aria-labelledby="open">
  <h2 id="open">${say('open.title')}</h2>
  <p>${say('open.text')}</p>
  <p class="actions">
    <a class="button" href="${REPO_URL}">${say('open.source')}</a>
    <a class="button" href="${docUrl('docs/security/threat-model.md')}">${say('open.threatModel')}</a>
    <a class="button" href="${docUrl('docs/security/review-2026.md')}">${say('open.review')}</a>
    <a class="button" href="${docUrl('SECURITY.md')}">${say('open.report')}</a>
  </p>
</section>`,
  });
}
