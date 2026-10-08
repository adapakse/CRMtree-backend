'use strict';
// config/locales.js
//
// Interface languages of CRMtree. Polish is the source language: every text
// exists in Polish first and a missing translation falls back to it.
// Keep in sync with migration 0312 and the frontend's core/i18n/locales.ts.

const SUPPORTED_LOCALES = ['pl', 'en', 'de', 'it', 'es', 'fr', 'ro', 'ru', 'sl', 'hr'];
const DEFAULT_LOCALE = 'pl';

function isSupportedLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale);
}

// The language to address a person in: their own choice, else their tenant's default.
function resolveLocale({ userLocale, tenantDefaultLocale } = {}) {
  if (isSupportedLocale(userLocale)) return userLocale;
  if (isSupportedLocale(tenantDefaultLocale)) return tenantDefaultLocale;
  return DEFAULT_LOCALE;
}

module.exports = { SUPPORTED_LOCALES, DEFAULT_LOCALE, isSupportedLocale, resolveLocale };
