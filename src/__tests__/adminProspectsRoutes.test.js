'use strict';

// Test route'owy minimalny (20.09) dla GET /api/admin/prospects/scoring-rules —
// istniejąca infrastruktura (supertest + app + tenant/token, wzorzec z
// documents.test.js) wystarcza tu bez przebudowy, bo trasa nie ma multipart
// uploadu ani tła (background job): jest to cienki wrapper wołający
// getIcpScoringRules(), którego WŁASNA logika ma już osobne testy jednostkowe
// (icpScoring.test.js, companySizeGate.test.js).
//
// Import CSV (zapis employment_range) i POST /:id/re-process (trustedDomain:
// websiteChanged) NIE mają tu testu route'owego — wymagałyby nowego harnessu
// (multipart CSV + mockowanie enrichSvc.reEnrichOne, który odpala prawdziwy
// crawl/AI w tle) i decyzją z 20.09 nie budujemy go teraz. Zweryfikowane
// integracyjnie ręcznie:
//   - employment_range: import.js zapisuje kolumnę (potwierdzone przeglądem
//     kodu + parseEmploymentBounds ma 32 testy jednostkowe w companySizeGate.test.js);
//   - trustedDomain: websiteChanged: potwierdzone dry-runem enrichOne() na
//     żywo (Alior Bank, Tilton) w tej samej sesji — patrz raport review.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const TEST_TENANT_SLUG = 'zz-prospects-scoring-test';
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
    expect(res.body.signals.definitions.find(s => s.id === 'dzial_handlowy')).toMatchObject({ points: 15 });
    expect(res.body.bonus_signals).toHaveProperty('max_points');
    expect(res.body.blacklist).toHaveProperty('keywords');
    expect(res.body.max_possible_score).toBe(100);
  });

  test('bez tokenu zwraca 401', async () => {
    const res = await request(app).get('/api/admin/prospects/scoring-rules');
    expect(res.status).toBe(401);
  });
});
