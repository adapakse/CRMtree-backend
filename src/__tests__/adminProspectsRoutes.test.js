'use strict';

// Test route'owy minimalny (20.09) dla GET /api/admin/prospects/scoring-rules —
// istniejąca infrastruktura (supertest + app + tenant/token, wzorzec z
// documents.test.js) wystarcza tu bez przebudowy, bo trasa nie ma multipart
// uploadu ani tła (background job): jest to cienki wrapper wołający
// getIcpScoringRules(), którego WŁASNA logika ma już osobne testy jednostkowe
// (icpScoring.test.js, companySizeGate.test.js).
//
// POST /:id/re-process (trustedDomain: websiteChanged) NIE ma tu testu
// route'owego — wymagałby mockowania enrichSvc.reEnrichOne, który odpala
// prawdziwy crawl/AI w tle, i decyzją z 20.09 nie budujemy tego teraz.
// Zweryfikowane integracyjnie ręcznie: dry-runem enrichOne() na żywo (Alior
// Bank, Tilton) w tej samej sesji — patrz raport review.
//
// POST /import MA tu prawdziwy test end-to-end (21.09, regresja "Wielkość"→
// company_size) — multipart CSV przez supertest, bo to jedyny sposób, żeby
// udowodnić że findColumnKey() rzeczywiście dopasowuje nagłówek z polską
// diakrytyką W CAŁYM PRZEPŁYWIE importu, nie tylko w izolowanej funkcji.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const TEST_TENANT_SLUG = 'zz-prospects-scoring-test';
const TEST_IMPORT_NIPS = ['9999999901', '9999999902'];
let tenantId, adminToken;

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Prospects Scoring Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [TEST_TENANT_SLUG],
  );
  tenantId = tenant.id;

  await db.query(`DELETE FROM users WHERE email = 'admin@zz-prospects-scoring-test.worktrips.com'`);
  const { rows: adminRows } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id)
     VALUES ('admin@zz-prospects-scoring-test.worktrips.com','Admin','User',TRUE,$1) RETURNING *`,
    [tenantId],
  );
  adminToken = signAccessToken(adminRows[0]);
});

afterAll(async () => {
  await db.query(`DELETE FROM prospect_companies WHERE tenant_id = $1 AND nip = ANY($2)`, [tenantId, TEST_IMPORT_NIPS]);
  // Pool zamykany przez --forceExit; ten plik go nie zamyka.
});

describe('GET /api/admin/prospects/scoring-rules', () => {
  test('zwraca 200 i strukturę zgodną z getIcpScoringRules() — gates/signals/bonus_signals/blacklist', async () => {
    const res = await request(app)
      .get('/api/admin/prospects/scoring-rules')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('formula');
    expect(res.body.gates).toHaveProperty('max_points');
    expect(res.body.gates.definitions.find(g => g.id === 'company_size')).toMatchObject({
      source: expect.stringContaining('employment_count'),
      threshold: 15,
    });
    expect(res.body.signals.definitions.find(s => s.id === 'dzial_handlowy')).toMatchObject({ points: 30 });
    expect(res.body.bonus_signals).toHaveProperty('max_points');
    expect(res.body.blacklist).toHaveProperty('keywords');
    expect(res.body.max_possible_score).toBe(100);
  });

  test('bez tokenu zwraca 401', async () => {
    const res = await request(app).get('/api/admin/prospects/scoring-rules');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/prospects/import — nagłówki z polską diakrytyką (regresja "Wielkość")', () => {
  test('CSV z nagłówkiem "Wielkość" zapisuje company_size (przed poprawką: zawsze NULL)', async () => {
    const csv = [
      'BAZA,NIP,Nazwa,WWW,Zatrudnienie,Wielkość,Branża',
      `zz-test-import,${TEST_IMPORT_NIPS[0]},Testowa Diakrytyka sp. z o.o.,https://example-diakrytyka.pl,20-49 osób,małe,Handel`,
    ].join('\n');

    const res = await request(app)
      .post('/api/admin/prospects/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('﻿' + csv, 'utf8'), 'test-diakrytyka.csv');

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);

    const { rows } = await db.query(
      `SELECT company_size, employment_range, employment_count, industry
         FROM prospect_companies WHERE tenant_id = $1 AND nip = $2`,
      [tenantId, TEST_IMPORT_NIPS[0]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].company_size).toBe('małe');
    expect(rows[0].employment_range).toBe('20-49 osób');
    expect(rows[0].employment_count).toBe(20);
    expect(rows[0].industry).toBe('Handel');
  });

  test('CSV z nagłówkiem ASCII "Wielkosc" (bez diakrytyki) nadal działa — brak regresji dla starych plików', async () => {
    const csv = [
      'BAZA,NIP,Nazwa,WWW,Zatrudnienie,Wielkosc',
      `zz-test-import,${TEST_IMPORT_NIPS[1]},Testowa Ascii sp. z o.o.,https://example-ascii.pl,50-99 osób,srednie`,
    ].join('\n');

    const res = await request(app)
      .post('/api/admin/prospects/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('﻿' + csv, 'utf8'), 'test-ascii.csv');

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);

    const { rows } = await db.query(
      `SELECT company_size FROM prospect_companies WHERE tenant_id = $1 AND nip = $2`,
      [tenantId, TEST_IMPORT_NIPS[1]],
    );
    expect(rows[0].company_size).toBe('srednie');
  });
});
