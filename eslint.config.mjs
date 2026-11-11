import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/generated/**',
      'pnpm-lock.yaml',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'prisma', 'pg'],
              message: 'Contracts must stay free of Nest, Prisma, and database clients.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/fake-salesforce/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['portal-api', 'portal-worker', '**/portal-api/**', '**/portal-worker/**'],
              message: 'Fake Salesforce must not import portal modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/portal-api/**/*.ts', 'apps/portal-worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fake-salesforce', '**/fake-salesforce/**'],
              message: 'Portal processes call Fake Salesforce over HTTP.',
            },
          ],
        },
      ],
    },
  },
);
