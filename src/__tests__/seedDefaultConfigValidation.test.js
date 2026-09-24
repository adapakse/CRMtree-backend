'use strict';

// seedDefaultConfigForTenant() kopiuje PUBLISHED config tenanta źródłowego
// (gold) dla każdego nowo tworzonego tenanta. Jeśli źródło jest niepoprawne
// (np. gold wciąż na starej sumie 70), stary kod tworzył tenanta z LIVE
// configiem, którego bumpRevisionAndMaybePublish nie opublikował:
// current_version_id zostawał NULL, Ustawienia pokazywały jedną konfigurację,
// a enrichment po cichu liczył wg runtime'owego fallbacku DEFAULT_SIGNALS.
// Od audytu multi-tenant ICP (23.09) taki seed ma jawnie wywalić tworzenie
// tenanta (409), zamiast po cichu zostawić rozjechany config.
//
// Test NIE może zostawić śladu — każdy seed idzie w transakcji zakończonej
// ROLLBACK-iem.

const db = require('../config/database');
const svc = require('../services/tenantIcpConfigService');
const { ICP_REQUIRED_SIGNALS_MAX_SCORE } = require('../services/prospectEnrichmentService');

const SLUG_PREFIX = 'zz-icp-seed-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';
const SOURCE_OK      = `${SLUG_PREFIX}source-ok`;
const SOURCE_BROKEN  = `${SLUG_PREFIX}source-70`;
const TARGET         = `${SLUG_PREFIX}target`;

const ids = {};

async function createTenant(slug) {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
    [`ICP seed test ${slug}`, slug],
  );
  return t.id;
}

// Tenant źródłowy z opublikowanym configiem o zadanej sumie punktów.
async function givePublishedConfig(tenantId, signals) {
  const maxScore = signals.filter((s) => s.active).reduce((sum, s) => sum + s.points, 0);
  const snapshot = signals.map((s, i) => ({
    id: null, key: s.key, label: s.label, ai_definition: `definicja ${s.key}`,
    short_description: null, points: s.points, tier: null, active: s.active,
    sort_order: i + 1, requires_any_of: null,
  }));
  const { rows: [v] } = await db.query(
    `INSERT INTO tenant_icp_config_versions (tenant_id, version, qualification_threshold, max_score, snapshot)
     VALUES ($1, 1, 45, $2, $3::jsonb) RETURNING id`,
    [tenantId, maxScore, JSON.stringify(snapshot)],
  );
  await db.query(
    `INSERT INTO tenant_icp_configs (tenant_id, current_version_id, config_revision) VALUES ($1, $2, 1)`,
    [tenantId, v.id],
  );
}

// Uruchamia seed w transakcji, którą ZAWSZE cofamy.
async function seedInRollbackTx(targetTenantId, sourceTenantId, assertFn) {
  const rollbackSentinel = new Error('__rollback__');
  let seedError = null;
  let seedResult = null;
  try {
    await db.transaction(async (client) => {
      try {
        seedResult = await svc.seedDefaultConfigForTenant(client, targetTenantId, { sourceTenantId });
      } catch (err) {
        seedError = err;
      }
      if (assertFn) await assertFn(client);
      throw rollbackSentinel;
    });
  } catch (err) {
    if (err !== rollbackSentinel) throw err;
  }
  return { seedError, seedResult };
}

beforeAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
  ids[SOURCE_OK]     = await createTenant(SOURCE_OK);
  ids[SOURCE_BROKEN] = await createTenant(SOURCE_BROKEN);
  ids[TARGET]        = await createTenant(TARGET);

  await givePublishedConfig(ids[SOURCE_OK], [
    { key: 'dzial_handlowy', label: 'Dział handlowy', points: 60, active: true },
    { key: 'przetargi',      label: 'Przetargi',      points: 40, active: true },
    { key: 'siec_partnerow', label: 'Sieć partnerów', points: 15, active: false },
  ]);

  // Dokładnie sytuacja z audytu: gold został na starej sumie 70.
  await givePublishedConfig(ids[SOURCE_BROKEN], [
    { key: 'dzial_handlowy', label: 'Dział handlowy', points: 40, active: true },
    { key: 'przetargi',      label: 'Przetargi',      points: 30, active: true },
  ]);
});

afterAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

describe('seedDefaultConfigForTenant — walidacja configu źródłowego', () => {
  test('poprawne źródło (suma 100) → seed kopiuje config i publikuje wersję 1', async () => {
    const { seedError, seedResult } = await seedInRollbackTx(ids[TARGET], ids[SOURCE_OK], async (client) => {
      const { rows } = await client.query(
        `SELECT key, points, active FROM tenant_icp_signals WHERE tenant_id = $1 ORDER BY sort_order`,
        [ids[TARGET]],
      );
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.active).reduce((s, r) => s + Number(r.points), 0))
        .toBe(ICP_REQUIRED_SIGNALS_MAX_SCORE);

      const { rows: [cfg] } = await client.query(
        `SELECT current_version_id FROM tenant_icp_configs WHERE tenant_id = $1`, [ids[TARGET]],
      );
      expect(cfg.current_version_id).toBeTruthy();
    });

    expect(seedError).toBeNull();
    expect(seedResult.published).toBe(true);
    expect(seedResult.signalsSeeded).toBe(3);
  });

  test('niepoprawne źródło (suma 70) → jawny błąd 409, a nie cichy config bez publikacji', async () => {
    const { seedError } = await seedInRollbackTx(ids[TARGET], ids[SOURCE_BROKEN]);

    expect(seedError).toBeInstanceOf(Error);
    expect(seedError.status).toBe(409);
    expect(seedError.message).toMatch(/70/);
    expect(seedError.message).toMatch(new RegExp(String(ICP_REQUIRED_SIGNALS_MAX_SCORE)));
  });

  test('brak tenanta źródłowego → fallback do DEFAULT_SIGNALS, publikacja przechodzi', async () => {
    const { seedError, seedResult } = await seedInRollbackTx(ids[TARGET], null, async (client) => {
      const { rows } = await client.query(
        `SELECT key, points, active FROM tenant_icp_signals WHERE tenant_id = $1`, [ids[TARGET]],
      );
      expect(rows).toHaveLength(svc.DEFAULT_SIGNALS.length);
      expect(rows.filter((r) => r.active).reduce((s, r) => s + Number(r.points), 0))
        .toBe(ICP_REQUIRED_SIGNALS_MAX_SCORE);
    });

    expect(seedError).toBeNull();
    expect(seedResult.published).toBe(true);
  });

  test('wbudowany DEFAULT_SIGNALS sumuje się do wymaganej wartości', () => {
    expect(svc.computeMaxScore(svc.DEFAULT_SIGNALS)).toBe(ICP_REQUIRED_SIGNALS_MAX_SCORE);
  });

  test('izolacja: seed nie dotyka tenanta źródłowego', async () => {
    await seedInRollbackTx(ids[TARGET], ids[SOURCE_OK], async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM tenant_icp_signals WHERE tenant_id = $1`, [ids[SOURCE_OK]],
      );
      // Źródło ma tylko PUBLISHED snapshot, nigdy nie dostało wierszy LIVE.
      expect(rows[0].n).toBe(0);
    });
  });
});
