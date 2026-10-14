import solid from 'vite-plugin-solid';
import { defaultClientConditions, defineConfig } from 'vite';

// Workspace packages are consumed from their TypeScript sources via the @ankylock/source condition.
const conditions = ['@ankylock/source', ...defaultClientConditions];

export default defineConfig({
  plugins: [solid()],
  resolve: { conditions },
  worker: { format: 'es' },
  // Tauri expects a fixed dev server port and handles the terminal itself.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
