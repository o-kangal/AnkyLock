import { html } from '../html.js';
import { layout, type PageContext } from '../layout.js';
import { linkTo } from '../pages.js';
import { CONTACT_EMAIL, REPO_URL } from '../site.js';

/** Shown on the page and kept in step with every change to its text. */
export const TERMS_UPDATED = 'October 24, 2026';

export function termsPage(ctx: PageContext): string {
  return layout(ctx, {
    title: 'Terms of Use · AnkyLock',
    description: 'The terms for using AnkyLock, its web app and this website.',
    main: html`
<article class="section narrow legal">
  <h1>Terms of Use</h1>
  <p class="muted">Last updated: ${TERMS_UPDATED}</p>

  <p>These terms apply to the AnkyLock desktop app, the web app and this website (together, “AnkyLock”), made by Onur Kangal. By using AnkyLock you accept them. If you do not, please do not use it.</p>

  <h2>Free and open source</h2>
  <p>AnkyLock is free of charge. Its source code is published under the <a href="${REPO_URL}/blob/main/LICENSE">GNU Affero General Public License, version 3 or later</a>, which gives you the right to use, study, change and share it. Where the license grants you more rights than these terms, the license applies.</p>

  <h2>Your passphrase is your responsibility</h2>
  <p>Your notes are encrypted with a key that only your vault passphrase can produce. Nobody, including the maker of AnkyLock, can reset the passphrase or recover your notes without it. Keep your passphrase safe, and keep copies of notes you cannot afford to lose (AnkyLock can export them at any time).</p>

  <h2>Google services</h2>
  <p>Backup and sync use your own Google account and Google Drive, under Google’s terms. AnkyLock’s files there count toward your Drive storage. How AnkyLock uses your Google data is described in the <a href="${linkTo('privacy', 'en')}">Privacy Policy</a>.</p>

  <h2>Acceptable use</h2>
  <p>Do not use AnkyLock to break the law or to harm others, and do not attack, overload or try to break into the services AnkyLock relies on, including this website and the web app.</p>

  <h2>No warranty</h2>
  <p>AnkyLock is provided “as is”, without warranty of any kind, express or implied, including fitness for a particular purpose and uninterrupted or error-free operation. Software can have bugs, and data can be lost through device failure, mistakes or a forgotten passphrase.</p>

  <h2>Limitation of liability</h2>
  <p>To the extent the law allows, the maker of AnkyLock is not liable for any loss of data, profits or other damages arising from using or being unable to use AnkyLock. Nothing in these terms limits liability that cannot be limited by law.</p>

  <h2>Changes</h2>
  <p>AnkyLock and these terms may change. The current version is always published here with its date, and the history of every change is visible in the <a href="${REPO_URL}">public source code</a>. Using AnkyLock after a change means you accept the new terms.</p>

  <h2>Contact</h2>
  <p>Write to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</article>`,
  });
}
