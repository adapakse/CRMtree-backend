'use strict';

// The NBP side of exchangeRateService: request shape, response parsing,
// range splitting and what gets stored. The NBP API and the database are both
// replaced, so this suite runs anywhere; the lookup rule is covered against a
// real database in exchange-rates.test.js.

jest.mock('../config/database', () => ({ query: jest.fn() }));

const db = require('../config/database');
const exchangeRateService = require('../services/exchangeRateService');

const TABLE_A = [
  {
    table: 'A', no: '190/A/NBP/2026', effectiveDate: '2026-09-30',
    rates: [
      { currency: 'euro', code: 'EUR', mid: 4.2511 },
      { currency: 'forint (Węgry)', code: 'HUF', mid: 0.011927 },
    ],
  },
  {
    table: 'A', no: '191/A/NBP/2026', effectiveDate: '2026-10-01',
    rates: [{ currency: 'euro', code: 'EUR', mid: 4.26 }],
  },
];

function nbpAnswers(status, payload) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    status, ok: status >= 200 && status < 300, json: async () => payload,
  });
}

const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const upserts = () => db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO nbp_exchange_rates'));

beforeEach(() => db.query.mockReset());
afterEach(() => jest.restoreAllMocks());

describe('parsing NBP tables', () => {
  test('every rate becomes a row dated with the table’s effective date', () => {
    expect(exchangeRateService.parseNbpTables(TABLE_A)).toEqual([
      { currency: 'EUR', rate_date: '2026-09-30', mid_rate: 4.2511 },
      { currency: 'HUF', rate_date: '2026-09-30', mid_rate: 0.011927 },
      { currency: 'EUR', rate_date: '2026-10-01', mid_rate: 4.26 },
    ]);
  });

  test('malformed entries are skipped, an unexpected payload is an error', () => {
    const rows = exchangeRateService.parseNbpTables([
      { effectiveDate: 'yesterday', rates: [{ code: 'EUR', mid: 4.2 }] },
      { effectiveDate: '2026-10-01', rates: [
        { code: 'eur', mid: 4.2 }, { code: 'USD', mid: '3.9' }, { code: 'CHF', mid: 0 }, { code: 'GBP', mid: 4.9 },
      ] },
    ]);
    expect(rows).toEqual([{ currency: 'GBP', rate_date: '2026-10-01', mid_rate: 4.9 }]);
    expect(() => exchangeRateService.parseNbpTables({ error: 'x' })).toThrow();
  });
});

describe('fetching', () => {
  test('asks for table A in the given range as JSON', async () => {
    const fetchSpy = nbpAnswers(200, TABLE_A);
    const rows = await exchangeRateService.fetchNbpRates('2026-09-30', '2026-10-01');
    expect(fetchSpy.mock.calls[0][0])
      .toBe('https://api.nbp.pl/api/exchangerates/tables/A/2026-09-30/2026-10-01/?format=json');
    expect(rows).toHaveLength(3);
  });

  test('404 means no table in the range, any other failure is an error', async () => {
    nbpAnswers(404, null);
    expect(await exchangeRateService.fetchNbpRates('2026-10-03', '2026-10-04')).toEqual([]);

    jest.restoreAllMocks();
    nbpAnswers(500, null);
    await expect(exchangeRateService.fetchNbpRates('2026-10-03', '2026-10-04')).rejects.toThrow('500');
  });
});

describe('syncing', () => {
  test('a long period is split into ranges NBP accepts, without gaps or overlaps', () => {
    const ranges = exchangeRateService.splitIntoRanges('2026-01-01', '2026-07-15');
    expect(ranges).toEqual([
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-04-01', to: '2026-06-29' },
      { from: '2026-06-30', to: '2026-07-15' },
    ]);
    expect(exchangeRateService.splitIntoRanges('2026-05-05', '2026-05-05'))
      .toEqual([{ from: '2026-05-05', to: '2026-05-05' }]);
  });

  test('fetched rates are upserted in one statement per range', async () => {
    nbpAnswers(200, TABLE_A);
    db.query.mockResolvedValue({ rows: [] });

    expect(await exchangeRateService.syncRates('2026-09-30', '2026-10-01')).toBe(3);

    const [[sql, params]] = upserts();
    expect(sql).toContain('ON CONFLICT (currency, rate_date) DO UPDATE');
    expect(params).toEqual([
      ['EUR', 'HUF', 'EUR'],
      ['2026-09-30', '2026-09-30', '2026-10-01'],
      [4.2511, 0.011927, 4.26],
    ]);
  });

  test('the periodic sync asks only for the days after the newest stored one', async () => {
    const fetchSpy = nbpAnswers(404, null);
    db.query.mockResolvedValue({ rows: [{ oldest: '2026-07-01', newest: '2026-09-28' }] });

    expect(await exchangeRateService.syncMissingRates()).toBe(0);

    expect(fetchSpy.mock.calls[0][0]).toContain(`/2026-09-29/`);
    expect(fetchSpy.mock.calls.at(-1)[0]).toContain(`/${warsawToday()}/?format=json`);
    expect(upserts()).toHaveLength(0);
  });

  test('nothing is requested when today is already stored', async () => {
    const fetchSpy = nbpAnswers(200, TABLE_A);
    db.query.mockResolvedValue({ rows: [{ oldest: '2026-07-01', newest: warsawToday() }] });

    expect(await exchangeRateService.syncMissingRates()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an empty table starts with the recent past, ending today', async () => {
    const fetchSpy = nbpAnswers(404, null);
    db.query.mockResolvedValue({ rows: [{ oldest: null, newest: null }] });

    await exchangeRateService.syncMissingRates();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.at(-1)[0]).toContain(`/${warsawToday()}/?format=json`);
  });
});
