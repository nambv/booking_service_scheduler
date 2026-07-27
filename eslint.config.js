import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Build tooling declares itself through default exports and lives outside the
  // TypeScript project, so the project-wide conventions do not apply here.
  {
    files: ['**/*.config.ts', '**/*.config.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-restricted-exports': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  // The domain layer must not reach outward. This is the architectural rule from
  // CLAUDE.md section 3 expressed as a lint error rather than a review convention.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/config/**'],
              message: 'domain/ must not import from outer layers.',
            },
          ],
        },
      ],
    },
  },
);
