import { describe, expect, it } from 'vitest';
import { cloudflareHeaders, contentSecurityPolicy } from '../headers.js';

/** The `_headers` rules as path → header lines. */
const rules = (text: string): Map<string, string[]> =>
  new Map(text.trim().split('\n\n').map((block) => {
    const [path = '', ...lines] = block.split('\n');
    return [path, lines.map((l) => l.trim())];
  }));

describe('Cloudflare Pages headers', () => {
  const csp = contentSecurityPolicy(undefined);
  const headers = rules(cloudflareHeaders(csp));
  const all = headers.get('/*') ?? [];

  it('send the same CSP as the page’s meta tag, plus frame-ancestors, on every response', () => {
    expect(all).toContain(`Content-Security-Policy: ${csp}; frame-ancestors 'none'`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('send the security headers, keep the sign-in popup working and drop the default CORS header', () => {
    for (const line of [
      'Strict-Transport-Security: max-age=31536000; includeSubDomains',
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      'X-Frame-Options: DENY',
      'Cross-Origin-Resource-Policy: same-origin',
      // `same-origin` would cut the app off from the Google popup it opens and polls.
      'Cross-Origin-Opener-Policy: same-origin-allow-popups',
      '! Access-Control-Allow-Origin',
    ]) {
      expect(all).toContain(line);
    }
  });

  it('cache hashed assets for a year and revalidate pages, the ServiceWorker and the sign-in page', () => {
    expect(headers.get('/assets/*')).toEqual(['Cache-Control: public, max-age=31536000, immutable']);
    for (const path of ['/', '/index.html', '/sw.js', '/oauth-callback.html', '/oauth-callback']) {
      expect(headers.get(path), path).toEqual(['Cache-Control: no-cache']);
    }
  });
});
