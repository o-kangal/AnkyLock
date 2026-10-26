// The web app's security policy, shared by the CSP meta tag in index.html and the `_headers`
// file Cloudflare Pages serves with every response (vite.config.ts writes both at build time).

/**
 * Production CSP. Not applied in dev, where Vite's HMR client needs its own connections.
 * Network access is limited to Drive's API, token revocation and the configured relay; Google
 * sign-in runs in a popup, so no Google script or frame is ever allowed into the page.
 */
export function contentSecurityPolicy(relayUrl: string | undefined): string {
  const relay = relayUrl ? new URL(relayUrl).origin : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror injects its theme styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com ${relay}`.trim(),
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Headers for every response; the same set as the landing site's (apps/site/src/headers.ts). */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Frame-Options', 'DENY'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()'],
  // Our files are for our own pages; no other site may embed them.
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

/**
 * `_headers` lines removing the `Access-Control-Allow-Origin: *` Pages adds by default: no other
 * site's scripts need to read our responses.
 */
export const DETACHED_HEADERS: readonly string[] = ['! Access-Control-Allow-Origin'];

/**
 * Cloudflare Pages `_headers`: the CSP (plus `frame-ancestors`, which a meta tag cannot carry)
 * and the security headers everywhere; hashed assets cached for a year; the pages and the
 * ServiceWorker revalidated on every load so an update is never stuck behind a cache.
 */
export function cloudflareHeaders(csp: string): string {
  const rule = (path: string, headers: readonly (readonly [string, string])[], detach: readonly string[] = []): string =>
    [path, ...headers.map(([name, value]) => `  ${name}: ${value}`), ...detach.map((line) => `  ${line}`)].join('\n');
  return `${[
    rule(
      '/*',
      [
        ['Content-Security-Policy', `${csp}; frame-ancestors 'none'`],
        ...SECURITY_HEADERS,
        // Keeps this window apart from others, except the Google sign-in popup it opens and watches.
        ['Cross-Origin-Opener-Policy', 'same-origin-allow-popups'],
      ],
      DETACHED_HEADERS,
    ),
    rule('/assets/*', [['Cache-Control', 'public, max-age=31536000, immutable']]),
    // Pages serves `/oauth-callback.html` at `/oauth-callback`.
    ...['/', '/index.html', '/sw.js', '/oauth-callback.html', '/oauth-callback'].map((path) => rule(path, [['Cache-Control', 'no-cache']])),
  ].join('\n\n')}\n`;
}
