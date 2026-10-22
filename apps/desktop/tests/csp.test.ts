import { describe, expect, it } from 'vitest';
import config from '../src-tauri/tauri.conf.json';

const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name = '', ...sources]) => [name, sources]));

describe('desktop content security policy', () => {
  const production = directives(config.app.security.csp);
  const development = directives(config.app.security.devCsp);

  it('runs only the app’s own scripts and workers, and allows no plugins, base or form targets', () => {
    expect(production.get('script-src')).toEqual(["'self'"]);
    expect(production.get('worker-src')).toEqual(["'self'"]);
    for (const name of ['object-src', 'base-uri', 'form-action', 'frame-src']) expect(production.get(name)).toEqual(["'none'"]);
  });

  it('keeps the local development relay out of release builds', () => {
    expect(production.get('connect-src')?.some((s) => s.startsWith('ws:'))).toBe(false);
    expect(development.get('connect-src')).toContain('ws://127.0.0.1:8787');
    // Otherwise the same policy.
    for (const [name, sources] of production) if (name !== 'connect-src') expect(development.get(name)).toEqual(sources);
  });
});
