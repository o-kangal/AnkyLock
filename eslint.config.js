// Lint rules for every TypeScript package and app (AGENTS.md: strict TypeScript, no `any`).
// Each package runs `eslint .`; this file is found from there.
import js from '@eslint/js';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'target/**', 'apps/desktop/src-tauri/**'] },
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
    // Build configs and the ServiceWorker are outside the packages' tsconfig projects.
    files: ['**/*.{js,mjs}', '**/vite.config.ts', '**/vitest.config.ts', 'apps/web/src/serviceWorker.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
