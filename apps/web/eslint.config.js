// Flat config (ESLint 9). Keep it small — strict TS via tsc, lint just the obvious bugs.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist', 'build', '.turbo', 'node_modules'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The base rule must be off whenever the TS version is on: it doesn't
      // understand type positions, so it reports every named parameter in a
      // function *type* ("load: (ctx: LoadCtx) => …") as an unused variable,
      // and it ignores the argsIgnorePattern configured below.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'off',
    },
  },
  {
    // =====================================================================
    // The guest play entry's bundle boundary.
    //
    // src/play/** is a SEPARATE Vite entry precisely so a guest scanning a
    // table tent doesn't download the 1.1MB admin app. That property is a
    // build-config invariant, not a code one: a single stray import from
    // '@/lib/api' pulls in the authed client, the auth store and the whole
    // admin entry graph, the page silently goes back to a multi-second load,
    // and nothing else in CI notices.
    //
    // This rule and the e2e byte-budget assertion are the two things that keep
    // it true after everyone has forgotten why it matters.
    // =====================================================================
    files: ['src/play/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react-router-dom', message: 'The play page is one URL — parse the slug from location.pathname (see playApi.slugFromLocation).' },
            { name: '@tanstack/react-query', message: 'The play page uses plain fetch; Query’s cache and persistence buy nothing on a single-visit page.' },
            { name: 'lucide-react', message: 'Importing lucide pulls ~100 icon components into the guest bundle. Use an inline SVG or an emoji.' },
            { name: '@cafe-mgmt/design-tokens', message: 'The play page is self-contained (--pl-* in styles/play.css); it consumes only --brand-primary.' },
          ],
          patterns: [
            {
              group: [
                '@/lib/api',
                '@/lib/auth-store',
                '@/lib/public',
                '@/lib/tenant',
                '@/components/*',
                '@/pages/*',
                '@/layout/*',
                '@/styles/admin.css',
                '@/styles/global.css',
              ],
              message: 'src/play/** must not import from the admin app — it would drag the 1.1MB admin entry graph into the guest bundle. Duplicate the few lines you need instead.',
            },
          ],
        },
      ],
    },
  },
];
