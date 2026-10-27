import { html, type Html } from '../html.js';
import type { MessageKey } from '../i18n/en.js';
import { formatDate, t } from '../i18n/index.js';
import { layout, type PageContext } from '../layout.js';
import type { PackageKind, Release, ReleasePackage } from '../release.js';
import { APP_URL, REPO, REPO_URL } from '../site.js';

const KIND_NAMES: Record<PackageKind, string> = { appimage: 'AppImage', deb: '.deb', rpm: '.rpm' };

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** The install commands for one package, in a copyable block. */
function installCommands(pkg: ReleasePackage): string {
  switch (pkg.kind) {
    case 'appimage':
      return `chmod +x ${pkg.name}\n./${pkg.name}`;
    case 'deb':
      return `sudo apt install ./${pkg.name}`;
    case 'rpm':
      return `sudo dnf install ./${pkg.name}`;
  }
}

function packageCard(ctx: PageContext, pkg: ReleasePackage): Html {
  const say = (key: MessageKey, params?: Record<string, string>): string => t(ctx.locale, key, params);
  return html`<li class="card package">
  <h3>${KIND_NAMES[pkg.kind]}</h3>
  <p>${say(`download.${pkg.kind}.text`)}</p>
  <p class="file">
    <a class="button primary" href="${pkg.url}" download aria-label="${say('download.file', { file: pkg.name })}">${say('download.button')}</a>
    <span><code>${pkg.name}</code> <span class="muted">· ${megabytes(pkg.size)}</span></span>
  </p>
  ${pkg.sha256 ? html`<p class="checksum"><span class="muted">${say('download.checksum')}</span> <code>${pkg.sha256}</code></p>` : ''}
  <h4>${say('download.install')}</h4>
  <p>${say(`download.install.${pkg.kind}`)}</p>
  <pre><code>${installCommands(pkg)}</code></pre>
</li>`;
}

export function downloadPage(ctx: PageContext, release: Release | null): string {
  const say = (key: MessageKey, params?: Record<string, string>): string => t(ctx.locale, key, params);
  const example = release?.packages[0]?.name ?? 'AnkyLock.AppImage';
  const body = release
    ? html`
  <p>${say('download.version', { version: release.version, date: formatDate(ctx.locale, release.publishedAt) })} <a href="${release.url}">GitHub</a></p>
  <ul class="packages">${release.packages.map((pkg) => packageCard(ctx, pkg))}</ul>
  <h2>${say('download.verify.title')}</h2>
  <p>${say('download.verify.text')}</p>
  <pre><code>sha256sum ${example}\ngh attestation verify ${example} --repo ${REPO}</code></pre>`
    : html`
  <p class="notice">${say('download.none')}</p>
  <p class="actions">
    <a class="button primary" href="${APP_URL}">${say('nav.openApp')}</a>
    <a class="button" href="${REPO_URL}#build-from-source">${say('download.buildFromSource')}</a>
  </p>`;
  return layout(ctx, {
    title: say('meta.downloadTitle'),
    description: say('meta.downloadDescription'),
    main: html`
<section class="section narrow">
  <h1>${say('download.title')}</h1>
  <p class="lead">${say('download.lead')}</p>
  ${body}
  <h2>${say('download.other.title')}</h2>
  <p>${say('download.other.text')} <a href="${REPO_URL}#build-from-source">${say('download.buildFromSource')}</a></p>
</section>`,
  });
}
