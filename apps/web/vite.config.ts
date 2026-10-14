import solid from 'vite-plugin-solid';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/**
 * Production CSP. Not applied in dev, where Vite's HMR client needs its own connections.
 * Task 11c widens connect-src for Google sign-in, Drive and the relay.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror injects its theme styles at runtime.
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const productionCsp = (): Plugin => ({
  name: 'ankylock-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
});

/** Short non-cryptographic hash; asset names already carry content hashes. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Injects the hashed build assets and a build id into sw.js so the ServiceWorker precaches the
 * whole app at install (offline after a single visit) and replaces old caches on update.
 */
const precacheManifest = (): Plugin => ({
  name: 'ankylock-precache-manifest',
  apply: 'build',
  generateBundle(_options, bundle) {
    const sw = bundle['sw.js'];
    if (sw?.type !== 'chunk') return;
    const assets = Object.keys(bundle)
      .filter((file) => file !== 'sw.js' && file !== 'index.html')
      .sort();
    const buildId = fnv1a(assets.join(','));
    sw.code = sw.code.replaceAll('__ANKYLOCK_PRECACHE__', assets.join(',')).replaceAll('__ANKYLOCK_BUILD_ID__', buildId);
  },
});

export default defineConfig({
  plugins: [solid(), productionCsp(), precacheManifest()],
  // Workspace packages are consumed from their TypeScript sources via the @ankylock/source condition.
  resolve: { conditions: ['@ankylock/source', ...defaultClientConditions] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: 'index.html', sw: 'src/serviceWorker.ts' },
      // The ServiceWorker must keep a stable URL at the site root to control the whole app.
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
