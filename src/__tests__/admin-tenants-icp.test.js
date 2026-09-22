'use strict';

// API CRUD dla dynamicznego ICP tenanta (admin-tenants.js /:id/icp-*) —
// super-admin only. Testuje trasy HTTP end-to-end (nie tylko serwis, patrz
// tenantIcpConfigService.test.js): LIVE vs PUBLISHED, auto-publikacja tylko
// dla poprawnego configu, config_revision jako concurrency token niezależny
// od numeru opublikowanej wersji, soft/hard delete, statusy błędów (.status
// na wyjątkach z tenantIcpConfigService → 400/404/409 przez routes).

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const SLUG = 'zz-admin-tenants-icp-test';
const API = '/api/admin/tenants';

let tenantId;
let authToken;

beforeAll(async () => {
  const { rows: [sa] } = await db.query(
    `SELECT id, email, display_name, is_admin, is_active, crm_role, tenant_id, is_super_admin
       FROM users WHERE is_super_admin = true LIMIT 1`,
  );
  if (!sa) throw new Error('Brak super admina w lokalnej bazie — wymagany do tego testu');
  authToken = signAccessToken(sa);

  await db.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Admin Tenants ICP Test', $1, TRUE) RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  // Tenant tworzony bezpośrednio SQL-em (nie przez POST /), więc nie ma
  // jeszcze configu ICP — to jest zamierzone: testy GET-fallback niżej
  // sprawdzają dokładnie tę ścieżkę.
});

afterAll(async () => {
  await db.query(`DELETE FROM tenant_icp_config_versions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_configs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_signals WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

function auth(req) {
  return req.set('Authorization', `Bearer ${authToken}`);
}

describe('GET /:id/icp-config', () => {
  test('tenant bez własnego configu dostaje fallback DEFAULT_SIGNALS (is_default=true, valid, 70/70/100)', async () => {
    const res = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(res.status).toBe(200);
    expect(res.body.is_default).toBe(true);
    expect(res.body.signals).toHaveLength(8);
    expect(res.body.qualification_threshold).toBe(45);
    expect(res.body.config_revision).toBe(0);
    expect(res.body.is_valid).toBe(true);
    expect(res.body.signals_sum).toBe(70);
    expect(res.body.signals_max).toBe(70);
    expect(res.body.final_max_score).toBe(100);
    expect(res.body.current_version).toBeNull();
  });

  test('nieistniejący tenant → 404', async () => {
    const res = await auth(request(app).get(`${API}/00000000-0000-0000-0000-000000000000/icp-config`));
    expect(res.status).toBe(404);
  });
});

describe('CRUD sygnałów — pełny cykl życia (LIVE vs PUBLISHED)', () => {
  let signalId;

  test('POST na fallbackowym tenancie najpierw materializuje 8 defaultów, potem dodaje sygnał — suma 140, invalid, published=false', async () => {
    // Route /:id/icp-signals woła materializeDefaultsIfFallback PRZED addSignal
    // (patrz admin-tenants.js) — tenant startuje tu w prawdziwym fallbacku (0
    // wierszy, insert SQL-em w głównym beforeAll tego pliku), więc POST realnie
    // materializuje najpierw 8 defaultowych sygnałów (suma 70), a dopiero potem
    // dodaje nowy (70) — razem 140, nie 70. To jest oczekiwane: fallbackowy
    // tenant "ma" już 70 punktów w defaultach, więc dodanie kolejnego sygnału
    // bez odjęcia punktów gdzie indziej musi zostać invalid, nie automagicznie
    // się zbilansować.
    const res = await auth(request(app).post(`${API}/${tenantId}/icp-signals`)).send({
      label: 'Własna flota transportowa',
      ai_definition: 'Firma posiada własną flotę pojazdów.',
      points: 70,
    });
    expect(res.status).toBe(201);
    expect(res.body.signal.key).toBe('wlasna_flota_transportowa');
    expect(res.body.signal.points).toBe(70);
    expect(res.body.published).toBe(false);
    expect(res.body.version).toBeNull();
    expect(res.body.config_revision).toBe(1);
    signalId = res.body.signal.id;
  });

  test('GET pokazuje 9 sygnałów (8 zmaterializowanych defaultów + nowy), LIVE invalid, PUBLISHED nadal fallback', async () => {
    const res = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(res.body.is_default).toBe(false); // realne wiersze już istnieją (zmaterializowane)
    expect(res.body.signals).toHaveLength(9);
    expect(res.body.is_valid).toBe(false);
    expect(res.body.signals_sum).toBe(140);
    expect(res.body.current_version).toBeNull(); // nic jeszcze nie opublikowano
  });

  test('DELETE 8 zmaterializowanych defaultów (nigdy niepublikowanych → hard delete) sprowadza sumę do 70 i automatycznie publikuje v1', async () => {
    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    const defaultIds = cfg.body.signals.filter((s) => s.id !== signalId).map((s) => s.id);
    expect(defaultIds).toHaveLength(8);

    let lastRes;
    for (const id of defaultIds) {
      lastRes = await auth(request(app).delete(`${API}/${tenantId}/icp-signals/${id}`));
      expect(lastRes.status).toBe(200);
      expect(lastRes.body.soft_deleted).toBe(false); // defaulty nigdy nie były opublikowane
    }
    expect(lastRes.body.published).toBe(true);
    expect(lastRes.body.version).toBe(1);
    expect(lastRes.body.config_revision).toBe(9); // 1 (POST) + 8 (delete)
  });

  test('GET pokazuje LIVE=PUBLISHED, poprawny (70/70/100), current_version=1', async () => {
    const res = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(res.body.is_default).toBe(false);
    expect(res.body.signals).toHaveLength(1);
    expect(res.body.is_valid).toBe(true);
    expect(res.body.signals_sum).toBe(70);
    expect(res.body.final_max_score).toBe(100);
    expect(res.body.current_version).toBe(1);
  });

  test('PUT punkty na 75 — LIVE staje się invalid, current_version NIE zmienia się (nadal 1)', async () => {
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-signals/${signalId}`)).send({ points: 75 });
    expect(res.status).toBe(200);
    expect(res.body.signal.points).toBe(75);
    expect(res.body.published).toBe(false);
    expect(res.body.version).toBeNull();
    expect(res.body.config_revision).toBe(10);

    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(cfg.body.is_valid).toBe(false);
    expect(cfg.body.signals_sum).toBe(75);
    expect(cfg.body.current_version).toBe(1); // enrichment nadal używa v1, bez zmian
  });

  test('PUT z powrotem na 70 — automatycznie publikuje nową wersję (v2), bez przycisku "Publikuj"', async () => {
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-signals/${signalId}`)).send({ points: 70 });
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
    expect(res.body.version).toBe(2);
    expect(res.body.config_revision).toBe(11);

    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(cfg.body.is_valid).toBe(true);
    expect(cfg.body.current_version).toBe(2);
  });

  test('PUT z próbą edycji key jest odrzucany 400', async () => {
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-signals/${signalId}`)).send({
      key: 'cos_innego',
    });
    // express-validator nie zna pola "key" na tej trasie (celowo brak walidatora dla
    // niezmiennego pola) — request przechodzi walidację, ale service go odrzuca.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key jest niezmienny/);
  });

  test('PUT na nieistniejący sygnał → 404', async () => {
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-signals/00000000-0000-0000-0000-000000000000`)).send({
      points: 5,
    });
    expect(res.status).toBe(404);
  });

  test('PUT z nieaktualnym expected_revision → 409 (optimistic concurrency, niezależne od numeru wersji)', async () => {
    // aktualny config_revision to 11 po poprzednich mutacjach — 1 jest na pewno stary.
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-signals/${signalId}`)).send({
      points: 71, expected_revision: 1,
    });
    expect(res.status).toBe(409);
  });

  test('POST reorder z niepełną listą → 400', async () => {
    const res = await auth(request(app).post(`${API}/${tenantId}/icp-signals/reorder`)).send({
      ordered_signal_ids: [],
    });
    expect(res.status).toBe(400); // express-validator: min:1
  });

  test('PUT /:id/icp-threshold nie istnieje (usunięty po ujednoliceniu z app_settings.prospect_lead_min_score)', async () => {
    const res = await auth(request(app).put(`${API}/${tenantId}/icp-threshold`)).send({
      qualification_threshold: 60,
    });
    expect(res.status).toBe(404); // brak trasy, nie handler — Express 404
  });

  test('GET pokazuje qualification_threshold jako odczyt z app_settings.prospect_lead_min_score tego tenanta', async () => {
    await db.query(
      `INSERT INTO app_settings (tenant_id, key, value, value_type, label, category)
       VALUES ($1, 'prospect_lead_min_score', '55', 'number', 'test', 'crm')
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = '55'`,
      [tenantId],
    );
    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(cfg.body.qualification_threshold).toBe(55);
    await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'prospect_lead_min_score'`, [tenantId]);
  });

  test('DELETE sygnału, który BYŁ opublikowany → soft delete (active=false), zostaje na liście', async () => {
    const res = await auth(request(app).delete(`${API}/${tenantId}/icp-signals/${signalId}`));
    expect(res.status).toBe(200);
    expect(res.body.soft_deleted).toBe(true);

    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(cfg.body.is_default).toBe(false); // wiersz nadal istnieje w tenant_icp_signals
    const stillThere = cfg.body.signals.find((s) => s.id === signalId);
    expect(stillThere).toBeDefined();
    expect(stillThere.active).toBe(false);
  });

  test('DELETE nigdy niepublikowanego sygnału → hard delete, znika z listy', async () => {
    const created = await auth(request(app).post(`${API}/${tenantId}/icp-signals`)).send({
      label: 'Efemeryczny', ai_definition: 'x', points: 5,
    });
    expect(created.body.published).toBe(false);

    const res = await auth(request(app).delete(`${API}/${tenantId}/icp-signals/${created.body.signal.id}`));
    expect(res.status).toBe(200);
    expect(res.body.soft_deleted).toBe(false);

    const cfg = await auth(request(app).get(`${API}/${tenantId}/icp-config`));
    expect(cfg.body.signals.find((s) => s.id === created.body.signal.id)).toBeUndefined();
  });

  test('DELETE nieistniejącego sygnału → 404', async () => {
    const res = await auth(request(app).delete(`${API}/${tenantId}/icp-signals/00000000-0000-0000-0000-000000000000`));
    expect(res.status).toBe(404);
  });
});

describe('Bez tokenu / bez super admina', () => {
  test('brak Authorization → 401', async () => {
    const res = await request(app).get(`${API}/${tenantId}/icp-config`);
    expect(res.status).toBe(401);
  });
});
