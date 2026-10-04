'use strict';
// Guards the translation files. Run with `npm run i18n:check`; the same checks
// run in Jest (src/__tests__/i18n-completeness.test.js). Port of the
// frontend's scripts/i18n-check.mjs.
//
// Layout: src/i18n/<scope>/<lang>.json, Polish (pl) being the source language.
// Checks, per scope:
//   1. every supported language has a file;
//   2. every language has exactly the keys of the Polish file, none empty;
//   3. every text uses the same {placeholders} as the Polish text;
//   4. every text is valid ICU message syntax for its language (a broken
//      plural would otherwise only show up when a mail is sent);
//   5. files are formatted canonically (sorted keys, 2 spaces) so diffs and
//      merges stay line-based.
//
// `--fix` rewrites the files into the canonical format instead of failing on 5.

const fs = require('fs');
const path = require('path');
const MessageFormat = require('@messageformat/core');
const { SUPPORTED_LOCALES, DEFAULT_LOCALE: SOURCE_LOCALE } = require('../src/config/locales');

const I18N_DIR = path.join(__dirname, '..', 'src', 'i18n');

function sortDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
}

const canonical = (content) => JSON.stringify(sortDeep(content), null, 2) + '\n';

function flatten(node, prefix = '') {
  const entries = new Map();
  for (const [key, value] of Object.entries(node)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      for (const [childPath, childValue] of flatten(value, keyPath)) entries.set(childPath, childValue);
    } else {
      entries.set(keyPath, value);
    }
  }
  return entries;
}

// Top-level ICU arguments of a message: {name}, {count, plural, ...}.
function placeholdersOf(text) {
  const names = new Set();
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{') {
      if (depth === 0) {
        const name = text.slice(index + 1).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
        if (name) names.add(name[1]);
      }
      depth++;
    } else if (text[index] === '}') {
      depth--;
    }
  }
  return [...names].sort().join(',');
}

function listScopes() {
  return fs.readdirSync(I18N_DIR).filter((name) => fs.statSync(path.join(I18N_DIR, name)).isDirectory());
}

function checkScope(scope, { shouldFix, report }) {
  const displayPath = (locale) => `src/i18n/${scope}/${locale}.json`;
  const readJson = (locale) => {
    const raw = fs.readFileSync(path.join(I18N_DIR, scope, `${locale}.json`), 'utf8');
    try {
      return { raw, content: JSON.parse(raw) };
    } catch (error) {
      report(`${displayPath(locale)}: invalid JSON (${error.message})`);
      return null;
    }
  };
  const exists = (locale) => fs.existsSync(path.join(I18N_DIR, scope, `${locale}.json`));

  if (!exists(SOURCE_LOCALE)) {
    report(`${scope}: missing source file ${SOURCE_LOCALE}.json`);
    return;
  }
  const source = readJson(SOURCE_LOCALE);
  if (!source) return;
  const sourceEntries = flatten(source.content);

  for (const locale of SUPPORTED_LOCALES) {
    const filePath = displayPath(locale);
    if (!exists(locale)) {
      report(`${scope}: missing ${locale}.json`);
      continue;
    }
    const file = readJson(locale);
    if (!file) continue;

    if (file.raw.replace(/\r\n/g, '\n') !== canonical(file.content)) {
      if (shouldFix) fs.writeFileSync(path.join(I18N_DIR, scope, `${locale}.json`), canonical(file.content));
      else report(`${filePath}: not in canonical format — run "npm run i18n:check -- --fix"`);
    }

    const entries = flatten(file.content);
    const messageFormat = new MessageFormat(locale);
    for (const [key, text] of entries) {
      if (typeof text !== 'string') continue;
      try {
        messageFormat.compile(text);
      } catch (error) {
        report(`${filePath}: "${key}" is not valid ICU syntax (${error.message})`);
      }
    }
    for (const [key, sourceText] of sourceEntries) {
      const text = entries.get(key);
      if (typeof text !== 'string' || text.trim() === '') {
        report(`${filePath}: missing or empty "${key}"`);
      } else if (placeholdersOf(text) !== placeholdersOf(sourceText)) {
        report(`${filePath}: "${key}" uses different placeholders than the Polish text`);
      }
    }
    for (const key of entries.keys()) {
      if (!sourceEntries.has(key)) report(`${filePath}: "${key}" does not exist in the Polish file`);
    }
  }
}

function checkTranslations({ shouldFix = false } = {}) {
  const problems = [];
  const scopes = listScopes();
  for (const scope of scopes) checkScope(scope, { shouldFix, report: (message) => problems.push(message) });
  return { problems, scopes };
}

if (require.main === module) {
  const { problems, scopes } = checkTranslations({ shouldFix: process.argv.includes('--fix') });
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\ni18n check failed: ${problems.length} problem(s) in ${scopes.length} scope(s).`);
    process.exit(1);
  }
  console.log(`i18n check passed: ${scopes.length} scope(s) × ${SUPPORTED_LOCALES.length} languages.`);
}

module.exports = { checkTranslations };
