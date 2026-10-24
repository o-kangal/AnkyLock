// Lint rules for every TypeScript package and app (AGENTS.md: strict TypeScript, no `any`).
// Each package runs `eslint .`; this file is found from there.
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Node's built-in modules by every name they can be imported with (`fs`, `node:fs`, `fs/promises`).
const NODE_MODULES = builtinModules
  .filter((name) => !name.startsWith('_'))
  .flatMap((name) => (name.startsWith('node:') ? [name] : [name, `node:${name}`]));
const NO_NODE = 'Code that runs in the browser or a worker cannot use Node modules (AGENTS.md); use Web APIs or Tauri IPC.';
const nodeImports = NODE_MODULES.map((name) => ({ name, message: NO_NODE }));
const escaped = NODE_MODULES.map((name) => name.replace(/[/:]/g, '\\$&')).join('|');
const nodeDynamicImport = { selector: `ImportExpression > Literal[value=/^(${escaped})$/]`, message: NO_NODE };

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.generated/**', 'target/**', 'apps/desktop/src-tauri/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // House style: `onClick={() => setOpen(false)}` and `() => void promise`.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Y.Text has its own toString (the document text).
      '@typescript-eslint/no-base-to-string': ['error', { ignoredTypeNames: ['Error', 'RegExp', 'URL', 'URLSearchParams', 'YText'] }],
      // Async functions implement async interfaces (storage, transports) without always awaiting.
      '@typescript-eslint/require-await': 'off',
      // `_name` marks a parameter a signature requires but the body does not use.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.tsx'],
    ...solid,
    // Refs are assigned by Solid through `ref={...}`; TypeScript's definite assignment covers the rest.
    rules: { ...solid.rules, 'no-unassigned-vars': 'off' },
  },
  {
    files: ['**/tests/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Fakes reject with DOMException-like values and pass mocked methods around.
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Vitest's asymmetric matchers (`expect.stringContaining`) are typed `any`.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Tests probe values the types already promise, and drive Solid outside components.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'solid/reactivity': 'off',
    },
  },
  {
    // No Node modules in shipped code. Only the apps' own tests and build configs run in Node;
    // `pnpm build:check` catches anything that still reaches a bundle.
    files: ['packages/**', 'apps/**'],
    ignores: ['apps/*/tests/**', 'apps/*/vite.config.ts', 'apps/*/vitest.config.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: nodeImports }],
      'no-restricted-syntax': ['error', nodeDynamicImport],
    },
  },
  {
    // Shipped code must not pull in test helpers, which may use Node modules freely.
    files: ['packages/*/src/**', 'apps/*/src/**', 'apps/*/public/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: nodeImports, patterns: [{ regex: '(^|/)tests?/', message: 'Shipped code must not import test files.' }] }],
    },
  },
  {
    // Build configs and the ServiceWorker are outside the packages' tsconfig projects.
    files: ['**/*.{js,mjs}', '**/vite.config.ts', '**/vitest.config.ts', 'apps/web/src/serviceWorker.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
