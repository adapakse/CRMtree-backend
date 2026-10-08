'use strict';

// Same checks as `npm run i18n:check`, so a normal test run fails on an
// incomplete or malformed translation. Kept apart from i18n.test.js: this is
// the file that goes red when a language is missing.

const { checkTranslations } = require('../../scripts/i18n-check');

test('every scope is translated into all supported languages, consistently with the Polish source', () => {
  expect(checkTranslations().problems).toEqual([]);
});
