import solid from 'vite-plugin-solid';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources, not to possibly stale dist builds.
const conditions = ['@ankylock/source', ...defaultClientConditions];

export default defineConfig({
  // The update banner's strings come from the web app's components (JSX).
  plugins: [solid()],
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
