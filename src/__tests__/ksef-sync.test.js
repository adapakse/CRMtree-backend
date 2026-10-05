'use strict';

// KSeF read side below the HTTP routes: the API client (authentication, 429
// handling), export packages (hash checks, decryption) and the sync service
// (windows, cursor, storing invoices, token status, the per-company lock).
//
// No real network: global.fetch is replaced by the fake KSeF from
// helpers/ksefMock.js, which does real RSA / AES work. Everything is created
// under one dedicated test tenant and cleaned up by tenant_id.

const crypto = require('crypto');
const db = require('../config/database');
const { encrypt } = require('../utils/encrypt');
const ksefApiClient = require('../services/ksefApiClient');
const ksefPackage = require('../services/ksefPackage');
const ksefSyncService = require('../services/ksefSyncService');
const { createKsefMock, encryptParts, buildZip } = require('./helpers/ksefMock');

const SLUG = 'zz-ksef-sync-test';
const BUYER_NIP = '3430714583';
const SELLER_NIP = '8976607794';
const DAY_MS = 86_400_000;
const FINANCE_SETTING_KEY = 'projects_finance_enabled';

let tenantId;
let mock;
let sleep;

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

const invoiceXml = ({ number, type = 'VAT', extra = '' }) => `<?xml version="1.0" encoding="utf-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1><DaneIdentyfikacyjne><NIP>${SELLER_NIP}</NIP><Nazwa>Hotel Pod Lipami</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Lipowa 12</AdresL1><AdresL2>00-950 Warszawa</AdresL2></Adres></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>${BUYER_NIP}</NIP><Nazwa>Nabywca</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1></Adres></Podmiot2>
  <Fa><P_1>2026-09-14</P_1><P_2>${number}</P_2><P_6>2026-09-12</P_6><RodzajFaktury>${type}</RodzajFaktury>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Nocleg</P_7><P_8B>1</P_8B><P_11>100.00</P_11></FaWiersz>
    ${extra}
  </Fa>
</Faktura>`;

function invoice(sequence, { metadata = {}, xml } = {}) {
  const number = `FV/TEST/${sequence}`;
  return {
    metadata: {
      ksefNumber: `${SELLER_NIP}-20261003-AAAA0000${String(sequence).padStart(4, '0')}-C7`,
      invoiceNumber: number,
      issueDate: '2026-09-14',
      permanentStorageDate: '2026-10-03T08:33:28.655277+00:00',
      seller: { nip: SELLER_NIP, name: 'Hotel Pod Lipami Sp. z o.o.' },
      buyer: { identifier: { type: 'Nip', value: BUYER_NIP }, name: 'Nabywca' },
      netAmount: 100, grossAmount: 123, vatAmount: 23, currency: 'PLN',
      invoicingMode: 'Offline', invoiceType: 'Vat',
      ...metadata,
    },
    xml: xml === undefined ? invoiceXml({ number }) : xml,
  };
}

async function createCompany({ token = mock.validToken, syncFrom = daysAgo(10), status = 'active', forTenantId = tenantId } = {}) {
  const { rows: [company] } = await db.query(
    `INSERT INTO ksef_companies (tenant_id, nip, token_encrypted, token_hint, sync_from, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [forTenantId, BUYER_NIP, encrypt(token), token.slice(-4), syncFrom, status],
  );
  return company;
}

async function loadCompany(companyId) {
  const { rows: [company] } = await db.query('SELECT * FROM ksef_companies WHERE id = $1', [companyId]);
  return company;
}

async function loadInvoices() {
  const { rows } = await db.query(
    `SELECT *, net_amount::float AS net, vat_amount::float AS vat, gross_amount::float AS gross
     FROM ksef_invoices WHERE tenant_id = $1 ORDER BY ksef_number`,
    [tenantId],
  );
  return rows;
}

const setFinanceSwitch = (value) => db.query(
  `INSERT INTO app_settings (tenant_id, key, value, label, value_type, category)
   VALUES ($1, $2, $3, 'Finanse projektów', 'boolean', 'projects')
   ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
  [tenantId, FINANCE_SETTING_KEY, value],
);

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('KSeF Sync Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.query('DELETE FROM app_settings WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM ksef_invoices WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM ksef_companies WHERE tenant_id = $1', [tenantId]);
  await setFinanceSwitch('true');
  process.env.KSEF_ENVIRONMENT = 'test';
  ksefApiClient.clearPublicKeyCache();
  mock = createKsefMock();
  jest.spyOn(global, 'fetch').mockImplementation(mock.fetch);
  sleep = jest.spyOn(ksefApiClient.timing, 'sleep').mockResolvedValue();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.KSEF_ENVIRONMENT;
});

describe('environment', () => {
  test('the integration is off unless KSEF_ENVIRONMENT names a known environment', () => {
    expect(ksefApiClient.isConfigured()).toBe(true);
    process.env.KSEF_ENVIRONMENT = 'Production';
    expect(ksefApiClient.getEnvironment()).toBe('production');
    process.env.KSEF_ENVIRONMENT = 'staging';
    expect(ksefApiClient.isConfigured()).toBe(false);
    delete process.env.KSEF_ENVIRONMENT;
    expect(ksefApiClient.isConfigured()).toBe(false);
  });

  test('without it a sync does nothing and calls nobody', async () => {
    const company = await createCompany();
    delete process.env.KSEF_ENVIRONMENT;

    expect(await ksefSyncService.syncCompany(company.id)).toEqual({ status: 'not_configured' });
    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('authentication', () => {
  test('challenge, encrypted token, polling and redeem — in that order', async () => {
    const session = await ksefApiClient.authenticate(BUYER_NIP, mock.validToken);

    expect(session).toMatchObject({ accessToken: expect.stringMatching(/^access-/), refreshToken: 'refresh-token' });
    expect(Date.parse(session.accessTokenValidUntil)).toBeGreaterThan(Date.now());
    expect(mock.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /auth/challenge',
      'GET /security/public-key-certificates',
      'POST /auth/ksef-token',
      'GET /auth/AUTH-1',
      'POST /auth/token/redeem',
    ]);
    // The fake accepted the token only because "token|timestampMs" decrypted correctly.
    expect(mock.lastAuthBody).toMatchObject({
      challenge: 'challenge-1', contextIdentifier: { type: 'Nip', value: BUYER_NIP },
    });
    expect(mock.callsTo('POST', '/auth/token/redeem')[0].authorization).toBe('Bearer authentication-token');
  });

  test('the public keys are fetched once and reused', async () => {
    await ksefApiClient.authenticate(BUYER_NIP, mock.validToken);
    await ksefApiClient.authenticate(BUYER_NIP, mock.validToken);
    expect(mock.callsTo('GET', '/security/public-key-certificates')).toHaveLength(1);
  });

  test('a token refused over HTTP is a rejection', async () => {
    const attempt = ksefApiClient.authenticate(BUYER_NIP, 'wrong-token');
    await expect(attempt).rejects.toBeInstanceOf(ksefApiClient.KsefTokenRejectedError);
    await expect(attempt).rejects.not.toThrow(/wrong-token/);
  });

  test('a token refused while the authentication is processed is a rejection too', async () => {
    mock.authRejection = 'status';
    await expect(ksefApiClient.authenticate(BUYER_NIP, mock.validToken))
      .rejects.toThrow(expect.objectContaining({ name: 'KsefTokenRejectedError', message: 'Token revoked — revoked by owner' }));
    expect(mock.callsTo('POST', '/auth/token/redeem')).toHaveLength(0);
  });

  test('a KSeF failure is not a rejection', async () => {
    mock.serverErrorPaths.add('/auth/ksef-token');
    const attempt = ksefApiClient.authenticate(BUYER_NIP, mock.validToken);
    await expect(attempt).rejects.toBeInstanceOf(ksefApiClient.KsefApiError);
    await expect(attempt).rejects.toMatchObject({ status: 500 });
  });

  test('an unreachable KSeF is reported as a KSeF error', async () => {
    global.fetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(ksefApiClient.authenticate(BUYER_NIP, mock.validToken))
      .rejects.toThrow(expect.objectContaining({ name: 'KsefApiError', message: expect.stringContaining('unreachable') }));
  });
});

describe('HTTP 429', () => {
  test('is waited out as told by Retry-After and the call is repeated', async () => {
    mock.rateLimitOnce('POST', '/auth/challenge', 7);

    await ksefApiClient.authenticate(BUYER_NIP, mock.validToken);

    expect(sleep).toHaveBeenCalledWith(7000);
    expect(mock.callsTo('POST', '/auth/challenge')).toHaveLength(2);
  });

  test('a wait longer than a minute ends the call with a rate-limit error', async () => {
    mock.rateLimitOnce('POST', '/auth/challenge', 1800);

    await expect(ksefApiClient.authenticate(BUYER_NIP, mock.validToken))
      .rejects.toMatchObject({ name: 'KsefApiError', status: 429, retryAfterSeconds: 1800 });
    expect(sleep).not.toHaveBeenCalled();
  });

  test('repeated limits give up after a few tries', async () => {
    for (let index = 0; index < 4; index += 1) mock.rateLimitOnce('POST', '/auth/challenge', 1);

    await expect(ksefApiClient.authenticate(BUYER_NIP, mock.validToken)).rejects.toMatchObject({ status: 429 });
    expect(mock.callsTo('POST', '/auth/challenge')).toHaveLength(4);
  });

  test('Retry-After may be seconds or an HTTP date', () => {
    expect(ksefApiClient.parseRetryAfterSeconds('12')).toBe(12);
    expect(ksefApiClient.parseRetryAfterSeconds(null)).toBe(5);
    expect(ksefApiClient.parseRetryAfterSeconds('soon')).toBe(5);
    const inThirtySeconds = new Date(Date.now() + 30_000).toUTCString();
    expect(ksefApiClient.parseRetryAfterSeconds(inThirtySeconds)).toBeGreaterThanOrEqual(28);
    expect(ksefApiClient.parseRetryAfterSeconds(inThirtySeconds)).toBeLessThanOrEqual(31);
  });
});

describe('export package', () => {
  const key = crypto.randomBytes(32);
  const initializationVector = crypto.randomBytes(16);
  const invoices = [invoice(1), invoice(2)];

  function open(parts) {
    const contentByUrl = new Map(parts.map((part) => [part.descriptor.url, part.encrypted]));
    return ksefPackage.openExportPackage({
      // Out of order on purpose: parts are joined by ordinalNumber.
      exportPackage: { parts: parts.map((part) => part.descriptor).reverse() },
      key,
      initializationVector,
      downloadPart: async (part) => contentByUrl.get(part.url),
    });
  }

  test('a ZIP split into separately encrypted parts is verified, decrypted and read', async () => {
    const parts = encryptParts(buildZip(invoices), { key, initializationVector, partCount: 3 });

    const content = await open(parts);

    expect(content.invoices.map((entry) => entry.invoiceNumber)).toEqual(['FV/TEST/1', 'FV/TEST/2']);
    expect([...content.xmlByKsefNumber.keys()]).toEqual(invoices.map((entry) => entry.metadata.ksefNumber));
    expect(content.xmlByKsefNumber.get(invoices[0].metadata.ksefNumber)).toBe(invoices[0].xml);
  });

  test('a part whose encrypted bytes do not match the announced hash is refused', async () => {
    const parts = encryptParts(buildZip(invoices), { key, initializationVector, partCount: 2 });
    parts[1].encrypted = Buffer.concat([parts[1].encrypted, Buffer.from([0])]);

    await expect(open(parts)).rejects.toThrow('KSeF export part 2: encrypted content hash mismatch');
  });

  test('a part that decrypts to something else than announced is refused', async () => {
    const parts = encryptParts(buildZip(invoices), { key, initializationVector });
    parts[0].descriptor.partHash = ksefPackage.sha256Base64(Buffer.from('something else'));

    await expect(open(parts)).rejects.toThrow('KSeF export part 1: decrypted content hash mismatch');
  });
});

describe('windows and cursor', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const from = new Date('2026-10-01T00:00:00Z');
  const boundedTo = new Date('2026-12-30T00:00:00Z');
  const withParts = (fields) => ({ parts: [{ ordinalNumber: 1 }], ...fields });

  test('a window is open-ended unless more than 90 days are outstanding', () => {
    expect(ksefSyncService.planWindow(daysAgoFrom(now, 90), now).to).toBeNull();
    const longAgo = daysAgoFrom(now, 91);
    expect(ksefSyncService.planWindow(longAgo, now)).toEqual({ from: longAgo, to: daysAgoFrom(now, 1) });
  });

  test('empty package: a bounded window moves to its end, an open one stays and finishes', () => {
    for (const emptyPackage of [null, { parts: [] }, { invoiceCount: 0 }]) {
      expect(ksefSyncService.resolveNextCursor({ window: { from, to: boundedTo }, exportPackage: emptyPackage }))
        .toEqual({ cursor: boundedTo, isFinished: false });
      expect(ksefSyncService.resolveNextCursor({ window: { from, to: null }, exportPackage: emptyPackage }))
        .toEqual({ cursor: from, isFinished: true });
    }
  });

  test('truncated: continue from the last invoice included, whatever the window', () => {
    const exportPackage = withParts({
      isTruncated: true,
      lastPermanentStorageDate: '2026-10-03T08:33:28.655+00:00',
      permanentStorageHwmDate: '2026-10-05T11:58:00Z',
    });
    for (const to of [boundedTo, null]) {
      expect(ksefSyncService.resolveNextCursor({ window: { from, to }, exportPackage }))
        .toEqual({ cursor: new Date('2026-10-03T08:33:28.655Z'), isFinished: false });
    }
  });

  test('truncated without progress stops instead of repeating the same export', () => {
    const stuck = withParts({ isTruncated: true, lastPermanentStorageDate: from.toISOString() });
    expect(ksefSyncService.resolveNextCursor({ window: { from, to: null }, exportPackage: stuck }))
      .toEqual({ cursor: from, isFinished: true });
  });

  test('bounded and complete: the window end; open-ended and complete: the high-water mark', () => {
    const exportPackage = withParts({ isTruncated: false, permanentStorageHwmDate: '2026-10-05T11:58:00Z' });
    expect(ksefSyncService.resolveNextCursor({ window: { from, to: boundedTo }, exportPackage }))
      .toEqual({ cursor: boundedTo, isFinished: false });
    expect(ksefSyncService.resolveNextCursor({ window: { from, to: null }, exportPackage }))
      .toEqual({ cursor: new Date('2026-10-05T11:58:00Z'), isFinished: true });
  });

  function daysAgoFrom(date, days) {
    return new Date(date.getTime() - days * DAY_MS);
  }
});

describe('syncing a company', () => {
  test('a first sync walks bounded windows, then an open-ended one up to the high-water mark', async () => {
    const company = await createCompany({ syncFrom: daysAgo(200) });
    const highWaterMark = new Date(Date.now() - 120_000);
    mock.exportScript.push(
      { invoices: [invoice(1)], partCount: 2 },
      { isEmpty: true },
      { invoices: [invoice(2), invoice(3)], permanentStorageHwmDate: highWaterMark.toISOString() },
    );

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toEqual({ status: 'synced', inserted: 3, skipped_corrections: 0, exports: 3 });
    const ranges = mock.exportRequests.map((request) => request.filters.dateRange);
    expect(mock.exportRequests.every((request) => request.filters.subjectType === 'Subject2')).toBe(true);
    expect(ranges.every((range) => range.dateType === 'PermanentStorage' && range.restrictToPermanentStorageHwmDate)).toBe(true);
    expect(Date.parse(ranges[0].from)).toBe(company.sync_from.getTime());
    expect(Date.parse(ranges[0].to)).toBe(company.sync_from.getTime() + 90 * DAY_MS);
    expect(ranges[1].from).toBe(ranges[0].to);
    expect(Date.parse(ranges[1].to)).toBe(company.sync_from.getTime() + 180 * DAY_MS);
    expect(ranges[2].from).toBe(ranges[1].to);
    expect(ranges[2].to).toBeUndefined();

    const synced = await loadCompany(company.id);
    expect(synced).toMatchObject({ status: 'active', last_error: null });
    expect(synced.sync_from.getTime()).toBe(highWaterMark.getTime());
    expect(synced.last_synced_at).not.toBeNull();
    expect(synced.last_attempt_at).not.toBeNull();
    expect(await loadInvoices()).toHaveLength(3);
  });

  test('export parts are downloaded without the Authorization header', async () => {
    const company = await createCompany();
    mock.exportScript.push({ invoices: [invoice(1)], partCount: 2 });

    await ksefSyncService.syncCompany(company.id);

    const downloads = mock.calls.filter((call) => call.path.startsWith('https://ksef-parts'));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((call) => call.authorization === null)).toBe(true);
  });

  test('a run uses at most six exports and keeps the cursor it reached', async () => {
    const company = await createCompany({ syncFrom: daysAgo(900) });

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ status: 'synced', exports: 6 });
    const synced = await loadCompany(company.id);
    expect(synced.sync_from.getTime()).toBe(company.sync_from.getTime() + 6 * 90 * DAY_MS);
  });

  test('a truncated export continues from the last invoice it included', async () => {
    const company = await createCompany();
    const lastIncluded = new Date(Date.now() - 2 * DAY_MS);
    const highWaterMark = new Date(Date.now() - 120_000);
    mock.exportScript.push(
      { invoices: [invoice(1)], isTruncated: true, lastPermanentStorageDate: lastIncluded.toISOString() },
      // The invoice on the edge comes again in the next window.
      { invoices: [invoice(1), invoice(2)], permanentStorageHwmDate: highWaterMark.toISOString() },
    );

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ status: 'synced', inserted: 2, exports: 2 });
    expect(Date.parse(mock.exportRequests[1].filters.dateRange.from)).toBe(lastIncluded.getTime());
    expect((await loadCompany(company.id)).sync_from.getTime()).toBe(highWaterMark.getTime());
    expect(await loadInvoices()).toHaveLength(2);
  });

  test('an empty open-ended window leaves the cursor where it was', async () => {
    const company = await createCompany();

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toEqual({ status: 'synced', inserted: 0, skipped_corrections: 0, exports: 1 });
    expect((await loadCompany(company.id)).sync_from.getTime()).toBe(company.sync_from.getTime());
  });

  test('the cursor never moves backwards', async () => {
    const company = await createCompany({ syncFrom: daysAgo(1) });
    mock.exportScript.push({ invoices: [invoice(1)], permanentStorageHwmDate: daysAgo(5).toISOString() });

    await ksefSyncService.syncCompany(company.id);

    expect((await loadCompany(company.id)).sync_from.getTime()).toBe(company.sync_from.getTime());
  });

  test('an invoice already stored is not inserted again', async () => {
    const company = await createCompany();
    mock.exportScript.push({ invoices: [invoice(1), invoice(1)] }, { invoices: [invoice(1), invoice(2)] });

    const first = await ksefSyncService.syncCompany(company.id);
    const second = await ksefSyncService.syncCompany(company.id);

    expect(first).toMatchObject({ inserted: 1 });
    expect(second).toMatchObject({ inserted: 1 });
    expect((await loadInvoices()).map((row) => row.invoice_number)).toEqual(['FV/TEST/1', 'FV/TEST/2']);
  });

  test('correction invoices are skipped, whichever source names the type', async () => {
    const company = await createCompany();
    mock.exportScript.push({
      invoices: [
        invoice(1),
        invoice(2, { metadata: { invoiceType: 'Kor' } }),
        invoice(3, { metadata: { invoiceType: 'KorZal' } }),
        invoice(4, { metadata: { invoiceType: undefined }, xml: invoiceXml({ number: 'FV/TEST/4', type: 'KOR_ROZ' }) }),
        invoice(5, { metadata: { invoiceType: 'Zal' } }),
      ],
    });

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ inserted: 2, skipped_corrections: 3 });
    expect((await loadInvoices()).map((row) => row.invoice_type)).toEqual(['Vat', 'Zal']);
  });

  test('the raw XML and the parsed fields are stored', async () => {
    const company = await createCompany();
    const paymentXml = `<Rozliczenie><DoZaplaty>123.00</DoZaplaty></Rozliczenie>
      <Platnosc><Zaplacono>1</Zaplacono><DataZaplaty>2026-09-20</DataZaplaty>
        <TerminPlatnosci><Termin>2026-09-28</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci>
        <RachunekBankowy><NrRB>00123456789012345678901234</NrRB></RachunekBankowy></Platnosc>`;
    const full = invoice(1, { xml: invoiceXml({ number: 'FV/TEST/1', extra: paymentXml }) });
    mock.exportScript.push({ invoices: [full, invoice(2, { xml: null })] });

    await ksefSyncService.syncCompany(company.id);

    const [stored, withoutXml] = await loadInvoices();
    expect(stored).toMatchObject({
      tenant_id: tenantId,
      company_id: company.id,
      ksef_number: full.metadata.ksefNumber,
      invoice_number: 'FV/TEST/1',
      invoice_type: 'Vat',
      issue_date: '2026-09-14',
      sale_date: '2026-09-12',
      seller_nip: SELLER_NIP,
      seller_name: 'Hotel Pod Lipami Sp. z o.o.',
      seller_address: 'ul. Lipowa 12, 00-950 Warszawa',
      buyer_nip: BUYER_NIP,
      buyer_address: 'ul. Testowa 1',
      net: 100, vat: 23, gross: 123,
      currency: 'PLN',
      payment_due_date: '2026-09-28',
      bank_account: '00123456789012345678901234',
      is_paid: true,
      payment_date: '2026-09-20',
      raw_xml: full.xml,
    });
    expect(Number(stored.amount_due)).toBe(123);
    expect(stored.payment).toMatchObject({ form: '6', due_dates: ['2026-09-28'], is_partially_paid: false });
    expect(stored.lines).toEqual([expect.objectContaining({ name: 'Nocleg', quantity: 1, net_amount: 100 })]);
    expect(stored.metadata).toMatchObject({ invoicingMode: 'Offline' });
    expect(stored.permanent_storage_date.toISOString()).toBe('2026-10-03T08:33:28.655Z');

    // An invoice whose XML is missing from the package is kept from its metadata alone.
    expect(withoutXml).toMatchObject({
      invoice_number: 'FV/TEST/2', raw_xml: null, sale_date: null, payment_due_date: null, is_paid: null,
      seller_address: null, lines: [], payment: null,
    });
  });

  test('VAT of a foreign-currency invoice is gross minus net, not the PLN figure KSeF reports', async () => {
    const company = await createCompany();
    mock.exportScript.push({
      invoices: [invoice(1, { metadata: { currency: 'EUR', netAmount: 162.6, grossAmount: 200, vatAmount: 158.95 } })],
    });

    await ksefSyncService.syncCompany(company.id);

    expect((await loadInvoices())[0]).toMatchObject({ currency: 'EUR', net: 162.6, gross: 200, vat: 37.4 });
  });

  test('an access token about to expire is refreshed before the next export', async () => {
    const company = await createCompany({ syncFrom: daysAgo(200) });
    mock.accessTokenLifetimeMs = 60_000;

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ status: 'synced', exports: 3 });
    expect(mock.counters).toEqual({ authentications: 1, refreshes: 2 });
    const exportTokens = mock.callsTo('POST', '/invoices/exports').map((call) => call.authorization);
    expect(new Set(exportTokens).size).toBe(3);
  });

  test('when the refresh is refused the company authenticates again', async () => {
    const company = await createCompany({ syncFrom: daysAgo(100) });
    mock.accessTokenLifetimeMs = 60_000;
    mock.isRefreshRefused = true;

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ status: 'synced', exports: 2 });
    expect(mock.counters).toEqual({ authentications: 2, refreshes: 0 });
  });

  test('a long-lived access token is reused across windows', async () => {
    const company = await createCompany({ syncFrom: daysAgo(200) });

    await ksefSyncService.syncCompany(company.id);

    expect(mock.counters).toEqual({ authentications: 1, refreshes: 0 });
  });

  test('a rate limit in the middle of a run is waited out', async () => {
    const company = await createCompany();
    mock.exportScript.push({ invoices: [invoice(1)] });
    mock.rateLimitOnce('POST', '/invoices/exports', 3);
    mock.rateLimitOnce('GET', '/invoices/exports/', 2);

    const result = await ksefSyncService.syncCompany(company.id);

    expect(result).toMatchObject({ status: 'synced', inserted: 1 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });
});

describe('token status', () => {
  test('a rejected token makes the company invalid and takes it out of the periodic sync', async () => {
    const company = await createCompany({ token: 'revoked-token' });

    const [result] = await ksefSyncService.syncCompaniesOf({ tenantId });

    expect(result).toMatchObject({ company_id: company.id, status: 'invalid' });
    const failed = await loadCompany(company.id);
    expect(failed).toMatchObject({ status: 'invalid', last_synced_at: null });
    expect(failed.last_error).toContain('Invalid token');
    expect(failed.last_error).not.toContain('revoked-token');
    expect(failed.last_attempt_at).not.toBeNull();

    mock.calls.length = 0;
    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([]);
    expect(await ksefSyncService.syncCompany(company.id)).toEqual({ status: 'invalid' });
    expect(mock.calls).toHaveLength(0);
  });

  test('a token rejected during processing is invalid as well', async () => {
    const company = await createCompany();
    mock.authRejection = 'status';

    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'invalid' });
    expect(await loadCompany(company.id)).toMatchObject({ status: 'invalid', last_error: 'Token revoked — revoked by owner' });
  });

  test('any other failure is an error that the next run retries and clears', async () => {
    const company = await createCompany();
    mock.serverErrorPaths.add('/invoices/exports');

    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'error' });
    const failed = await loadCompany(company.id);
    expect(failed).toMatchObject({ status: 'error', last_synced_at: null });
    expect(failed.last_error).toContain('KSeF answered 500');

    mock.serverErrorPaths.clear();
    mock.exportScript.push({ invoices: [invoice(1)] });
    const [retried] = await ksefSyncService.syncCompaniesOf({ tenantId });

    expect(retried).toMatchObject({ status: 'synced', inserted: 1 });
    expect(await loadCompany(company.id)).toMatchObject({ status: 'active', last_error: null });
  });

  test('a failed export, a corrupted part and an hour-long rate limit are errors, not invalid tokens', async () => {
    const company = await createCompany();

    mock.exportScript.push({ invoices: [invoice(1)], failureCode: 415 });
    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'error' });
    expect((await loadCompany(company.id)).last_error).toContain('KSeF export failed (415)');

    mock.exportScript.push({ invoices: [invoice(1)], corruptPart: true });
    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'error' });
    expect((await loadCompany(company.id)).last_error).toContain('encrypted content hash mismatch');

    mock.rateLimitOnce('POST', '/invoices/exports', 3000);
    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'error' });
    expect((await loadCompany(company.id)).last_error).toContain('rate limit');
    expect(await loadInvoices()).toHaveLength(0);
  });

  test('a failure after the first window keeps the invoices and the cursor of that window', async () => {
    const company = await createCompany({ syncFrom: daysAgo(100) });
    mock.exportScript.push({ invoices: [invoice(1)] }, { invoices: [invoice(2)], failureCode: 500 });

    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'error' });

    expect(await loadInvoices()).toHaveLength(1);
    expect((await loadCompany(company.id)).sync_from.getTime()).toBe(company.sync_from.getTime() + 90 * DAY_MS);
  });
});

describe('who gets synced', () => {
  test('one sync per company at a time, also across database sessions', async () => {
    const company = await createCompany();
    mock.exportScript.push({ invoices: [invoice(1)] });
    const otherProcess = await db.getClient();
    try {
      await otherProcess.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`ksef-sync:${company.id}`]);

      expect(await ksefSyncService.syncCompany(company.id)).toEqual({ status: 'already_running' });
      expect(mock.calls).toHaveLength(0);
      expect((await loadCompany(company.id)).last_attempt_at).toBeNull();

      await otherProcess.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ksef-sync:${company.id}`]);
    } finally {
      otherProcess.release();
    }

    expect(await ksefSyncService.syncCompany(company.id)).toMatchObject({ status: 'synced', inserted: 1 });
  });

  test('two runs started together: one syncs, the other steps aside', async () => {
    const company = await createCompany();
    mock.exportScript.push({ invoices: [invoice(1)] });

    const results = await Promise.all([ksefSyncService.syncCompany(company.id), ksefSyncService.syncCompany(company.id)]);

    expect(results.map((result) => result.status).sort()).toEqual(['already_running', 'synced']);
    expect(mock.exportRequests).toHaveLength(1);
  });

  test('tenants with project finance or the Projects module switched off are not synced', async () => {
    const company = await createCompany();

    await setFinanceSwitch('false');
    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([]);

    await setFinanceSwitch('true');
    await db.query(
      `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', FALSE)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = FALSE`,
      [tenantId],
    );
    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([]);

    await db.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([
      expect.objectContaining({ company_id: company.id, status: 'synced' }),
    ]);
  });

  test('"sync now" covers the tenant\'s companies, or the one that was asked for', async () => {
    const company = await createCompany();

    expect(await ksefSyncService.syncCompaniesOf({ tenantId })).toEqual([
      expect.objectContaining({ company_id: company.id, status: 'synced' }),
    ]);
    expect(await ksefSyncService.syncCompaniesOf({ tenantId, companyId: crypto.randomUUID() })).toEqual([]);
    expect(await ksefSyncService.syncCompaniesOf({ tenantId, companyId: company.id })).toHaveLength(1);
  });
});
