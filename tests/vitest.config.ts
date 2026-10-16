import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

// End-to-end runs of the real runtime (store, storage, crypto, sync) on two simulated devices.
// Workspace packages resolve to their TypeScript sources; Solid needs its browser build.
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ['@ankylock/source', 'browser'] },
  // Reconnects use the real backoff (0.5 s, 1 s, 2 s…), so a test may take several seconds.
  test: { environment: 'jsdom', include: ['e2e/**/*.test.ts'], testTimeout: 30_000 },
});
