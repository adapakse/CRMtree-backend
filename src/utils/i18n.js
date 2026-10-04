'use strict';
// utils/i18n.js
//
// Texts the backend writes itself (e-mails for now), in the language of the
// person they are addressed to. Files: src/i18n/<scope>/<lang>.json, the scope
// being the first segment of a key ("emails.taskAssigned.subject"). Same
// conventions as the frontend: nested JSON, ICU message syntax, Polish as the
// source language. Rules and glossary: crmtree-frontend/docs/i18n.md.

const fs = require('fs');
const path = require('path');
const MessageFormat = require('@messageformat/core');
const { DEFAULT_LOCALE, isSupportedLocale } = require('../config/locales');
const logger = require('./logger');

const I18N_DIR = path.join(__dirname, '..', 'i18n');

// English is read by a European audience: day before month, 24-hour clock.
const INTL_LOCALE_TAGS = { en: 'en-GB' };

const DATE_OPTIONS = { day: '2-digit', month: '2-digit', year: 'numeric' };
const DATE_TIME_OPTIONS = { ...DATE_OPTIONS, hour: '2-digit', minute: '2-digit' };

const scopeFiles = new Map();
const compiledMessages = new Map();

function supportedOrDefault(locale) {
  return isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
}

function loadScopeFile(scope, locale) {
  const cacheKey = `${scope}/${locale}`;
  if (!scopeFiles.has(cacheKey)) {
    let content = {};
    try {
      content = JSON.parse(fs.readFileSync(path.join(I18N_DIR, scope, `${locale}.json`), 'utf8'));
    } catch (error) {
      // A language that is not translated yet has no file; that is the normal fallback path.
      if (error.code !== 'ENOENT') logger.error('i18n: unreadable translation file', { scope, locale, error: error.message });
    }
    scopeFiles.set(cacheKey, content);
  }
  return scopeFiles.get(cacheKey);
}

function findText(locale, key) {
  const [scope, ...segments] = key.split('.');
  let node = loadScopeFile(scope, locale);
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' && node.trim() !== '' ? node : undefined;
}

function compileMessage(locale, key) {
  const cacheKey = `${locale}:${key}`;
  if (!compiledMessages.has(cacheKey)) {
    const text = findText(locale, key);
    let compiled = null;
    if (text !== undefined) {
      try {
        compiled = new MessageFormat(locale).compile(text);
      } catch (error) {
        logger.error('i18n: invalid ICU message', { locale, key, error: error.message });
      }
    }
    compiledMessages.set(cacheKey, compiled);
  }
  return compiledMessages.get(cacheKey);
}

// Never throws: a mail in Polish, or even with a raw key in it, is better than no mail.
function translate(locale, key, params = {}) {
  const message = compileMessage(supportedOrDefault(locale), key) || compileMessage(DEFAULT_LOCALE, key);
  if (!message) return key;
  try {
    return message(params);
  } catch (error) {
    logger.error('i18n: message could not be rendered', { locale, key, error: error.message });
    return key;
  }
}

// No explicit time zone: dates are printed in the time zone of the server
// process, exactly as before the mails were translated.
function formatDate(locale, value, options = DATE_OPTIONS) {
  const language = supportedOrDefault(locale);
  return new Date(value).toLocaleDateString(INTL_LOCALE_TAGS[language] || language, options);
}

function formatDateTime(locale, value) {
  const language = supportedOrDefault(locale);
  return new Date(value).toLocaleString(INTL_LOCALE_TAGS[language] || language, DATE_TIME_OPTIONS);
}

module.exports = { translate, formatDate, formatDateTime, supportedOrDefault };
