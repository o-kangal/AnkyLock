// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { changelogSection, releaseProblems, updaterManifest } from '../../scripts/release-files.js';

const changelog = `# Changelog

## [0.2.0] - Unreleased

### Fixed

- Something.

## [0.1.0] - 2026-11-03

First release.
`;
const files = (version: string, notes = changelog) => ({
  tauriConf: JSON.stringify({ version }),
  cargoToml: `[package]\nname = "ankylock-desktop"\nversion = "${version}"\n`,
  packageJson: JSON.stringify({ name: '@ankylock/desktop', version }),
  changelog: notes,
});

describe('scripts/release-files.ts', () => {
  it('reads a version’s notes and date from CHANGELOG.md', () => {
    expect(changelogSection(changelog, '0.1.0')).toEqual({ date: '2026-11-03', body: 'First release.' });
    expect(changelogSection(changelog, '0.2.0')).toEqual({ date: 'Unreleased', body: '### Fixed\n\n- Something.' });
    expect(changelogSection(changelog, '0.3.0')).toBeNull();
  });

  it('releases only when every version agrees and the notes are dated', () => {
    expect(releaseProblems('0.1.0', files('0.1.0'), true)).toEqual([]);
    expect(releaseProblems('0.2.0', files('0.2.0'), false)).toEqual([]);
    expect(releaseProblems('0.2.0', files('0.2.0'), true)).toEqual([
      `CHANGELOG.md's heading for 0.2.0 needs the release date (YYYY-MM-DD), not "Unreleased".`,
    ]);
    const mismatch = { ...files('0.1.0'), cargoToml: 'version = "0.0.9"\n' };
    expect(releaseProblems('0.1.0', mismatch, true)).toEqual(['apps/desktop/src-tauri/Cargo.toml says version 0.0.9, not 0.1.0.']);
    expect(releaseProblems('0.3.0', files('0.3.0'), false)).toEqual(['CHANGELOG.md has no notes for 0.3.0.']);
  });

  it('writes the updater manifest the Tauri plugin reads', () => {
    const url = 'https://github.com/o-kangal/AnkyLock/releases/download/v0.1.0/AnkyLock_0.1.0_amd64.AppImage';
    const manifest = JSON.parse(updaterManifest('0.1.0', 'First release.', url, 'c2lnbmF0dXJl\n', new Date('2026-11-03T10:00:00Z'))) as unknown;
    expect(manifest).toEqual({
      version: '0.1.0',
      notes: 'First release.',
      pub_date: '2026-11-03T10:00:00.000Z',
      platforms: { 'linux-x86_64': { signature: 'c2lnbmF0dXJl', url } },
    });
  });
});
