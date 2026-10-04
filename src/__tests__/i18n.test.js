'use strict';

// The translation helper: language selection, fallbacks, ICU plurals, dates.
// Completeness of the real translation files is checked separately in
// i18n-completeness.test.js.

const fs = require('fs');
const path = require('path');

// A scope that exists only in this test, so the fallback cases do not depend
// on how far the real translations have got. German has no file at all.
const FIXTURE_FILES = {
  pl: {
    both: 'Po polsku {name}',
    onlyPolish: { nested: 'Tylko po polsku' },
    brokenInEnglish: 'Poprawny tekst',
    days: '{count, plural, one {# dzień} few {# dni} many {# dni} other {# dnia}}',
  },
  en: {
    both: 'In English {name}',
    brokenInEnglish: '{count, plural, one {# day}',
    days: '{count, plural, one {# day} other {# days}}',
  },
};

const realReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
  const fixture = String(file).match(/[\\/]fixture[\\/](\w+)\.json$/);
  if (!fixture) return realReadFileSync(file, ...rest);
  if (!FIXTURE_FILES[fixture[1]]) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  return JSON.stringify(FIXTURE_FILES[fixture[1]]);
});

const { translate, formatDate, formatDateTime } = require('../utils/i18n');

describe('translate', () => {
  test('returns the text in the requested language with its parameters filled in', () => {
    expect(translate('pl', 'fixture.both', { name: 'Anna' })).toBe('Po polsku Anna');
    expect(translate('en', 'fixture.both', { name: 'Anna' })).toBe('In English Anna');
  });

  test('an unsupported or absent locale gives Polish', () => {
    for (const locale of ['xx', '', null, undefined]) {
      expect(translate(locale, 'fixture.both', { name: 'Anna' })).toBe('Po polsku Anna');
    }
  });

  test('a key missing in a language falls back to the Polish text', () => {
    expect(translate('en', 'fixture.onlyPolish.nested')).toBe('Tylko po polsku');
  });

  test('a language without a file falls back to the Polish text', () => {
    expect(translate('de', 'fixture.both', { name: 'Anna' })).toBe('Po polsku Anna');
  });

  test('a translation with broken ICU syntax falls back to the Polish text', () => {
    expect(translate('en', 'fixture.brokenInEnglish', { count: 1 })).toBe('Poprawny tekst');
  });

  test('a key missing everywhere comes back as the key instead of throwing', () => {
    expect(translate('en', 'fixture.doesNotExist')).toBe('fixture.doesNotExist');
    expect(translate('en', 'fixture.onlyPolish')).toBe('fixture.onlyPolish');
    expect(translate('en', 'noSuchScope.anything')).toBe('noSuchScope.anything');
    expect(translate('en', 'fixture.constructor')).toBe('fixture.constructor');
  });

  test('plurals follow the rules of each language', () => {
    expect([1, 2, 5, 22].map((count) => translate('pl', 'fixture.days', { count })))
      .toEqual(['1 dzień', '2 dni', '5 dni', '22 dni']);
    expect([1, 2].map((count) => translate('en', 'fixture.days', { count }))).toEqual(['1 day', '2 days']);
  });

  test('reads the real e-mail texts', () => {
    expect(translate('pl', 'emails.taskAssigned.subject', { documentName: 'Umowa' })).toBe('[CRMtree] Nowe zadanie: Umowa');
    expect(translate('en', 'emails.taskAssigned.subject', { documentName: 'Umowa' })).toBe('[CRMtree] New task: Umowa');
    expect(fs.existsSync(path.join(__dirname, '..', 'i18n', 'emails', 'pl.json'))).toBe(true);
  });
});

describe('dates', () => {
  test('a date is written the way the language writes it', () => {
    expect(formatDate('pl', '2026-09-10')).toBe('10.09.2026');
    expect(formatDate('en', '2026-09-10')).toBe('10/09/2026');
    expect(formatDate('xx', '2026-09-10')).toBe('10.09.2026');
  });

  test('date and time are printed in the time zone of the server process', () => {
    const moment = '2026-09-10T12:30:00Z';
    const options = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    expect(formatDateTime('pl', moment)).toBe(new Date(moment).toLocaleString('pl-PL', options));
    expect(formatDateTime('en', moment)).toBe(new Date(moment).toLocaleString('en-GB', options));
    expect(formatDateTime('pl', moment)).toMatch(/^10\.09\.2026, \d{2}:30$/);
  });
});
