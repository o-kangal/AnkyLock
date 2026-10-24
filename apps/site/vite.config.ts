import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultClientConditions, defineConfig, runnerImport } from 'vite';
import { fetchLatestRelease, type Release } from './src/release.js';

const here = import.meta.dirname;
// The rendered pages are Vite's root; `public` holds files served as they are.
const generated = resolve(here, '.generated');
const pagesDir = join(generated, 'pages');
const publicDir = join(generated, 'public');

/** The latest GitHub release; a failure stops a CI build but only warns locally (offline work). */
async function latestRelease(): Promise<Release | null> {
  try {
    return await fetchLatestRelease(fetch, process.env['GITHUB_TOKEN']);
  } catch (error) {
    if (process.env['CI']) throw error;
    console.warn(`Download page without a release: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The renderer, loaded through Vite rather than Node: it imports the logo from the web app's
 * TypeScript sources (`@ankylock/web/logo`), which only resolve under the workspace condition.
 */
async function loadRenderer(): Promise<typeof import('./src/render.js')> {
  const { module } = await runnerImport<typeof import('./src/render.js')>(resolve(here, 'src/render.ts'), {
    root: here,
    // Merged into runnerImport's own `inline` environment; Vite transforms the inlined sources.
    environments: { inline: { resolve: { conditions: ['@ankylock/source'], noExternal: ['@ankylock/web'] } } },
  });
  return module;
}

export default defineConfig(async () => {
  const { renderSite } = await loadRenderer();
  const files = renderSite(await latestRelease(), {
    // Root-relative, so they resolve the same from every page, in dev and in the build.
    styles: '/src/styles/site.css',
    script: '/src/client/main.ts',
    icon: '/media/icon-192.png',
    screenshot: '/media/workspace-dark.png',
  });
  rmSync(generated, { recursive: true, force: true });
  for (const { file, content } of files) {
    const target = file.endsWith('.html') ? join(pagesDir, file) : join(publicDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // A classic script, so it runs before the first paint; Vite only bundles module scripts.
  copyFileSync(join(here, 'src/init.js'), join(publicDir, 'init.js'));
  // The sources and images the pages use, inside the root (a junction needs no rights on Windows).
  symlinkSync(join(here, 'src'), join(pagesDir, 'src'), 'junction');
  mkdirSync(join(pagesDir, 'media'));
  copyFileSync(resolve(here, '../web/public/icons/icon-192.png'), join(pagesDir, 'media/icon-192.png'));
  copyFileSync(resolve(here, '../../docs/screenshots/workspace-dark.png'), join(pagesDir, 'media/workspace-dark.png'));

  return {
    root: pagesDir,
    publicDir,
    resolve: { conditions: ['@ankylock/source', ...defaultClientConditions] },
    server: { fs: { allow: [resolve(here, '../..')] } },
    build: {
      outDir: resolve(here, 'dist'),
      emptyOutDir: true,
      // Small files stay files: the CSP forbids `data:` fonts and images.
      assetsInlineLimit: 0,
      rollupOptions: { input: files.filter((f) => f.file.endsWith('.html')).map((f) => join(pagesDir, f.file)) },
    },
  };
});
