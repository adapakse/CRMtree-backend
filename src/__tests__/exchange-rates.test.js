'use strict';

// Exchange rates against the real database: the "last business day before"
// lookup rule, weekend gaps, cross rates, missing rates, on-demand backfill and
// the rates the sales reports use.
//
// nbp_exchange_rates is a global table, so the fixtures live in 1999 — before
// the NBP archive starts (2002) — and never collide with real rates. The NBP
// API is always replaced.

const db = require('../config/database');
const exchangeRateService = require('../services/exchangeRateService');
const salesMetrics = require('../services/crmSalesMetricsService');

const FIXTURE_ERA_END = '2000-01-01';
const SLUG = 'zz-exchange-rates-test';

// 1999-03-06 and 07 are a weekend.
const FIXTURE_RATES = [
  ['EUR', '1999-03-04', 4.00], ['USD', '1999-03-04', 3.50],
  ['EUR', '1999-03-05', 4.10], ['USD', '1999-03-05', 3.60],
  ['EUR', '1999-03-08', 4.20], ['USD', '1999-03-08', 3.70],
];

let fetchSpy;
let tenantId;

async function clearFixtures() {
  await db.query('DELETE FROM nbp_exchange_rates WHERE rate_date < $1', [FIXTURE_ERA_END]);
}

function nbpAnswers(status, payload) {
  fetchSpy.mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => payload });
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Exchange Rates Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
});

beforeEach(async () => {
  await clearFixtures();
  for (const [currency, rateDate, midRate] of FIXTURE_RATES) {
    await db.query(
      'INSERT INTO nbp_exchange_rates (currency, rate_date, mid_rate) VALUES ($1, $2, $3)',
      [currency, rateDate, midRate],
    );
  }
  fetchSpy = jest.spyOn(global, 'fetch');
  nbpAnswers(404, null);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await clearFixtures();
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

describe('rate for a date', () => {
  test('is the one published on the previous business day, never on the day itself', async () => {
    expect(await exchangeRateService.getRate('EUR', '1999-03-05')).toEqual({ rate: 4.00, rate_date: '1999-03-04' });
    expect(await exchangeRateService.getRate('EUR', '1999-03-09')).toEqual({ rate: 4.20, rate_date: '1999-03-08' });
  });

  test('a Monday, a Saturday and a Sunday all use the Friday rate', async () => {
    for (const date of ['1999-03-06', '1999-03-07', '1999-03-08']) {
      expect(await exchangeRateService.getRate('USD', date)).toEqual({ rate: 3.60, rate_date: '1999-03-05' });
    }
  });

  test('PLN is always 1 and needs no table', async () => {
    await clearFixtures();
    expect(await exchangeRateService.getRate('PLN', '1999-03-08')).toEqual({ rate: 1, rate_date: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a stored rate is used without calling NBP', async () => {
    await exchangeRateService.getRate('EUR', '1999-03-08');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('cross rates', () => {
  test('two foreign currencies are converted through PLN', async () => {
    const cross = await exchangeRateService.getCrossRate('EUR', 'USD', '1999-03-08');
    expect(cross.rate).toBeCloseTo(4.10 / 3.60, 10);
    expect(cross.rate_date).toBe('1999-03-05');
  });

  test('to and from PLN, and a currency against itself', async () => {
    expect((await exchangeRateService.getCrossRate('EUR', 'PLN', '1999-03-08')).rate).toBe(4.10);
    expect((await exchangeRateService.getCrossRate('PLN', 'EUR', '1999-03-08')).rate).toBeCloseTo(1 / 4.10, 10);
    expect(await exchangeRateService.getCrossRate('EUR', 'EUR', '1999-03-08')).toEqual({ rate: 1, rate_date: null });
  });
});

describe('missing rates', () => {
  test('a rate that is too old is not used — the caller gets a 4xx, never a silent 1', async () => {
    await expect(exchangeRateService.getRate('EUR', '1999-03-25'))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('EUR') });
  });

  test('a currency NBP does not publish is a 4xx', async () => {
    await expect(exchangeRateService.getRate('XXX', '1999-03-08')).rejects.toMatchObject({ status: 422 });
    await expect(exchangeRateService.getCrossRate('EUR', 'XXX', '1999-03-08')).rejects.toMatchObject({ status: 422 });
  });

  test('a malformed currency code or date is a 400', async () => {
    await expect(exchangeRateService.getRate('eur', '1999-03-08')).rejects.toMatchObject({ status: 400 });
    await expect(exchangeRateService.getRate('EUR', '08.03.1999')).rejects.toMatchObject({ status: 400 });
  });
});

describe('backfill on demand', () => {
  const OLDER_TABLE = [{ effectiveDate: '1999-02-09', rates: [{ code: 'EUR', mid: 3.95 }] }];

  test('a date older than everything stored is fetched, up to the oldest stored day', async () => {
    nbpAnswers(200, OLDER_TABLE);

    expect(await exchangeRateService.getRate('EUR', '1999-02-10')).toEqual({ rate: 3.95, rate_date: '1999-02-09' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/1999-01-31/1999-03-03/');

    fetchSpy.mockClear();
    expect((await exchangeRateService.getRate('EUR', '1999-02-10')).rate).toBe(3.95);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('NBP being unreachable ends in a 4xx, not a crash', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(exchangeRateService.getRate('EUR', '1999-02-10')).rejects.toMatchObject({ status: 422 });
  });

  test('storing the same table twice keeps one row per currency and day', async () => {
    nbpAnswers(200, OLDER_TABLE);
    await exchangeRateService.syncRates('1999-02-01', '1999-02-10');
    nbpAnswers(200, [{ effectiveDate: '1999-02-09', rates: [{ code: 'EUR', mid: 3.96 }] }]);
    await exchangeRateService.syncRates('1999-02-01', '1999-02-10');

    const { rows } = await db.query(
      `SELECT mid_rate::float AS rate FROM nbp_exchange_rates WHERE currency = 'EUR' AND rate_date = '1999-02-09'`,
    );
    expect(rows).toEqual([{ rate: 3.96 }]);
  });
});

describe('rates used by the sales reports', () => {
  const FALLBACK = { EUR: 4.25, USD: 3.90, GBP: 4.90, CHF: 4.20 };

  test('newest NBP table first, the old constants only where NBP has nothing', async () => {
    const latest = await exchangeRateService.getLatestRates();
    const rates = await salesMetrics.loadExchangeRates();
    for (const currency of Object.keys(FALLBACK)) {
      expect(rates[currency]).toBe(latest[currency] ?? FALLBACK[currency]);
    }
  });

  test('the newest table is the one with the latest date', async () => {
    const { rows: [{ newest }] } = await db.query('SELECT MAX(rate_date) AS newest FROM nbp_exchange_rates');
    const { rows } = await db.query(
      'SELECT currency, mid_rate::float AS rate FROM nbp_exchange_rates WHERE rate_date = $1', [newest],
    );
    expect(await exchangeRateService.getLatestRates())
      .toEqual(Object.fromEntries(rows.map((row) => [row.currency, row.rate])));
  });

  test('the constants are used only for currencies missing from the newest table', async () => {
    jest.spyOn(exchangeRateService, 'getLatestRates').mockResolvedValue({ EUR: 4.31 });
    expect(await salesMetrics.loadExchangeRates()).toEqual({ EUR: 4.31, USD: 3.90, GBP: 4.90, CHF: 4.20 });
  });

  test('a leftover exchange_rate_* tenant setting no longer overrides NBP', async () => {
    await db.query(
      `INSERT INTO app_settings (tenant_id, key, value, value_type, label, category)
       VALUES ($1, 'exchange_rate_eur', '9.99', 'number', 'Kurs EUR / PLN', 'crm')
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [tenantId],
    );
    expect((await salesMetrics.loadExchangeRates()).EUR).not.toBe(9.99);
  });
});
