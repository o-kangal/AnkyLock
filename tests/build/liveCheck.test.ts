// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { withoutToleratedInjection } from '../../scripts/check-live.js';

const page = '<!doctype html><html><head></head><body><main>AnkyLock</main></body></html>\n';
/** Cloudflare's Free-plan bot detection snippet as it was served on 2026-10-27. */
const snippet = (r = 'a50cfc0069353f0f', t = 'MTc5MzA1NDY1Mw=='): string =>
  `<script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'${r}',t:'${t}'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script>`;
const inject = (html: string, what: string, before = '</body>'): string => html.replace(before, what + before);

describe('node scripts/check-live.ts', () => {
  it('tolerates only the bot detection snippet, exactly, just before </body>', () => {
    expect(withoutToleratedInjection(inject(page, snippet()))).toBe(page);
    expect(withoutToleratedInjection(inject(page, snippet('0123abcd', 'AAAA')))).toBe(page);
  });

  it('keeps any other change, so the comparison fails', () => {
    const analytics = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"x"}'></script>`;
    for (const changed of [
      inject(page, analytics),
      inject(page, snippet() + analytics),
      // The snippet, but loading something else.
      inject(page, snippet().replace('/cdn-cgi/challenge-platform/scripts/jsd/main.js', 'https://evil.example/x.js')),
      // The snippet elsewhere than at the end of the body.
      inject(page, snippet(), '</head>'),
      page.replace('AnkyLock', 'AnkyL0ck'),
    ]) {
      expect(withoutToleratedInjection(changed)).not.toBe(page);
    }
  });
});
