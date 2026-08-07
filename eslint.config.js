import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared clean-code rules (docs/CODE-PATTERNS.md). Applied to every linted
 * file — worker TypeScript, test TypeScript, and the Node scripts.
 */
const cleanCodeRules = {
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'smart'],
  'no-eval': 'error',
  'no-underscore-dangle': 'error',
  'unused-imports/no-unused-imports': 'error',
  'prefer-arrow-callback': 'error',
  'object-shorthand': 'error',
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.wrangler/**', 'dist/**'],
  },
  js.configs.recommended,

  // Worker + test TypeScript (strict-TS codebase — see tsconfig.json).
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.es2021,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      ...cleanCodeRules,
      // Strict-TS gate (docs/CODE-PATTERNS.md → Strict TypeScript): no `any`,
      // no @ts- suppression comments. `unknown` + narrowing instead.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      // Type-aware variants replace the base rules (which false-positive on TS).
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      // Underscore-prefixed vars may be intentionally unused (e.g. the
      // rest-spread idiom that strips a field off an object).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // Vitest suites get the test globals on top of the TS config above.
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },

  // Node integration scripts (including the optional token-savings diagnostic) — inside the lint
  // gate like everything else, with Node globals instead of Worker ones.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      ...cleanCodeRules,
      'no-shadow': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // Root tooling configs (this file + prettier.config.cjs) run under Node.
  {
    files: ['*.js', '*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Disables ESLint rules that conflict with Prettier; keep last.
  prettier,
);
