'use strict';

const request = require('supertest');
const app     = require('../app');
const db      = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

// ─── Stałe testowe ────────────────────────────────────────────────────────────
const SLUG       = 'zz-churn-test';
const DWH_PFX    = 'zz_churn_test';
const DWH_P1_ID  = 99901;   // unikalne ID w przestrzeni testowej
const DWH_P2_ID  = 99902;

let tenantId;
let adminToken, managerToken, sp1Token, sp2Token, noRoleToken;
let sp1Id, sp2Id;
let partner1Id, partner2Id;  // ID z crm_partners

// ─── Setup ───────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // Tenant z własnym prefiksem DWH
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active, dwh_schema_prefix)
     VALUES ('Churn Test Tenant', $1, TRUE, $2)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, dwh_schema_prefix = $2
     RETURNING id`,
    [SLUG, DWH_PFX],
  );
  tenantId = tenant.id;

  // Czyszczenie po poprzednich uruchomieniach
  await db.query(`DELETE FROM crm_partner_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partners            WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM user_group_roles        WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM group_profiles          WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_features         WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@churn-test.crmtree.local'`);

  // DWH tabele testowe
  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_sales`);
  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_partner`);
  await db.query(`
    CREATE TABLE dwh.${DWH_PFX}_sales (
      sale_date             date,
      partner_id            integer,
      gross_sales_value_pln numeric DEFAULT 0,
      gross_fee_value_pln   numeric DEFAULT 0
    )
  `);
  await db.query(`
    CREATE TABLE dwh.${DWH_PFX}_partner (
      partner_id    integer PRIMARY KEY,
      name          varchar,
      company_name  varchar,
      is_test_account boolean DEFAULT false
    )
  `);

  // Użytkownicy
  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
     VALUES ('admin@churn-test.crmtree.local','Admin','Churn',TRUE,TRUE,$1) RETURNING *`,
    [tenantId],
  );
  adminToken = signAccessToken(admin);

  const { rows: [noRole] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
     VALUES ('norole@churn-test.crmtree.local','NoRole','Churn',FALSE,TRUE,$1) RETURNING *`,
    [tenantId],
  );
  noRoleToken = signAccessToken(noRole);

  const { rows: [mgr] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ('mgr@churn-test.crmtree.local','Manager','Churn',FALSE,TRUE,'sales_manager',$1) RETURNING *`,
    [tenantId],
  );
  managerToken = signAccessToken(mgr);

  const { rows: [sp1] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ('sp1@churn-test.crmtree.local','Sales','One',FALSE,TRUE,'salesperson',$1) RETURNING *`,
    [tenantId],
  );
  sp1Id      = sp1.id;
  sp1Token   = signAccessToken(sp1);

  const { rows: [sp2] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ('sp2@churn-test.crmtree.local','Sales','Two',FALSE,TRUE,'salesperson',$1) RETURNING *`,
    [tenantId],
  );
  sp2Id      = sp2.id;
  sp2Token   = signAccessToken(sp2);

  // Grupa: manager + obaj handlowcy
  const { rows: [grp] } = await db.query(
    `INSERT INTO group_profiles (name, display_name, tenant_id)
     VALUES ('ChurnGroup','Churn Group',$1) RETURNING id`,
    [tenantId],
  );
  for (const uid of [mgr.id, sp1Id, sp2Id]) {
    await db.query(
      `INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id)
       VALUES ($1,$2,'full',$3)`,
      [uid, grp.id, tenantId],
    );
  }

  // Rekordy DWH partnerów
  await db.query(
    `INSERT INTO dwh.${DWH_PFX}_partner (partner_id, name, company_name)
     VALUES ($1,'Partner CRITICAL','CRITICAL Sp. z o.o.'),
            ($2,'Partner HIGH','HIGH Sp. z o.o.')`,
    [DWH_P1_ID, DWH_P2_ID],
  );

  // Dane sprzedażowe — tylko M2 (2 miesiące temu), brak M1
  // Dzięki temu: sales_drop = 100% (M2>0, M1=0), last_date = 1. dnia M2 = zawsze >30 dni temu
  await db.query(`
    INSERT INTO dwh.${DWH_PFX}_sales (sale_date, partner_id, gross_sales_value_pln)
    VALUES
      (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')::date, $1, 10000),
      (DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')::date, $2,  5000)
  `, [DWH_P1_ID, DWH_P2_ID]);

  // Partnerzy CRM
  const { rows: [p1] } = await db.query(
    `INSERT INTO crm_partners (company, status, dwh_partner_id, manager_id, tenant_id)
     VALUES ('CRITICAL Sp. z o.o.', 'active', $1, $2, $3) RETURNING id`,
    [DWH_P1_ID, sp1Id, tenantId],
  );
  partner1Id = p1.id;

  const { rows: [p2] } = await db.query(
    `INSERT INTO crm_partners (company, status, dwh_partner_id, manager_id, tenant_id)
     VALUES ('HIGH Sp. z o.o.', 'active', $1, $2, $3) RETURNING id`,
    [DWH_P2_ID, sp2Id, tenantId],
  );
  partner2Id = p2.id;
});

// ─── Teardown ─────────────────────────────────────────────────────────────────
afterAll(async () => {
  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_sales`);
  await db.query(`DROP TABLE IF EXISTS dwh.${DWH_PFX}_partner`);
  await db.query(`DELETE FROM crm_partner_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partners            WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM user_group_roles        WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM group_profiles          WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_features         WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@churn-test.crmtree.local'`);
});

// ─── GET /api/crm/churn ───────────────────────────────────────────────────────
describe('GET /api/crm/churn — auth & RBAC', () => {
  test('401 bez tokena', async () => {
    const res = await request(app).get('/api/crm/churn');
    expect(res.status).toBe(401);
  });

  test('403 dla usera bez roli CRM', async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  test('403 gdy moduł dwh_integration wyłączony', async () => {
    await db.query(
      `INSERT INTO tenant_features (tenant_id, feature, is_enabled)
       VALUES ($1, 'dwh_integration', FALSE)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = FALSE`,
      [tenantId],
    );
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);

    await db.query(`DELETE FROM tenant_features WHERE tenant_id = $1`, [tenantId]);
  });

  test('200 dla admina — widzi obu partnerów', async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rows');
    expect(res.body).toHaveProperty('settings');
    const ids = res.body.rows.map(r => r.partner_id);
    expect(ids).toContain(partner1Id);
    expect(ids).toContain(partner2Id);
  });

  test('200 dla managera — widzi obu partnerów ze swojej grupy', async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map(r => r.partner_id);
    expect(ids).toContain(partner1Id);
    expect(ids).toContain(partner2Id);
  });

  test('200 dla sp1 — widzi TYLKO swojego partnera (partner1)', async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${sp1Token}`);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map(r => r.partner_id);
    expect(ids).toContain(partner1Id);
    expect(ids).not.toContain(partner2Id);
  });

  test('200 dla sp2 — widzi TYLKO swojego partnera (partner2)', async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${sp2Token}`);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map(r => r.partner_id);
    expect(ids).toContain(partner2Id);
    expect(ids).not.toContain(partner1Id);
  });
});

describe('GET /api/crm/churn — kształt odpowiedzi i scoring', () => {
  let rows, settings;

  beforeAll(async () => {
    const res = await request(app)
      .get('/api/crm/churn')
      .set('Authorization', `Bearer ${adminToken}`);
    rows     = res.body.rows;
    settings = res.body.settings;
  });

  test('każdy rekord ma wymagane pola', () => {
    const required = [
      'partner_id', 'display_name', 'days_since_order',
      'sales_m1', 'sales_m2', 'sales_drop_pct',
      'days_score', 'sales_score', 'total_score', 'risk_level',
    ];
    for (const row of rows) {
      for (const field of required) {
        expect(row).toHaveProperty(field);
      }
    }
  });

  test('risk_level jest jedną z dopuszczalnych wartości', () => {
    const valid = ['critical', 'high', 'medium', 'low'];
    for (const row of rows) {
      expect(valid).toContain(row.risk_level);
    }
  });

  test('settings zawiera wszystkie progi algorytmu', () => {
    const keys = [
      'days_t1_min','days_t1_max','days_t1_pts',
      'days_t2_min','days_t2_max','days_t2_pts','days_t3_pts',
      'sales_t1_pct','sales_t2_pct','sales_t1_pts','sales_t2_pts',
      'risk_critical','risk_high','risk_medium','risk_low',
    ];
    for (const k of keys) {
      expect(settings).toHaveProperty(k);
      expect(typeof settings[k]).toBe('number');
    }
  });

  test('total_score = days_score + sales_score', () => {
    for (const row of rows) {
      expect(row.total_score).toBe(row.days_score + row.sales_score);
    }
  });

  test('sales_drop_pct >= 0', () => {
    for (const row of rows) {
      expect(Number(row.sales_drop_pct)).toBeGreaterThanOrEqual(0);
    }
  });

  test('wyniki posortowane malejąco po total_score', () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].total_score).toBeGreaterThanOrEqual(rows[i].total_score);
    }
  });

  test('brak M1 → sales_drop_pct = 100, scoring t2 (50pkt)', () => {
    // Wstawiliśmy tylko dane M2, brak M1 → 100% drop
    const p1 = rows.find(r => r.partner_id === partner1Id);
    expect(p1).toBeDefined();
    expect(Number(p1.sales_m2)).toBeGreaterThan(0);
    expect(Number(p1.sales_m1)).toBe(0);
    expect(Number(p1.sales_drop_pct)).toBe(100);
    expect(p1.sales_score).toBe(settings.sales_t2_pts);
  });

  test('last_date > 30 dni temu → days_score = t3_pts (50 domyślnie)', () => {
    const p1 = rows.find(r => r.partner_id === partner1Id);
    expect(p1.days_since_order).toBeGreaterThan(30);
    expect(p1.days_score).toBe(settings.days_t3_pts);
  });
});

describe('GET /api/crm/churn — filtry', () => {
  test('?partner_id= zwraca tylko wskazanego partnera', async () => {
    const res = await request(app)
      .get(`/api/crm/churn?partner_id=${partner1Id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].partner_id).toBe(partner1Id);
  });

  test('?partner_id= ignoruje nieistniejące ID (pusta lista)', async () => {
    const res = await request(app)
      .get('/api/crm/churn?partner_id=999999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  test('?partner_id= nie przekracza RBAC — sp1 nie zobaczy partnera sp2', async () => {
    const res = await request(app)
      .get(`/api/crm/churn?partner_id=${partner2Id}`)
      .set('Authorization', `Bearer ${sp1Token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  test('?risk_level=critical zwraca tylko rekordy z tym poziomem ryzyka', async () => {
    const res = await request(app)
      .get('/api/crm/churn?risk_level=critical')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body.rows) {
      expect(row.risk_level).toBe('critical');
    }
  });

  test('?risk_level=low zwraca tylko rekordy z tym poziomem ryzyka', async () => {
    const res = await request(app)
      .get('/api/crm/churn?risk_level=low')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body.rows) {
      expect(row.risk_level).toBe('low');
    }
  });

  test('?salesperson_id= zwraca partnerów przypisanych do danego handlowca', async () => {
    const res = await request(app)
      .get(`/api/crm/churn?salesperson_id=${sp1Id}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map(r => r.partner_id);
    expect(ids).toContain(partner1Id);
    expect(ids).not.toContain(partner2Id);
  });
});

// ─── POST /api/crm/churn/generate ────────────────────────────────────────────
describe('POST /api/crm/churn/generate — auth & RBAC', () => {
  test('401 bez tokena', async () => {
    const res = await request(app).post('/api/crm/churn/generate');
    expect(res.status).toBe(401);
  });

  test('403 dla handlowca (brak roli managera)', async () => {
    const res = await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${sp1Token}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/crm/churn/generate — logika', () => {
  beforeEach(async () => {
    await db.query(
      `DELETE FROM crm_partner_activities WHERE tenant_id = $1 AND type = 'task' AND title LIKE 'Churn:%'`,
      [tenantId],
    );
  });

  test('200 dla managera — tworzy zadania dla partnerów z ryzykiem', async () => {
    const res = await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('created');
    expect(res.body).toHaveProperty('skipped');
    expect(res.body).toHaveProperty('total');
    expect(typeof res.body.created).toBe('number');
    expect(res.body.created).toBeGreaterThan(0);
    expect(res.body.skipped).toBe(0);
  });

  test('200 dla admina — tworzy zadania', async () => {
    const res = await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.created).toBeGreaterThan(0);
  });

  test('ponowne wywołanie pomija istniejące otwarte zadania (skipped > 0)', async () => {
    // Pierwsze wywołanie — tworzy zadania
    await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${adminToken}`);

    // Drugie wywołanie — powinno pominąć
    const res = await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBeGreaterThan(0);
    expect(res.body.created).toBe(0);
  });

  test('zadania mają poprawny tytuł i status new', async () => {
    await request(app)
      .post('/api/crm/churn/generate')
      .set('Authorization', `Bearer ${adminToken}`);

    const { rows: tasks } = await db.query(
      `SELECT title, status, assigned_to, partner_id
       FROM crm_partner_activities
       WHERE tenant_id = $1 AND type = 'task' AND title LIKE 'Churn:%'`,
      [tenantId],
    );
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.title).toMatch(/^Churn:/);
      expect(t.status).toBe('new');
      expect(t.assigned_to).toBeTruthy();
    }
  });
});
