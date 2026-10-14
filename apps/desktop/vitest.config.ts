import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, not to possibly stale dist builds.
const conditions = ['@ankylock/source', ...defaultClientConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
