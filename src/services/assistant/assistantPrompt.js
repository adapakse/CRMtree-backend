'use strict';
// services/assistant/assistantPrompt.js — what the form assistants share:
// the language they answer in, and a calendar for the model to look dates
// up in (it must never work out weekdays itself — it gets them wrong).

const LANGUAGE_NAMES = {
  pl: 'Polish', en: 'English', de: 'German', it: 'Italian', es: 'Spanish',
  fr: 'French', ro: 'Romanian', ru: 'Russian', sl: 'Slovenian', hr: 'Croatian',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;

// Noon UTC keeps a date on its own day whatever the server's time zone.
const atNoon = (isoDate) => new Date(`${isoDate}T12:00:00Z`);

function weekday(isoDate) {
  return WEEKDAYS[atNoon(isoDate).getUTCDay()];
}

function shiftDays(isoDate, days) {
  return new Date(atNoon(isoDate).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** `days` lines of "YYYY-MM-DD Weekday", starting at `fromIsoDate`. */
function calendar(fromIsoDate, days) {
  return Array.from({ length: days }, (_, index) => {
    const day = shiftDays(fromIsoDate, index);
    return `${day} ${weekday(day)}`;
  }).join('\n');
}

/** "1: Anna Nowak" lines; the model picks by number, never by a long id. */
function numberedList(options) {
  return options.map((option, index) => `${index + 1}: ${option.name}`).join('\n') || '(none)';
}

/** The option the model picked by its number in `numberedList`, or null. */
function optionByNumber(options, number) {
  return Number.isInteger(number) && number >= 1 && number <= options.length ? options[number - 1] : null;
}

const trimmedOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

module.exports = { LANGUAGE_NAMES, weekday, shiftDays, calendar, numberedList, optionByNumber, trimmedOrNull };
