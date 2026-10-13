import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, not to possibly stale dist builds.
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ['@ankylock/source', 'browser'] },
  test: { environment: 'jsdom' },
});
