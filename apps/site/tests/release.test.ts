import { describe, expect, it, vi } from 'vitest';
import { fetchLatestRelease, parseChecksums, toRelease, type GitHubRelease } from '../src/release.js';

const hash = (c: string): string => c.repeat(64);
const asset = (name: string) => ({ name, browser_download_url: `https://github.com/dl/${name}`, size: 10 });
const GITHUB: GitHubRelease = {
  tag_name: 'v1.0.0',
  published_at: '2026-11-01T00:00:00Z',
  html_url: 'https://github.com/o-kangal/AnkyLock/releases/tag/v1.0.0',
  assets: [asset('a.rpm'), asset('a.deb'), asset('SHA256SUMS'), asset('a.AppImage'), asset('a.AppImage.sig')],
};

describe('release', () => {
  it('reads sha256sum output in text and binary mode', () => {
    const sums = parseChecksums(`${hash('A')}  a.deb\n${hash('b')} *a.rpm\nnot a line\n`);
    expect([...sums]).toEqual([
      ['a.deb', hash('a')],
      ['a.rpm', hash('b')],
    ]);
  });

  it('keeps the Linux packages in AppImage, .deb, .rpm order, with their checksums', () => {
    const release = toRelease(GITHUB, new Map([['a.deb', hash('c')]]));
    expect(release.version).toBe('1.0.0');
    expect(release.packages.map((p) => [p.kind, p.name, p.sha256])).toEqual([
      ['appimage', 'a.AppImage', null],
      ['deb', 'a.deb', hash('c')],
      ['rpm', 'a.rpm', null],
    ]);
  });

  it('fetches the latest release and its SHA256SUMS, with the token when given', async () => {
    const fake = vi.fn(async (url: string | URL | Request) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/releases/latest') ? Response.json(GITHUB) : new Response(`${hash('d')}  a.rpm\n`),
    );
    const release = await fetchLatestRelease(fake, 'secret');
    expect(release?.packages.find((p) => p.kind === 'rpm')?.sha256).toBe(hash('d'));
    const headers = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect((headers[1].headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });

  it('treats a repository without releases as none, and any other failure as an error', async () => {
    expect(await fetchLatestRelease(async () => new Response('', { status: 404 }))).toBeNull();
    await expect(fetchLatestRelease(async () => new Response('', { status: 403 }))).rejects.toThrow('403');
    await expect(fetchLatestRelease(async () => Response.json({ message: 'odd' }))).rejects.toThrow('unexpected');
  });
});
