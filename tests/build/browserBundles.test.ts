// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createLogger } from 'vite';
import { describe, expect, it } from 'vitest';
import { externalizedModules, literalNodeImports } from '../../scripts/check-build.js';

/** Builds `code` as browser code with Vite, as the apps do, and returns everything Vite logged. */
async function bundle(code: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ankylock-bundle-'));
  // Vite only warns in production builds; Vitest runs with NODE_ENV=test.
  const env = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    writeFileSync(join(dir, 'entry.js'), code);
    const logged: string[] = [];
    const logger = createLogger('warn');
    logger.warn = (msg) => void logged.push(msg);
    logger.warnOnce = (msg) => void logged.push(msg);
    logger.error = (msg) => void logged.push(msg);
    await build({
      configFile: false,
      root: dir,
      logLevel: 'warn',
      customLogger: logger,
      build: { write: false, rollupOptions: { input: join(dir, 'entry.js') } },
    });
    return logged.join('\n');
  } finally {
    process.env['NODE_ENV'] = env;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pnpm build:check', () => {
  // Vite gives no error and leaves no trace in the output: its warning is all there is to catch.
  // If a Vite upgrade rewords it, this test fails instead of the check going quiet.
  it('catches Vite’s warning for a Node module in browser code, static or dynamic', async () => {
    const log = await bundle("import { createHash } from 'node:crypto';\nconsole.log(createHash, await import('fs'));\n");
    expect(externalizedModules(log).map((p) => p.module).sort()).toEqual(['fs', 'node:crypto']);
  }, 30_000);

  it('stays quiet for browser-only code', async () => {
    expect(externalizedModules(await bundle('console.log(crypto.subtle);\n'))).toEqual([]);
  }, 30_000);

  it('finds Node imports in files copied unbundled from public/', () => {
    const found = (code: string): string[] => literalNodeImports('public.js', code).map((p) => p.module);
    expect(found("import{a}from'node:fs';")).toEqual(['node:fs']);
    expect(found('await import("crypto"); import "fs/promises"; require("path")')).toEqual(['crypto', 'fs/promises', 'path']);
    expect(found('import x from "pathe"; const s = "node:fs";')).toEqual([]);
  });
});
