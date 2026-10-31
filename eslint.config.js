import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '.firebase/**',
      'dist/assets/**',
      'dist/country-catalogue.js',
      'dist/legacy-countries.js',
      'dist/population-snapshot.js',
    ],
  },
  js.configs.recommended,
  { files: ['dist/**/*.js'], languageOptions: { globals: globals.browser } },
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'tests/**/*.js', 'functions/**/*.js', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/*browser-test.mjs', 'scripts/commentary-preview.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    // These expressions deliberately reject control characters in user/source data.
    files: ['dist/profile.js', 'scripts/build-country-catalogue.mjs'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
