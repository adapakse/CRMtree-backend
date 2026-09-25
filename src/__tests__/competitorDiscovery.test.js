'use strict';

// "Znajdź konkurencję" — testy izolacji tenantów i limitu kosztów.
//
// Mechanizm jest portem z worktrips-doc, gdzie działa w aplikacji
// JEDNOTENANTOWEJ. Te testy pilnują wyłącznie tego, czego tam nie było i czego
// nie da się sprawdzić przez przeczytanie kodu: że zapytania o obecność firmy
// nie przeciekają między tenantami i że bulk-add zapisuje rekord we właściwym
// tenancie.
//
// Limity (MAX_RESULTS, PAGE_SIZE, TTL cache) są takie same jak w worktrips-doc;
// limitu użyć tam nie ma i tutaj też nie ma — poza globalnym rate limitem HTTP.
//
// Nie testujemy tu jakości podpowiedzi modelu — to zostało zweryfikowane
// w worktrips-doc na realnym użyciu.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');
const discoverySvc = require('../services/competitorDiscoveryService');
const enrichSvc = require('../services/prospectEnrichmentService');

const SLUG_A = 'zz-discovery-tenant-a';
const SLUG_B = 'zz-discovery-tenant-b';
const SHARED_NIP = '9999888801'; // ta sama firma "widziana" przez oba tenanty
const BULK_NIP   = '9999888802';

let tenantA, tenantB, tokenA, userA;
let runBatchSpy, batchProgressSpy;

async function makeTenant(slug, name) {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [name, slug],
  );
  return t.id;
}

beforeAll(async () => {
  tenantA = await makeTenant(SLUG_A, 'Discovery Tenant A');
  tenantB = await makeTenant(SLUG_B, 'Discovery Tenant B');

  await db.query(`DELETE FROM users WHERE email IN ($1, $2)`,
    [`admin@${SLUG_A}.test`, `admin@${SLUG_B}.test`]);
  const { rows: [a] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id)
     VALUES ($1,'Anna','Adminowa',TRUE,$2) RETURNING *`, [`admin@${SLUG_A}.test`, tenantA]);
  userA  = a;
  tokenA = signAccessToken(a);

  // Batch enrichmentu robi realny crawl + AI — w teście tylko obserwujemy,
  // czy został wywołany i dla KTÓREGO tenanta.
  batchProgressSpy = jest.spyOn(enrichSvc, 'getBatchProgress').mockReturnValue({ running: false });
  runBatchSpy      = jest.spyOn(enrichSvc, 'runBatch').mockResolvedValue({ ok: true });
});

afterAll(async () => {
  await db.query(`DELETE FROM prospect_companies WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
  jest.restoreAllMocks();
});

beforeEach(() => {
  runBatchSpy.mockClear();
});

describe('izolacja tenantów — checkTenantPresence', () => {
  test('prospekt tenanta B jest NIEWIDOCZNY dla tenanta A', async () => {
    await db.query(
      `INSERT INTO prospect_companies (tenant_id, nip, company_name)
       VALUES ($1, $2, 'Firma Tenanta B')
       ON CONFLICT (tenant_id, nip) DO NOTHING`, [tenantB, SHARED_NIP]);

    const forB = await discoverySvc.checkTenantPresence(tenantB, [SHARED_NIP]);
    expect(forB.get(SHARED_NIP)).toMatchObject({ inProspects: true });

    const forA = await discoverySvc.checkTenantPresence(tenantA, [SHARED_NIP]);
    expect(forA.get(SHARED_NIP)).toMatchObject({
      inProspects: false, inLeads: false, inPartners: false,
    });
  });

  test('bez tenantId nie zwraca niczego (zamiast odpytać całą tabelę)', async () => {
    const res = await discoverySvc.checkTenantPresence(null, [SHARED_NIP]);
    expect(res.size).toBe(0);
  });

  test('NIP-y o złej długości są odfiltrowane przed zapytaniem', async () => {
    const res = await discoverySvc.checkTenantPresence(tenantA, ['123', '', null]);
    expect(res.size).toBe(0);
  });
});

describe('klucz cache zawiera tenanta', () => {
  test('ten sam user i seed w dwóch tenantach to dwa różne wpisy', () => {
    const k1 = discoverySvc.cacheKey(tenantA, userA.id, SHARED_NIP);
    const k2 = discoverySvc.cacheKey(tenantB, userA.id, SHARED_NIP);
    expect(k1).not.toBe(k2);

    discoverySvc.setCache(tenantA, userA.id, SHARED_NIP, [{ company_name: 'A' }]);
    expect(discoverySvc.getCache(tenantB, userA.id, SHARED_NIP)).toBeNull();
    expect(discoverySvc.getCache(tenantA, userA.id, SHARED_NIP)).toHaveLength(1);
  });
});

describe('walidacja wejścia', () => {
  test('seed_nip inny niż 10 cyfr → 400', async () => {
    const res = await request(app)
      .post('/api/admin/prospects/discover-competitors')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ company_name: 'Testowa sp. z o.o.', seed_nip: '123' });
    expect(res.status).toBe(400);
  });

  test('bez tokenu → 401', async () => {
    const res = await request(app)
      .post('/api/admin/prospects/discover-competitors')
      .send({ company_name: 'X', seed_nip: SHARED_NIP });
    expect(res.status).toBe(401);
  });
});

describe('bulk-add — zapisuje do właściwego tenanta', () => {
  test('rekord trafia do tenanta wywołującego, ze źródłem ai_discovery', async () => {
    const res = await request(app)
      .post('/api/admin/prospects/discover-competitors/bulk-add')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ companies: [{ nip: BULK_NIP, company_name: 'Konkurent sp. z o.o.', website_url: 'https://konkurent.example' }] });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.source_database).toMatch(/^AA_\d{8}_\d+$/);

    const { rows } = await db.query(
      `SELECT tenant_id, website_source, imported_by, enrichment_status, source_database
         FROM prospect_companies WHERE nip = $1`, [BULK_NIP]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantA);
    expect(rows[0].website_source).toBe('ai_discovery');
    expect(rows[0].imported_by).toBe(userA.id);
    expect(rows[0].enrichment_status).toBe('pending');

    // batch enrichmentu jest per-tenant — sprawdzane w TYM SAMYM teście,
    // bo beforeEach czyści spy między testami
    expect(res.body.batchStarted).toBe(true);
    expect(runBatchSpy).toHaveBeenCalledWith(tenantA);
    expect(runBatchSpy).not.toHaveBeenCalledWith(tenantB);
  });

  test('ten sam NIP może istnieć u drugiego tenanta (UNIQUE jest per-tenant)', async () => {
    const { rowCount } = await db.query(
      `INSERT INTO prospect_companies (tenant_id, nip, company_name)
       VALUES ($1, $2, 'Ten sam NIP u tenanta B')
       ON CONFLICT (tenant_id, nip) DO NOTHING`, [tenantB, BULK_NIP]);
    expect(rowCount).toBe(1);

    const { rows } = await db.query(
      `SELECT tenant_id FROM prospect_companies WHERE nip = $1 ORDER BY tenant_id`, [BULK_NIP]);
    expect(rows).toHaveLength(2);
  });

  test('powtórne dodanie tej samej firmy nie duplikuje rekordu', async () => {
    const res = await request(app)
      .post('/api/admin/prospects/discover-competitors/bulk-add')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ companies: [{ nip: BULK_NIP, company_name: 'Konkurent sp. z o.o.' }] });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  test('NIP o złej długości jest pomijany, nie wywraca żądania', async () => {
    const res = await request(app)
      .post('/api/admin/prospects/discover-competitors/bulk-add')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ companies: [{ nip: '123', company_name: 'Zły NIP' }] });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });
});
