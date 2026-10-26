import { SECURITY_HEADERS } from '@ankylock/web/headers';

/**
 * The site's CSP: its own scripts, styles, fonts and images only. No inline script or style,
 * no network requests, nothing may frame it.
 */
export const SITE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Cloudflare Pages `_headers`: the CSP and the app's security headers everywhere; hashed assets cached for a year. */
export function siteHeaders(): string {
  const lines = (headers: readonly (readonly [string, string])[]): string[] => headers.map(([name, value]) => `  ${name}: ${value}`);
  return [
    '/*',
    ...lines([['Content-Security-Policy', SITE_CSP], ...SECURITY_HEADERS]),
    '',
    '/assets/*',
    ...lines([['Cache-Control', 'public, max-age=31536000, immutable']]),
    '',
  ].join('\n');
}
