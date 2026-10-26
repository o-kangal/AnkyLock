// After a deploy, checks that ankylock.com and app.ankylock.com serve exactly the files we
// built: Cloudflare features (email obfuscation, Web Analytics, …) rewrite pages and inject
// scripts, which the privacy policy promises never happens. Pages are requested like a browser,
// since some injections only target browsers. One injection is known and tolerated: the bot
// detection snippet of the Free plan, which cannot be switched off there and which the CSP
// (`script-src 'self'`) stops before it runs. Run from the repository root after the build:
// `node scripts/check-live.ts` (Node runs this TypeScript file directly).
import { readFileSync } from 'node:fs';

/** Cloudflare's JavaScript detections snippet, appended before `</body>`; only `r` and `t` vary. */
const BOT_DETECTION_SNIPPET =
  `<script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'R',t:'T'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script>`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The snippet exactly, with its two per-request values, directly before `</body>`. */
const TOLERATED = new RegExp(
  escapeRegExp(BOT_DETECTION_SNIPPET).replace("r:'R'", "r:'[0-9a-f]{1,32}'").replace("t:'T'", "t:'[A-Za-z0-9+/=]{1,64}'") + '(?=</body>)',
);

/** The live page without the tolerated snippet (at most once); anything else stays. */
export const withoutToleratedInjection = (html: string): string => html.replace(TOLERATED, '');

const PAGES: readonly (readonly [string, string])[] = [
  ['https://ankylock.com/', 'apps/site/dist/index.html'],
  ['https://ankylock.com/tr/', 'apps/site/dist/tr/index.html'],
  ['https://ankylock.com/privacy/', 'apps/site/dist/privacy/index.html'],
  ['https://ankylock.com/download/', 'apps/site/dist/download/index.html'],
  ['https://app.ankylock.com/', 'apps/web/dist/index.html'],
];

const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

async function matches(url: string, file: string): Promise<boolean> {
  const built = readFileSync(file, 'utf8');
  // A fresh deploy can take a few seconds to reach every edge.
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${url}?deploy-check=${String(Date.now())}`, { headers: BROWSER, cache: 'no-store' });
    if (response.ok && withoutToleratedInjection(await response.text()) === built) return true;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return false;
}

async function main(): Promise<void> {
  for (const [url, file] of PAGES) {
    if (await matches(url, file)) console.log(`ok ${url}`);
    else {
      console.error(`::error::${url} is not the page we built (${file}): Cloudflare rewrites it. Look for /cdn-cgi/ or cloudflareinsights in it.`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) await main();
