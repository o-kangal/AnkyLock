import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, not to possibly stale dist builds.
export default defineConfig({
  resolve: { conditions: ['@ankylock/source'] },
  ssr: { resolve: { conditions: ['@ankylock/source'] } },
});
