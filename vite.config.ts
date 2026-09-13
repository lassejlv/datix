import { defineConfig } from 'vite-plus';

const ignorePatterns = [
  '**/node_modules/**',
  '**/dist/**',
  '**/artifacts/**',
  '**/output/**',
  '**/.codex/**',
  '.local/**',
  '.vite/**',
  'apps/web/src/routeTree.gen.ts',
  'apps/web/public/web-vitals.js',
  'packages/database/migrations/**',
];

export default defineConfig({
  envDir: false,
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc'],
    jsPlugins: [{ name: 'spacing', specifier: '@stylistic/eslint-plugin' }],
    rules: {
      'spacing/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['export', 'function', 'block-like', 'return'] },
        { blankLine: 'always', prev: ['import', 'export', 'function', 'block-like'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['multiline-const', 'multiline-let'] },
        { blankLine: 'always', prev: ['multiline-const', 'multiline-let'], next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
      ],
    },
    categories: { correctness: 'error' },
    ignorePatterns,
    overrides: [
      { files: ['apps/web/**'], plugins: ['react'] },
      {
        // Existing frontend findings remain visible while adopting the shared checks.
        files: ['apps/web/src/components/**'],
        plugins: ['react'],
        rules: {
          'react/set-state-in-effect': 'warn',
          'react/purity': 'warn',
          'react/refs': 'warn',
          'react-hooks/exhaustive-deps': 'warn',
        },
      },
    ],
  },
  fmt: { singleQuote: true, semi: true, ignorePatterns },
});
