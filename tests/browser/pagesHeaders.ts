import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';

interface Rule {
  readonly pattern: string;
  readonly headers: readonly (readonly [string, string])[];
  /** Headers the rule removes (`! Name`). */
  readonly detach: readonly string[];
}

/** Cloudflare Pages `_headers`: a path pattern line, then indented `Name: value` or `! Name` lines. */
export function parsePagesHeaders(text: string): Rule[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map(([pattern = '', ...lines]) => ({
      pattern: pattern.trim(),
      headers: lines
        .filter((line) => !line.trim().startsWith('!'))
        .map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
        }),
      detach: lines.filter((line) => line.trim().startsWith('!')).map((line) => line.trim().slice(1).trim().toLowerCase()),
    }));
}

const matches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

/**
 * Serves `origin` with the headers its built `_headers` file sets, as Cloudflare Pages would,
 * so tests run under the production CSP (`vite preview` sends none).
 */
export async function servePagesHeaders(context: BrowserContext, origin: string, headersFile: string): Promise<void> {
  const rules = parsePagesHeaders(readFileSync(headersFile, 'utf8'));
  await context.route(`${origin}/**`, async (route) => {
    const response = await route.fetch();
    const path = new URL(route.request().url()).pathname;
    const matching = rules.filter((r) => matches(r.pattern, path));
    const extra = Object.fromEntries(matching.flatMap((r) => r.headers.map(([n, v]) => [n.toLowerCase(), v])));
    const detached = new Set(matching.flatMap((r) => r.detach));
    const kept = Object.entries(response.headers()).filter(([name]) => !detached.has(name));
    await route.fulfill({ response, headers: { ...Object.fromEntries(kept), ...extra } });
  });
}

/** Records every CSP violation on the page; read them with `cspViolations`. */
export async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

export const cspViolations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
