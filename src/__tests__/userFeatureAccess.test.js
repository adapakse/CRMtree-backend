'use strict';

// Uprawnienie do modułu nadawane imiennie (user_feature_access, migracja 0330).
//
// Testuje bramkę requireFeature, bo najdroższe pomyłki są tutaj:
//   - dwie bramki muszą działać ŁĄCZNIE: wyłączony moduł tenanta blokuje nawet
//     osobę z grantem, a włączony moduł nie wpuszcza osoby bez grantu,
//   - admin tenanta przechodzi zawsze i nie potrzebuje wiersza — inaczej po
//     wdrożeniu admin zablokowałby sam sobie moduł,
//   - moduł SPOZA listy zarządzanych imiennie (np. 'projects') nie może nagle
//     zacząć wymagać grantu — to zabrałoby dostęp wszystkim użytkownikom,
//   - brak wiersza = brak dostępu, a granted=FALSE to odebranie, nie usunięcie.
//
// Integracyjny na realnej bazie — całość to SQL i kolejność sprawdzeń.

const db = require('../config/database');
const { requireFeature } = require('../middleware/crm-rbac');

const SLUG = 'zz-user-feature-access-test';
let tenantId;
let adminId;
let userId;

// Minimalny stub Express — middleware albo woła next(), albo kończy 403.
function run(middleware, user) {
  return new Promise((resolve) => {
    const req = { user };
    const res = {
      status(code) { this._code = code; return this; },
      json(body) { resolve({ status: this._code, body }); },
    };
    middleware(req, res, () => resolve({ status: 200, body: null }));
  });
}

const setFeature = (enabled) =>
  db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'call_analysis', $2)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`,
    [tenantId, enabled],
  );

const setGrant = (granted) =>
  db.query(
    `INSERT INTO user_feature_access (tenant_id, user_id, feature_name, granted)
     VALUES ($1, $2, 'call_analysis', $3)
     ON CONFLICT (user_id, feature_name) DO UPDATE SET granted = EXCLUDED.granted`,
    [tenantId, userId, granted],
  );

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('User Feature Access Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;

  // Bez ON CONFLICT (email) — ten sam e-mail może istnieć w wielu tenantach,
  // więc unikalności po samym e-mailu nie ma (patrz CLAUDE.md, pułapka logowania).
  const mkUser = async (email, isAdmin) => {
    await db.query('DELETE FROM users WHERE email = $1 AND tenant_id = $2', [email, tenantId]);
    const { rows } = await db.query(
      `INSERT INTO users (tenant_id, email, first_name, last_name, is_admin, is_active)
       VALUES ($1, $2, 'Test', 'User', $3, TRUE) RETURNING id`,
      [tenantId, email, isAdmin],
    );
    return rows[0].id;
  };
  adminId = await mkUser(`admin@${SLUG}.test`, true);
  userId = await mkUser(`user@${SLUG}.test`, false);
});

beforeEach(async () => {
  await db.query('DELETE FROM user_feature_access WHERE tenant_id = $1', [tenantId]);
  await setFeature(true);
});

afterAll(async () => {
  await db.query('DELETE FROM user_feature_access WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

const asUser = () => ({ id: userId, tenant_id: tenantId, is_admin: false });
const asAdmin = () => ({ id: adminId, tenant_id: tenantId, is_admin: true });

describe('obie bramki działają łącznie', () => {
  test('moduł włączony + grant → wpuszcza', async () => {
    await setGrant(true);
    expect((await run(requireFeature('call_analysis'), asUser())).status).toBe(200);
  });

  test('moduł włączony, brak wiersza → 403', async () => {
    const res = await run(requireFeature('call_analysis'), asUser());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Brak dostępu do funkcji/);
  });

  test('moduł włączony, grant odebrany (granted=FALSE) → 403', async () => {
    await setGrant(false);
    expect((await run(requireFeature('call_analysis'), asUser())).status).toBe(403);
  });

  test('moduł wyłączony tenantowi → 403 mimo grantu', async () => {
    await setGrant(true);
    await setFeature(false);
    const res = await run(requireFeature('call_analysis'), asUser());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/nie jest aktywny dla tego tenanta/);
  });
});

describe('admin i superadmin', () => {
  test('admin tenanta wchodzi bez wiersza', async () => {
    expect((await run(requireFeature('call_analysis'), asAdmin())).status).toBe(200);
  });

  test('admin NIE obchodzi wyłączonego modułu tenanta', async () => {
    await setFeature(false);
    expect((await run(requireFeature('call_analysis'), asAdmin())).status).toBe(403);
  });

  test('konto bez tenanta (superadmin / gold) przechodzi', async () => {
    const res = await run(requireFeature('call_analysis'), { id: adminId, is_admin: false });
    expect(res.status).toBe(200);
  });
});

describe('moduły spoza listy zarządzanych imiennie', () => {
  test("'projects' nie wymaga grantu — zostaje na samej fladze tenanta", async () => {
    await db.query(
      `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
      [tenantId],
    );
    expect((await run(requireFeature('projects'), asUser())).status).toBe(200);
  });
});

describe('odebranie zostawia ślad, a nie kasuje wiersza', () => {
  test('granted=FALSE zostaje w tabeli — widać, że dostęp odebrano świadomie', async () => {
    await setGrant(true);
    await setGrant(false);
    const { rows } = await db.query(
      `SELECT granted FROM user_feature_access
        WHERE user_id = $1 AND feature_name = 'call_analysis'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].granted).toBe(false);
  });
});
