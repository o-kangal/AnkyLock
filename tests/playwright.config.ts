import { defineConfig, devices } from '@playwright/test';
import { CLIENT_ID } from './browser/fakeGoogle.js';
import { APP_ORIGIN, APP_PORT, SITE_ORIGIN, SITE_PORT } from './browser/origins.js';

// Browser tests of the production web app (against a fake Google) and landing site, under the headers
// Cloudflare serves them with, in Chromium and WebKit (the engine of the Linux and macOS desktop apps). `pnpm --filter @ankylock/e2e test:browser`; browsers come from
// `pnpm --filter @ankylock/e2e exec playwright install --with-deps chromium webkit`.
export default defineConfig({
  testDir: 'browser',
  testMatch: '**/*.pw.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  // Deriving a vault key takes a moment (600,000 PBKDF2 iterations).
  timeout: 60_000,
  use: {
    baseURL: APP_ORIGIN,
    trace: 'retain-on-failure',
    // Requests a ServiceWorker passes on escape page routes (in WebKit), and with them the fake Google.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      // A Google client id the fake in browser/fakeGoogle.ts answers for; no relay.
      command: `pnpm --filter @ankylock/web exec vite build && pnpm --filter @ankylock/web exec vite preview --port ${String(APP_PORT)} --strictPort`,
      url: APP_ORIGIN,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      env: { VITE_GOOGLE_CLIENT_ID: CLIENT_ID, VITE_RELAY_URL: '' },
    },
    {
      command: `pnpm --filter @ankylock/site exec vite build && pnpm --filter @ankylock/site exec vite preview --port ${String(SITE_PORT)} --strictPort`,
      url: SITE_ORIGIN,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
    },
  ],
});
