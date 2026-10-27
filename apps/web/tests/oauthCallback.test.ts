import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(join(process.cwd(), 'public/oauth-callback.html'), 'utf8');

describe('Google sign-in landing page', () => {
  it('allows exactly its own inline style through the CSP hash', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(style).digest('base64');
    expect(html).toContain(`style-src 'sha256-${hash}'`);
  });
});
