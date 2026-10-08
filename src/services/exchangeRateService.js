'use strict';
// services/exchangeRateService.js
//
// Exchange rates from NBP (table A, mid rates), stored globally in
// nbp_exchange_rates and shared by all tenants.
//
// The stored range is kept contiguous: the periodic job extends it up to
// today, an on-demand backfill extends it into the past. Everything between
// the oldest and the newest stored day is therefore complete, and a day
// without a row is a day NBP published no table (weekend, holiday).
//
// Lookup rule (Polish accounting practice): the rate for a document dated D is
// the one published on the last business day BEFORE D.

const db = require('../config/database');
const logger = require('../utils/logger');

const NBP_TABLE_URL       = 'https://api.nbp.pl/api/exchangerates/tables/A';
const NBP_TIME_ZONE       = 'Europe/Warsaw';
const NBP_TIMEOUT_MS      = 15000;
// NBP refuses ranges longer than 93 days.
const NBP_MAX_RANGE_DAYS  = 90;
// A first run on an empty table fits in one NBP request.
const INITIAL_SYNC_DAYS   = NBP_MAX_RANGE_DAYS - 1;
// The longest run of days without a table is a holiday bridge of a few days,
// so a rate older than this cannot be "the last business day before".
const MAX_RATE_AGE_DAYS   = 10;
// Bounds how many NBP calls a single request for an old date may trigger.
const MAX_BACKFILL_DAYS   = 3 * 366;
const BASE_CURRENCY       = 'PLN';
const CURRENCY_RE         = /^[A-Z]{3}$/;
const ISO_DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;

const warsawDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NBP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function todayInWarsaw() {
  return warsawDateFormat.format(new Date());
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

function splitIntoRanges(fromDate, toDate) {
  const ranges = [];
  for (let start = fromDate; start <= toDate; start = addDays(start, NBP_MAX_RANGE_DAYS)) {
    const end = addDays(start, NBP_MAX_RANGE_DAYS - 1);
    ranges.push({ from: start, to: end < toDate ? end : toDate });
  }
  return ranges;
}

// The response comes from outside the system, so only well-formed rows are kept.
function parseNbpTables(tables) {
  if (!Array.isArray(tables)) throw new Error('Unexpected NBP response');
  const rates = [];
  for (const table of tables) {
    if (!ISO_DATE_RE.test(table?.effectiveDate || '') || !Array.isArray(table.rates)) continue;
    for (const entry of table.rates) {
      if (!CURRENCY_RE.test(entry?.code || '')) continue;
      if (typeof entry.mid !== 'number' || !Number.isFinite(entry.mid) || entry.mid <= 0) continue;
      rates.push({ currency: entry.code, rate_date: table.effectiveDate, mid_rate: entry.mid });
    }
  }
  return rates;
}

async function fetchNbpRates(fromDate, toDate) {
  const response = await fetch(`${NBP_TABLE_URL}/${fromDate}/${toDate}/?format=json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(NBP_TIMEOUT_MS),
  });
  // NBP answers 404 when no table was published in the range.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`NBP API answered ${response.status}`);
  return parseNbpTables(await response.json());
}

async function storeRates(rates) {
  if (!rates.length) return;
  await db.query(
    `INSERT INTO nbp_exchange_rates (currency, rate_date, mid_rate)
     SELECT * FROM unnest($1::text[], $2::date[], $3::numeric[])
     ON CONFLICT (currency, rate_date) DO UPDATE SET mid_rate = EXCLUDED.mid_rate`,
    [
      rates.map((rate) => rate.currency),
      rates.map((rate) => rate.rate_date),
      rates.map((rate) => rate.mid_rate),
    ],
  );
}

// Fetches and stores every table published between the two dates (inclusive).
// Safe to repeat: rows are upserted. Returns the number of rates stored.
async function syncRates(fromDate, toDate) {
  let storedCount = 0;
  for (const range of splitIntoRanges(fromDate, toDate)) {
    const rates = await fetchNbpRates(range.from, range.to);
    await storeRates(rates);
    storedCount += rates.length;
  }
  return storedCount;
}

async function getStoredRange() {
  const { rows: [range] } = await db.query(
    'SELECT MIN(rate_date) AS oldest, MAX(rate_date) AS newest FROM nbp_exchange_rates',
  );
  return range;
}

// Brings the stored range up to today. Called by the periodic job.
async function syncMissingRates() {
  const today = todayInWarsaw();
  const { newest } = await getStoredRange();
  const fromDate = newest ? addDays(newest, 1) : addDays(today, -INITIAL_SYNC_DAYS);
  if (fromDate > today) return 0;
  return syncRates(fromDate, today);
}

async function findStoredRate(currency, beforeDate) {
  const { rows: [stored] } = await db.query(
    `SELECT mid_rate::float AS rate, rate_date
     FROM nbp_exchange_rates
     WHERE currency = $1 AND rate_date < $2 AND rate_date >= $3
     ORDER BY rate_date DESC
     LIMIT 1`,
    [currency, beforeDate, addDays(beforeDate, -MAX_RATE_AGE_DAYS)],
  );
  return stored || null;
}

// Extends the stored range into the past so that it covers `beforeDate`.
// It always reaches up to the oldest stored day — a gap would make a later
// lookup return a rate that is not the newest one before its date.
async function backfillBefore(beforeDate) {
  const today = todayInWarsaw();
  const fromDate = addDays(beforeDate, -MAX_RATE_AGE_DAYS);
  const { oldest } = await getStoredRange();
  if (oldest && fromDate >= oldest) return;
  const toDate = oldest ? addDays(oldest, -1) : today;
  if (daysBetween(fromDate, toDate) > MAX_BACKFILL_DAYS) return;
  try {
    await syncRates(fromDate, toDate);
  } catch (err) {
    logger.warn('[exchange-rates] Backfill failed', { fromDate, toDate, error: err.message });
  }
}

function assertCurrencyCode(currency) {
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    throw httpError(400, 'Invalid currency code');
  }
}

// PLN price of one unit of `currency` for a document dated `date`
// ("YYYY-MM-DD"). Throws a 4xx when no rate is available — never guesses.
async function getRate(currency, date) {
  assertCurrencyCode(currency);
  if (!ISO_DATE_RE.test(date || '')) throw httpError(400, 'Invalid exchange rate date');
  if (currency === BASE_CURRENCY) return { rate: 1, rate_date: null };

  // For a date in the future the newest table published so far is the answer.
  const tomorrow = addDays(todayInWarsaw(), 1);
  const beforeDate = date > tomorrow ? tomorrow : date;

  let stored = await findStoredRate(currency, beforeDate);
  if (!stored) {
    await backfillBefore(beforeDate);
    stored = await findStoredRate(currency, beforeDate);
  }
  if (!stored) throw httpError(422, `No NBP exchange rate available for ${currency} on ${date}`);
  return stored;
}

// Price of one unit of `fromCurrency` in `toCurrency` for a document dated
// `date`. Two foreign currencies are converted through PLN.
async function getCrossRate(fromCurrency, toCurrency, date) {
  assertCurrencyCode(fromCurrency);
  assertCurrencyCode(toCurrency);
  if (fromCurrency === toCurrency) return { rate: 1, rate_date: null };
  const [source, target] = await Promise.all([getRate(fromCurrency, date), getRate(toCurrency, date)]);
  return { rate: source.rate / target.rate, rate_date: source.rate_date || target.rate_date };
}

// Rates of the newest stored table as { EUR: 4.25, ... }; empty when nothing
// has been stored yet. Never calls NBP.
async function getLatestRates() {
  const { rows } = await db.query(
    `SELECT currency, mid_rate::float AS rate
     FROM nbp_exchange_rates
     WHERE rate_date = (SELECT MAX(rate_date) FROM nbp_exchange_rates)`,
  );
  return Object.fromEntries(rows.map((row) => [row.currency, row.rate]));
}

// Newest known price of one unit of `fromCurrency` in `toCurrency`, or null
// when either currency has no stored rate.
async function getLatestCrossRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1;
  const latest = { ...(await getLatestRates()), [BASE_CURRENCY]: 1 };
  if (!latest[fromCurrency] || !latest[toCurrency]) return null;
  return latest[fromCurrency] / latest[toCurrency];
}

module.exports = {
  parseNbpTables,
  splitIntoRanges,
  fetchNbpRates,
  syncRates,
  syncMissingRates,
  getRate,
  getCrossRate,
  getLatestRates,
  getLatestCrossRate,
};
