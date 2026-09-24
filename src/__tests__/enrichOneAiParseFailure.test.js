'use strict';

// B1 (audyt Enrichment V2, 23.09) — regresja: gdy odpowiedź AI jest
// niesparsowalna jako JSON, enrichOne() MUSI zakończyć się jako
// enrichment_status='error' (retry-owalny), NIGDY jako 'done' z syntetycznym
// icp_score=0. Przed poprawką analyzeWithAi() po cichu zwracało
// { result: null } dla tej ścieżki, a enrichOne zapisywało to jako pozornie
// ukończony enrichment z zerowym wynikiem, nierozróżnialny w UI/API od
// legalnie słabo dopasowanej firmy — i nigdy niepodejmowany do retry (runBatch
// retry'uje tylko enrichment_status IN ('pending','error')).
//
// Integracyjny (realna lokalna baza, jak reszta testów tenantIcpConfigService/
// admin-tenants-icp) — mockowane są tylko granice zewnętrzne: axios (KRS/
// strona WWW/AI) i GUS REGON (SOAP). Zero realnych wywołań AI/sieci.
//
// Ścieżka przez enrichOne (celowo najprostsza możliwa, bez pełnego crawla):
// - company.nip + krs_number → fetchKRS() zwraca krsData BEZ realnego
//   requestu do api-krs.ms.gov.pl (mockowany axios.get).
// - website_url wskazuje na domenę .invalid → fetchPageForCrawl() dostaje
//   od zmockowanego axios.get odrzucenie z komunikatem zawierającym
//   "ENOTFOUND" → _crawlWebsite rozpoznaje to jako deterministyczny błąd
//   (DETERMINISTIC_FETCH_ERROR), homepage/pełny crawl się nie wykonuje.
// - websiteText zostaje puste, ale krsData jest prawdziwe → enrichOne NIE
//   zatrzymuje się na "brak treści", tylko idzie dalej do wywołania AI
//   (dokładnie ta gałąź, którą audyt B1 zidentyfikował jako ryzykowną).
// - AI (zmockowany axios.post na DeepSeek) zwraca tekst, który nie jest
//   JSON-em.

jest.mock('axios');
jest.mock('../services/gusRegonService', () => ({
  getCompanyData: jest.fn().mockResolvedValue(null),
}));

const axios = require('axios');
const db = require('../config/database');
const svc = require('../services/prospectEnrichmentService');

const SLUG = 'zz-enrich-ai-parse-fail-test';
const WEBSITE_URL = 'https://example-test-co.invalid';

let tenantId;
let prospectId;

const KRS_FIXTURE = {
  odpis: { dane: { formaPrawna: 'Sp. z o.o.', numerKRS: '0000123456', nazwa: 'Testowa Sp. z o.o.' } },
};

function mockAxios(aiContent) {
  axios.get.mockImplementation((url) => {
    if (url.includes('api-krs.ms.gov.pl')) {
      return Promise.resolve({ data: KRS_FIXTURE, status: 200 });
    }
    const err = new Error('getaddrinfo ENOTFOUND example-test-co.invalid');
    err.code = 'ENOTFOUND';
    return Promise.reject(err);
  });
  axios.post.mockImplementation((url) => {
    if (url.includes('deepseek.com')) {
      return Promise.resolve({
        data: {
          choices: [{ message: { content: aiContent }, finish_reason: 'stop' }],
          model: 'deepseek-chat',
          usage: {},
        },
      });
    }
    return Promise.reject(new Error(`Unexpected axios.post in test: ${url}`));
  });
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Enrich AI Parse Fail Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
});

beforeEach(async () => {
  jest.clearAllMocks();
  await db.query(`DELETE FROM prospect_companies WHERE tenant_id = $1`, [tenantId]);
  const { rows: [p] } = await db.query(
    `INSERT INTO prospect_companies (tenant_id, nip, krs_number, company_name, website_url)
     VALUES ($1, '1234567890', '0000123456', 'Testowa Sp. z o.o.', $2)
     RETURNING id`,
    [tenantId, WEBSITE_URL],
  );
  prospectId = p.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM prospect_companies WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);
});

describe('enrichOne — malformed AI output (B1)', () => {
  test('AI zwraca zwykły tekst (nie JSON) -> enrichment_status=error, NIE done/icp_score=0', async () => {
    mockAxios('Przepraszam, nie moge pomoc z tym zadaniem w tej chwili.');

    const result = await svc.enrichOne(prospectId);

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/JSON/i);

    const { rows: [row] } = await db.query(
      `SELECT enrichment_status, icp_score, enrichment_error FROM prospect_companies WHERE id = $1`,
      [prospectId],
    );
    expect(row.enrichment_status).toBe('error');
    expect(row.icp_score).toBeNull();
    expect(row.enrichment_error).toMatch(/JSON/i);
  }, 20000);

  test('AI zwraca JSON bez domykającej klamry (regex fallback też zawodzi) -> ta sama ścieżka error', async () => {
    mockAxios('{"gates": {"b2b": "pass"'); // ucięty JSON, brak {}

    const result = await svc.enrichOne(prospectId);

    expect(result.status).toBe('error');

    const { rows: [row] } = await db.query(
      `SELECT enrichment_status, icp_score FROM prospect_companies WHERE id = $1`,
      [prospectId],
    );
    expect(row.enrichment_status).toBe('error');
    expect(row.icp_score).toBeNull();
  }, 20000);

  test('retry: prospekt z enrichment_status=error jest widziany przez runBatch (WHERE ... IN (pending, error))', async () => {
    mockAxios('nie json');
    await svc.enrichOne(prospectId);

    const { rows } = await db.query(
      `SELECT id FROM prospect_companies WHERE tenant_id = $1 AND enrichment_status IN ('pending', 'error') AND id = $2`,
      [tenantId, prospectId],
    );
    expect(rows).toHaveLength(1);
  }, 20000);
});

describe('validateAiSignalsResponse — regresja: poprawna odpowiedź JSON nadal akceptowana bez zmian', () => {
  test('wszystkie aktywne sygnały obecne, boolean value -> nie rzuca', () => {
    const activeSignals = [{ key: 'a', active: true }, { key: 'b', active: true }];
    const raw = [{ key: 'a', value: true, reasoning: 'x' }, { key: 'b', value: false, reasoning: 'y' }];
    expect(() => svc.validateAiSignalsResponse(raw, activeSignals)).not.toThrow();
  });
});
