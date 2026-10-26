import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import solid from 'vite-plugin-solid';
import { build, defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';
import { cloudflareHeaders, contentSecurityPolicy } from './headers.js';

const productionCsp = (csp: string): Plugin => ({
  name: 'ankylock-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' },
  ],
});

/** Short non-cryptographic hash; asset names already carry content hashes. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Builds the ServiceWorker in its own pass as a single IIFE file: browsers without module
 * ServiceWorkers reject any `import`, and a shared chunk with the app would introduce one.
 * The hashed asset list and a build id are compiled in, so the worker precaches the whole app
 * at install (offline after one visit) and replaces old caches on update.
 */
const serviceWorker = (): Plugin => {
  let assets: string[] = [];
  return {
    name: 'ankylock-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      assets = Object.keys(bundle)
        .filter((file) => file !== 'index.html')
        .sort();
    },
    async closeBundle() {
      const output = await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { conditions: ['@ankylock/source', ...defaultClientConditions] },
        define: {
          __ANKYLOCK_PRECACHE__: JSON.stringify(assets),
          __ANKYLOCK_BUILD_ID__: JSON.stringify(fnv1a(assets.join(','))),
        },
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2022',
          lib: { entry: 'src/serviceWorker.ts', formats: ['iife'], name: 'ankylockServiceWorker', fileName: () => 'sw.js' },
        },
      });
      const chunks = (Array.isArray(output) ? output : [output]).flatMap((o) => ('output' in o ? o.output : []));
      const code = chunks.map((c) => ('code' in c ? c.code : '')).join('\n');
      if (/^\s*(import|export)\b/m.test(code)) throw new Error('sw.js must be a classic script without import/export.');
    },
  };
};

/**
 * Writes Cloudflare's `_headers` next to the build, after the bundle so the ServiceWorker does
 * not try to precache it (Pages never serves it).
 */
const pagesHeaders = (csp: string): Plugin => ({
  name: 'ankylock-pages-headers',
  apply: 'build',
  writeBundle(options) {
    writeFileSync(join(options.dir ?? 'dist', '_headers'), cloudflareHeaders(csp));
  },
});

export default defineConfig(({ mode }) => {
  const csp = contentSecurityPolicy(loadEnv(mode, new URL('.', import.meta.url).pathname)['VITE_RELAY_URL']);
  return {
    plugins: [solid(), productionCsp(csp), pagesHeaders(csp), serviceWorker()],
    // Workspace packages are consumed from their TypeScript sources via the @ankylock/source condition.
    resolve: { conditions: ['@ankylock/source', ...defaultClientConditions] },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
