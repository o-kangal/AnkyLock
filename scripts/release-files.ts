// Helpers for the release workflow (.github/workflows/release.yml); Node runs this TypeScript
// file directly. From the repository root:
//   node scripts/release-files.ts check <version> [--released]   versions agree; CHANGELOG has the section
//   node scripts/release-files.ts notes <version>                the release notes, from CHANGELOG.md
//   node scripts/release-files.ts manifest <version> <AppImage url> <.sig file>   the updater's latest.json
import { readFileSync } from 'node:fs';

/** A version's section of CHANGELOG.md: its heading (`## [x.y.z] - date`) and body. */
export function changelogSection(changelog: string, version: string): { readonly date: string; readonly body: string } | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const date = /^## \[[^\]]+\] - (.+)$/.exec(lines[start] ?? '')?.[1]?.trim() ?? '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return { date, body: (end === -1 ? rest : rest.slice(0, end)).join('\n').trim() };
}

/** Problems that stop a release: versions that disagree, or notes missing or not dated yet. */
export function releaseProblems(
  version: string,
  files: { readonly tauriConf: string; readonly cargoToml: string; readonly packageJson: string; readonly changelog: string },
  released: boolean,
): string[] {
  const problems: string[] = [];
  const versions = {
    'apps/desktop/src-tauri/tauri.conf.json': (JSON.parse(files.tauriConf) as { version?: unknown }).version,
    'apps/desktop/src-tauri/Cargo.toml': /^version = "([^"]+)"$/m.exec(files.cargoToml)?.[1],
    'apps/desktop/package.json': (JSON.parse(files.packageJson) as { version?: unknown }).version,
  };
  for (const [file, found] of Object.entries(versions)) {
    if (found !== version) problems.push(`${file} says version ${String(found)}, not ${version}.`);
  }
  const section = changelogSection(files.changelog, version);
  if (!section || section.body === '') problems.push(`CHANGELOG.md has no notes for ${version}.`);
  else if (released && !/^\d{4}-\d{2}-\d{2}$/.test(section.date)) {
    problems.push(`CHANGELOG.md's heading for ${version} needs the release date (YYYY-MM-DD), not "${section.date}".`);
  }
  return problems;
}

/** The Tauri updater's `latest.json` for one Linux AppImage. */
export function updaterManifest(version: string, notes: string, url: string, signature: string, pubDate: Date): string {
  const manifest = {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: { 'linux-x86_64': { signature: signature.trim(), url } },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main(args: readonly string[]): void {
  const [command, version = ''] = args;
  const read = (file: string): string => readFileSync(file, 'utf8');
  const notes = (): string => changelogSection(read('CHANGELOG.md'), version)?.body ?? '';
  switch (command) {
    case 'check': {
      const problems = releaseProblems(
        version,
        {
          tauriConf: read('apps/desktop/src-tauri/tauri.conf.json'),
          cargoToml: read('apps/desktop/src-tauri/Cargo.toml'),
          packageJson: read('apps/desktop/package.json'),
          changelog: read('CHANGELOG.md'),
        },
        args.includes('--released'),
      );
      for (const problem of problems) console.error(`::error::${problem}`);
      if (problems.length > 0) process.exitCode = 1;
      return;
    }
    case 'notes':
      process.stdout.write(`${notes()}\n`);
      return;
    case 'manifest':
      process.stdout.write(updaterManifest(version, notes(), args[2] ?? '', read(args[3] ?? ''), new Date()));
      return;
    default:
      console.error('Usage: node scripts/release-files.ts check|notes|manifest <version> …');
      process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
