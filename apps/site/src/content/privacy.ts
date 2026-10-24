import { html } from '../html.js';
import { layout, type PageContext } from '../layout.js';
import { APP_URL, CONTACT_EMAIL, docUrl, REPO_URL } from '../site.js';

/** Shown on the page and kept in step with every change to its text. */
export const PRIVACY_UPDATED = 'October 24, 2026';

const mail = html`<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;

export function privacyPage(ctx: PageContext): string {
  return layout(ctx, {
    title: 'Privacy Policy · AnkyLock',
    description: 'How AnkyLock handles your data: notes are encrypted on your device, and AnkyLock never receives them or your Google data.',
    main: html`
<article class="section narrow legal">
  <h1>Privacy Policy</h1>
  <p class="muted">Last updated: ${PRIVACY_UPDATED}</p>

  <p>AnkyLock is a notes app that encrypts your notes on your own device. This policy explains what data the AnkyLock apps (the desktop app and the web app at <a href="${APP_URL}">${APP_URL.replace('https://', '')}</a>) and this website handle, and why. In short: <strong>AnkyLock has no servers that receive your notes or your Google data, and nobody but you can read your notes.</strong></p>
  <p>AnkyLock is made by Onur Kangal, an individual developer. Questions about this policy go to ${mail}.</p>

  <h2>Your notes</h2>
  <p>Notes, their titles, folder and category names, and vault names are encrypted on your device with AES-256-GCM, using a key derived from your vault passphrase. The passphrase and the key never leave your device and are never stored. Encrypted data is kept on your device (in the desktop app’s database, or in your browser’s storage for the web app) and, if you sign in with Google, in your Google Drive as described below. AnkyLock cannot read your notes, and cannot recover them if you forget your passphrase.</p>

  <h2>Google data</h2>
  <p>Signing in with Google is optional. Without it, AnkyLock works on one device only. If you sign in, AnkyLock asks Google for these permissions and uses them only as described:</p>
  <ul>
    <li><strong>Your identity (<code>openid</code>, <code>email</code>):</strong> to know which Google account the backups belong to. The web app keeps your email address in your browser as a sign-in hint until you sign out; it is not sent anywhere else.</li>
    <li><strong>The app’s own folder in your Google Drive (<code>drive.appdata</code>):</strong> to store your vaults’ encrypted backups in a hidden folder that only AnkyLock can see. AnkyLock cannot see, read or change any other file in your Drive.</li>
  </ul>
  <p>Your Google sign-in tokens stay on your device: in memory in the web app, and in your operating system’s keychain in the desktop app. They are sent only to Google. The data AnkyLock reads from Google is used only to provide the app’s backup and sync features to you; it is never sold, never used for advertising, never transferred to anyone else, and never read by a person. Your vault key is never derived from your Google account.</p>
  <p>AnkyLock’s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
  <p>Google sees the encrypted files in your Drive: their names (made of random identifiers), sizes and when they change, but not their contents. Google’s handling of your account is covered by <a href="https://policies.google.com/privacy">Google’s Privacy Policy</a>.</p>

  <h2>Instant sync with your own relay</h2>
  <p>The desktop app can optionally connect to a relay server that <em>you</em> run, to pass encrypted changes between your devices instantly. AnkyLock does not operate a relay. A relay you configure receives encrypted changes it cannot read, routing details (which notes change and when), and your short-lived Google sign-in token, which it uses to check that the connection is yours.</p>

  <h2>Removing your data</h2>
  <ul>
    <li>In the app, you can delete a vault from your device, delete it from Google Drive, or delete all of AnkyLock’s data from Google Drive and revoke its access in one step.</li>
    <li>You can also revoke AnkyLock’s access at any time in your <a href="https://myaccount.google.com/connections">Google Account settings</a>.</li>
    <li>Uninstalling the desktop app or clearing the web app’s site data removes the copy on that device.</li>
  </ul>

  <h2>This website</h2>
  <p>This website (ankylock.com) and the web app are static files served by Cloudflare. They set no cookies and use no analytics, ads or trackers, and they load no scripts, fonts or other files from third parties. The website remembers your theme and language choice in your browser’s local storage, which never leaves your device. Like any web host, Cloudflare processes technical data such as your IP address to deliver the pages and protect them from attacks; see <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare’s Privacy Policy</a>. The download links lead to GitHub, under <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub’s Privacy Statement</a>.</p>

  <h2>Children</h2>
  <p>AnkyLock is not directed at children under 13 and does not knowingly collect any data from them; it collects no personal data from anyone.</p>

  <h2>Changes</h2>
  <p>If this policy changes, the new version is published here with a new date, and the history of every change stays visible in the <a href="${REPO_URL}">public source code</a>.</p>

  <h2>Contact</h2>
  <p>Write to ${mail}. To report a security problem, follow the <a href="${docUrl('SECURITY.md')}">security policy</a>.</p>
</article>`,
  });
}
