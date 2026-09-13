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
