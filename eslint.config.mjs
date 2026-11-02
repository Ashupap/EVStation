import typescriptEslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default typescriptEslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      'third_party/**',
    ],
  },
  ...typescriptEslint.configs.recommended,
  // Must be last: disables stylistic rules that conflict with Prettier.
  prettierConfig,
);
