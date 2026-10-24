import { REPO } from './site.js';

export type PackageKind = 'appimage' | 'deb' | 'rpm';
export const PACKAGE_KINDS: readonly PackageKind[] = ['appimage', 'deb', 'rpm'];

export interface ReleasePackage {
  readonly kind: PackageKind;
  readonly name: string;
  readonly url: string;
  readonly size: number;
  /** From the release's `SHA256SUMS`; null when the file is not listed there. */
  readonly sha256: string | null;
}

export interface Release {
  readonly version: string;
  readonly publishedAt: string;
  readonly url: string;
  readonly packages: readonly ReleasePackage[];
}

const KIND_BY_SUFFIX: readonly (readonly [string, PackageKind])[] = [
  ['.AppImage', 'appimage'],
  ['.deb', 'deb'],
  ['.rpm', 'rpm'],
];

/** `sha256sum` output (`<hex>  <name>`, or `<hex> *<name>` in binary mode) as name → hash. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

export interface GitHubRelease {
  readonly tag_name: string;
  readonly published_at: string;
  readonly html_url: string;
  readonly assets: readonly GitHubAsset[];
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r['tag_name'] === 'string' && typeof r['published_at'] === 'string' && typeof r['html_url'] === 'string' && Array.isArray(r['assets']);
}

/** The Linux packages of a GitHub release, with their checksums. */
export function toRelease(release: GitHubRelease, checksums: Map<string, string>): Release {
  const packages = release.assets.flatMap((asset): ReleasePackage[] => {
    const kind = KIND_BY_SUFFIX.find(([suffix]) => asset.name.endsWith(suffix))?.[1];
    if (!kind) return [];
    return [{ kind, name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: checksums.get(asset.name) ?? null }];
  });
  return {
    version: release.tag_name.replace(/^v/, ''),
    publishedAt: release.published_at,
    url: release.html_url,
    packages: [...packages].sort((a, b) => PACKAGE_KINDS.indexOf(a.kind) - PACKAGE_KINDS.indexOf(b.kind)),
  };
}

/**
 * The latest release, read at build time so visitors' browsers never call GitHub. Null when the
 * repository has no release yet (or is not public). `token` (CI's GITHUB_TOKEN) avoids the
 * unauthenticated rate limit; any other failure throws, so a deploy never hides a release.
 */
export async function fetchLatestRelease(fetchImpl: typeof fetch, token?: string): Promise<Release | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for the latest release.`);
  const body: unknown = await response.json();
  if (!isGitHubRelease(body)) throw new Error('GitHub sent an unexpected release format.');
  const sumsAsset = body.assets.find((a) => a.name === 'SHA256SUMS');
  let checksums = new Map<string, string>();
  if (sumsAsset) {
    const sums = await fetchImpl(sumsAsset.browser_download_url, { signal: AbortSignal.timeout(15_000) });
    if (!sums.ok) throw new Error(`Could not download SHA256SUMS (${String(sums.status)}).`);
    checksums = parseChecksums(await sums.text());
  }
  return toRelease(body, checksums);
}
