// ESLint v9 flat config — minimal but with the CRITICAL guardrails.
//
// History: iter19 shipped Operator.jsx with a missing import for
// EmergencyLockdownPill. JSX compiled to React.createElement of an
// undefined identifier → ReferenceError → ErrorBoundary masked it as
// "Something broke on this page". The entire operator console was
// unreachable until iter20 (one-line import fix).
//
// This config exists primarily so `react/jsx-no-undef` blocks that
// specific failure mode at CI time. Everything else is intentionally
// permissive — we don't want to drown the repo in stylistic warnings
// during a rapid-iteration product phase.
import js from '@eslint/js';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

export default [
  // Files we don't lint at all.
  {
    ignores: [
      'build/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.next/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      // Browser + ES globals — minimal set, just enough that `window`,
      // `document`, `fetch`, `console`, `localStorage`, `setInterval`
      // don't trip `no-undef`.
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        fetch: 'readonly', console: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly',
        FormData: 'readonly', Headers: 'readonly', Request: 'readonly',
        Response: 'readonly', sessionStorage: 'readonly', localStorage: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        atob: 'readonly', btoa: 'readonly', alert: 'readonly',
        confirm: 'readonly', prompt: 'readonly', process: 'readonly',
        AbortController: 'readonly', queueMicrotask: 'readonly',
        crypto: 'readonly', performance: 'readonly',
        // Node test/jest contexts — keep linting happy in case any
        // legacy tests stay co-located with source.
        global: 'readonly', module: 'readonly', require: 'readonly',
        Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    settings: { react: { version: '19.0.0' } },
    rules: {
      // ----- Critical guard-rails (errors) ------------------------------
      // The reason this file exists. Catches the iter19 crash mode.
      'react/jsx-no-undef': 'error',
      // Catches plain JS references to undeclared identifiers.
      'no-undef': 'error',
      // No undeclared imports / circular deps that compile but blow up
      // at runtime.
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',

      // ----- Common React mistakes (errors) -----------------------------
      'react/jsx-uses-react': 'off',          // React 17+ JSX transform
      'react/react-in-jsx-scope': 'off',      // React 17+ JSX transform
      'react/jsx-uses-vars': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-children-prop': 'error',

      // ----- Hooks correctness ------------------------------------------
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps off — too noisy on our SSE handlers + intentional
      // omissions. Trust devs; rely on tests.
      'react-hooks/exhaustive-deps': 'off',
      // set-state-in-effect — false-positives on action handlers in
      // v5.2.0 (see iter16). Off until the plugin's rule stabilises.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',

      // ----- Hygiene (warnings) -----------------------------------------
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^(_|React$)',  // React 19 automatic JSX runtime — import remains for type-narrowing
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-console': 'off',  // we use console.warn deliberately
      'react/prop-types': 'off',  // not running PropTypes
      'react/display-name': 'off',
    },
  },
];
