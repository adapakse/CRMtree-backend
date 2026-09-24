'use strict';

// H2 (audyt Enrichment V2, 23.09) — regresja dla migrateIcpSignalsTo100.js:
// gałąź Gold wcześniej TYLKO dezaktywowała rozproszona_struktura/ecommerce_b2b
// i zakładała bez weryfikacji, że reszta punktów już się zgadza z nowym
// schematem (suma=100). Dla tenanta ze STARYMI punktami (suma=70, 8 sygnałów,
// brak cykliczna_obsluga_klienta_odnowienia) dawało to aktywną sumę 60 —
// LIVE config nigdy by się nie opublikował. Naprawka: gałąź Gold używa teraz
// tej samej resynchronizacji key-po-key co gałąź "pristine".
//
// Integracyjny (realna lokalna baza, jak inne testy tenantIcpConfigService),
// operuje WYŁĄCZNIE na dedykowanym testowym tenancie — NIGDY na prawdziwym
// tenancie 'crmtree-gold'. migrateTenant() nie odpytuje bazy o tenant.slug,
// tylko czyta pole z przekazanego obiektu, więc można bezpiecznie symulować
// "to jest Gold" na izolowanym tenant_id bez kolizji unique(slug).

const db = require('../config/database');
const svc = require('../services/tenantIcpConfigService');
const migrate = require('../scripts/migrateIcpSignalsTo100');

const SLUG = 'zz-migrate-gold-clone-test';
let tenantId;

async function cleanupIcpTables() {
  await db.query(`DELETE FROM tenant_icp_config_versions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_configs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_signals WHERE tenant_id = $1`, [tenantId]);
}

async function seedOldGoldSignals() {
  for (const def of migrate.OLD_DEFAULT_SIGNALS) {
    await db.query(
      `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, points, tier, active)
       VALUES ($1, $2, $3, 'test ai definition', $4, 'medium', $5)`,
      [tenantId, def.key, def.key, def.points, def.active],
    );
  }
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Migrate Gold Clone Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
});

afterEach(async () => {
  await cleanupIcpTables();
});

afterAll(async () => {
  await cleanupIcpTables();
  await db.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);
});

describe('migrateTenant — gałąź Gold (H2)', () => {
  test('stary Gold (suma=70, 8 sygnałów, brak cykliczna_obsluga_klienta_odnowienia) -> po migracji 100/100, bez duplikatów', async () => {
    await seedOldGoldSignals();

    const result = await migrate.migrateTenant({ id: tenantId, name: 'Gold Clone', slug: migrate.GOLD_SLUG });
    expect(result.action).toBe('migrated_gold');

    const { rows: signals } = await db.query(
      `SELECT key, points, active FROM tenant_icp_signals WHERE tenant_id = $1 ORDER BY key`,
      [tenantId],
    );

    // Bez duplikatów kluczy.
    const keys = signals.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);

    // Dokładnie zbiór kluczy z aktualnego DEFAULT_SIGNALS (9, w tym nowo dodany).
    expect(keys.sort()).toEqual(svc.DEFAULT_SIGNALS.map((s) => s.key).sort());
    expect(keys).toContain('cykliczna_obsluga_klienta_odnowienia');

    // Punkty/active zgodne 1:1 z DEFAULT_SIGNALS dla każdego klucza.
    const byKey = new Map(signals.map((s) => [s.key, s]));
    for (const def of svc.DEFAULT_SIGNALS) {
      const row = byKey.get(def.key);
      expect(row).toBeDefined();
      expect(row.active).toBe(def.active);
      expect(Number(row.points)).toBe(def.points);
    }

    const activeSum = signals.filter((s) => s.active).reduce((sum, s) => sum + Number(s.points), 0);
    expect(activeSum).toBe(100);

    // Konfiguracja faktycznie się opublikowała (nie tylko LIVE poprawny).
    const published = await svc.getPublishedConfig(tenantId);
    expect(published.isDefault).toBe(false);
    expect(published.maxScore).toBe(100);
  }, 20000);

  test('idempotencja — drugie uruchomienie na już zsynchronizowanym Gold nic nie psuje ani nie duplikuje', async () => {
    await seedOldGoldSignals();
    await migrate.migrateTenant({ id: tenantId, name: 'Gold Clone', slug: migrate.GOLD_SLUG });

    const result2 = await migrate.migrateTenant({ id: tenantId, name: 'Gold Clone', slug: migrate.GOLD_SLUG });
    expect(result2.action).toBe('migrated_gold');

    const { rows: signals } = await db.query(
      `SELECT key, points, active FROM tenant_icp_signals WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(signals).toHaveLength(svc.DEFAULT_SIGNALS.length);
    const activeSum = signals.filter((s) => s.active).reduce((sum, s) => sum + Number(s.points), 0);
    expect(activeSum).toBe(100);
  }, 20000);

  test('Gold już zgodny z DEFAULT_SIGNALS (stan po naprawce H2) -> migracja jest no-op, zostaje 100/100', async () => {
    for (const def of svc.DEFAULT_SIGNALS) {
      await db.query(
        `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, points, tier, active)
         VALUES ($1, $2, $3, 'test ai definition', $4, $5, $6)`,
        [tenantId, def.key, def.key, def.points, def.tier || 'medium', def.active],
      );
    }

    const result = await migrate.migrateTenant({ id: tenantId, name: 'Gold Clone', slug: migrate.GOLD_SLUG });
    expect(result.action).toBe('migrated_gold');

    const { rows: signals } = await db.query(
      `SELECT key, points, active FROM tenant_icp_signals WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(signals).toHaveLength(svc.DEFAULT_SIGNALS.length);
    const activeSum = signals.filter((s) => s.active).reduce((sum, s) => sum + Number(s.points), 0);
    expect(activeSum).toBe(100);
  }, 20000);
});
