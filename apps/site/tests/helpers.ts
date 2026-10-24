import type { Release } from '../src/release.js';
import { renderSite, type AssetSources } from '../src/render.js';

export const SOURCES: AssetSources = { styles: '/src/site.css', script: '/src/main.ts', icon: '/media/icon.png', screenshot: '/media/shot.png' };

export const RELEASE: Release = {
  version: '1.2.0',
  publishedAt: '2026-11-03T10:00:00Z',
  url: 'https://github.com/o-kangal/AnkyLock/releases/tag/v1.2.0',
  packages: [
    { kind: 'appimage', name: 'AnkyLock_1.2.0_amd64.AppImage', url: 'https://github.com/o-kangal/AnkyLock/releases/download/v1.2.0/AnkyLock_1.2.0_amd64.AppImage', size: 84_000_000, sha256: 'a'.repeat(64) },
    { kind: 'deb', name: 'AnkyLock_1.2.0_amd64.deb', url: 'https://github.com/o-kangal/AnkyLock/releases/download/v1.2.0/AnkyLock_1.2.0_amd64.deb', size: 9_000_000, sha256: null },
  ],
};

/** The rendered site as a map from file to its parsed document (pages only). */
export function renderedPages(release: Release | null = null): Map<string, Document> {
  const parser = new DOMParser();
  return new Map(
    renderSite(release, SOURCES)
      .filter((f) => f.file.endsWith('.html'))
      .map((f) => [f.file, parser.parseFromString(f.content, 'text/html')]),
  );
}
