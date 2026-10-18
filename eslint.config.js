// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))];

/** Imports that only make sense in Node or Electron's privileged processes. */
const nodeOnlyImports = {
  paths: [{ name: 'electron', message: 'Electron APIs belong in apps/desktop main, preload or engine code.' }],
  patterns: [
    {
      group: ['node:*'],
      message: 'Node built-ins are not available here.',
    },
    {
      group: NODE_BUILTINS.flatMap((name) => [name, `${name}/*`]),
      message: 'Node built-ins are not available here.',
    },
  ],
};

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/out/',
    '**/dist/',
    '**/release/',
    '**/coverage/',
    '**/test-results/',
    '**/playwright-report/',
    '**/e2e-results/',
    // Benchmark build output and results.
    '**/bench/.out/',
    '**/bench/.out-charts/',
    '**/bench/results/',
    // Claude Design export (gitignored reference material).
    'design/',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // The design-token generator is CommonJS (packages/ui/tokens/package.json).
    files: ['packages/ui/tokens/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // --- Runtime environments -------------------------------------------------
  {
    files: ['apps/desktop/src/main/**', 'apps/desktop/src/engine/**', '**/*.config.ts', 'apps/desktop/e2e/**', 'apps/web/e2e/**', 'apps/web/scripts/**', 'tools/**', 'packages/ui/bench/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/desktop/src/preload/**'],
    languageOptions: { globals: { ...globals.browser, process: 'readonly' } },
  },
  {
    files: ['apps/desktop/src/renderer/**', 'apps/web/src/**', 'packages/app/src/**', 'packages/ui/src/**', 'packages/ui/bench/grid/**', 'packages/ui/bench/charts/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    files: ['apps/desktop/e2e/**'],
    rules: { 'no-console': 'off' },
  },

  // --- Architectural boundaries ----------------------------------------------
  {
    // Core is shared by Electron's utility process, the renderer and the web
    // build, so it may not touch Electron, Node built-ins or the DOM.
    files: ['packages/core/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeOnlyImports.paths,
            { name: 'react', message: 'Core is UI-free; put components in @glassgrid/ui.' },
            { name: 'react-dom', message: 'Core is UI-free; put components in @glassgrid/ui.' },
          ],
          patterns: [
            ...nodeOnlyImports.patterns,
            { group: ['@glassgrid/*'], message: 'Core must not depend on other workspace packages.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'self'].map((name) => ({
          name,
          message: 'Core must not use DOM APIs.',
        })),
        ...['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global', 'setImmediate'].map(
          (name) => ({ name, message: 'Core must not use Node APIs.' }),
        ),
      ],
    },
  },
  {
    // Renderer code (desktop and web) runs in a sandboxed browser context.
    files: ['apps/desktop/src/renderer/**', 'apps/web/src/**', 'packages/ui/src/**'],
    rules: { 'no-restricted-imports': ['error', nodeOnlyImports] },
  },
  {
    // The app is shared by both shells: no Electron, no Node, and nothing
    // from a shell. Platform specifics arrive through its Platform interface.
    files: ['packages/app/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeOnlyImports.paths,
          patterns: [
            ...nodeOnlyImports.patterns,
            { group: ['@glassgrid/desktop', '@glassgrid/desktop/*', '@glassgrid/web', '@glassgrid/web/*'], message: 'The app must not depend on a shell; add what it needs to Platform.' },
            { group: ['**/apps/**'], message: 'The app must not depend on a shell; add what it needs to Platform.' },
          ],
        },
      ],
    },
  },
);
