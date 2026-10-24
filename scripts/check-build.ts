// Builds every package and app, then fails if Node built-in modules reached code that ships to
// browsers (AGENTS.md). Vite swaps such an import for an empty stub, leaves no trace in the
// output and still exits 0; it only logs a warning, which is what this catches, for every bundle
// (app, workers, ServiceWorker, site). Files copied as they are from `public/` skip bundling, so
// the output folders are also searched for literal Node imports.
// Run from the repository root: `pnpm build:check` (Node runs this TypeScript file directly).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

/** Vite's warning when browser code imports a Node module (tests/build pins its wording). */
export const EXTERNALIZED = /Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/g;

const BUILTIN = builtinModules.filter((m) => !m.startsWith('_')).join('|');

/** A Node module imported by name (`node:fs`, `fs`, `fs/promises`) in a shipped JavaScript file. */
export const LITERAL_NODE_IMPORT = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)["']((?:node:)?(?:${BUILTIN})(?:/[\\w/]+)?)["']`,
  'g',
);

export interface Problem {
  readonly module: string;
  readonly where: string;
}

export function externalizedModules(log: string): Problem[] {
  return Array.from(log.matchAll(EXTERNALIZED), (m) => ({ module: m[1] ?? '', where: m[2] ?? '' }));
}

export function literalNodeImports(file: string, code: string): Problem[] {
  return Array.from(code.matchAll(LITERAL_NODE_IMPORT), (m) => ({ module: m[1] ?? '', where: file }));
}

/** Every `.js`/`.mjs` file below `dir`. */
function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

async function main(): Promise<void> {
  // Echo the build as it runs, and keep its output to search.
  const log = await new Promise<string>((resolve, reject) => {
    // Vite only logs the warning in production builds, whatever NODE_ENV the caller has set.
    const child = spawn('pnpm', ['-r', 'run', 'build'], { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
    let out = '';
    const keep = (chunk: Buffer, to: NodeJS.WriteStream): void => {
      out += chunk.toString();
      to.write(chunk);
    };
    child.stdout.on('data', (c: Buffer) => keep(c, process.stdout));
    child.stderr.on('data', (c: Buffer) => keep(c, process.stderr));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`The build failed (exit ${String(code)}).`))));
  });
  const outputs = readdirSync('apps', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join('apps', e.name, 'dist'))
    .filter((dir) => existsSync(dir));
  const problems = [
    ...externalizedModules(log),
    ...outputs.flatMap((dir) => scripts(dir).flatMap((file) => literalNodeImports(file, readFileSync(file, 'utf8')))),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::Node module "${p.module}" in browser code: ${p.where}`);
    process.exitCode = 1;
    return;
  }
  console.log(`No Node modules in browser bundles (${outputs.join(', ')}).`);
}

if (import.meta.main) await main();
