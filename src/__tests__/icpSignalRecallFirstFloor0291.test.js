'use strict';

// Test regresyjny migracji 0291_icp_signal_definitions_recall_first_floor.sql
// — DRUGA TURA recall-first (decyzja biznesowa 23.09, po przeglądzie
// pierwszej tury 0290). Przywraca wymóg choć minimalnego kontekstu/
// interakcji dla 6 z 7 aktywnych sygnałów, bo pojedyncze, bardzo słabe fakty
// (alias sprzedaz@/sales@, sama funkcja Dyrektora Sprzedaży, samo duże
// portfolio klientów publicznych) mogły samodzielnie zapalać wysokopunktowe
// sygnały. siec_partnerow celowo POMINIĘTY (bez analogicznego problemu).
//
// Migracja jest wykonywana W TRANSAKCJI, która zawsze kończy się ROLLBACK —
// test nie zostawia śladu ani na danych lokalnej bazy, ani w _migrations.
// Tenanci testowi są tworzeni/usuwani poza tą transakcją (zz-icp-floor-*).

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0291_icp_signal_definitions_recall_first_floor.sql'),
  'utf8',
);

const FLOOR_KEYS = [
  'dzial_handlowy', 'zlozony_proces_sprzedazy', 'konsultacja_demo',
  'opieka_nad_klientem', 'przetargi', 'cykliczna_obsluga_klienta_odnowienia',
];

const SLUG_PREFIX = 'zz-icp-floor-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';
const CUSTOM_DEF  = `${SLUG_PREFIX}custom-def`;

async function withMigration(times, assertFn) {
  const rollbackSentinel = new Error('__rollback__');
  try {
    await db.transaction(async (client) => {
      for (let i = 0; i < times; i += 1) {
        await client.query(MIGRATION_SQL);
      }
      await assertFn(client);
      throw rollbackSentinel;
    });
  } catch (err) {
    if (err !== rollbackSentinel) throw err;
  }
}

beforeAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

afterAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

describe('0291 — ICP: recall-first, druga tura (przywrócony floor)', () => {
  test('realne tenanty mają po migracji dokładnie DEFAULT_SIGNALS.ai_definition dla wszystkich 6 skorygowanych kluczy', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT t.name, s.key, s.ai_definition
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.deleted_at IS NULL AND s.key = ANY($1::text[]) AND t.slug NOT LIKE $2`,
        [FLOOR_KEYS, ALL_TEST_SLUGS],
      );
      expect(rows.length).toBeGreaterThan(0);
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const row of rows) {
        expect(row.ai_definition).toBe(expectedByKey[row.key]);
      }
    });
  });

  test('siec_partnerow (celowo pominięty) pozostaje NIETKNIĘTY przez tę migrację', async () => {
    await withMigration(1, async (client) => {
      const before = await db.query(
        `SELECT ai_definition FROM tenant_icp_signals WHERE key = 'siec_partnerow' AND tenant_id = (SELECT id FROM tenants WHERE slug = 'crmtree-gold')`,
      );
      const { rows } = await client.query(
        `SELECT ai_definition FROM tenant_icp_signals WHERE key = 'siec_partnerow' AND tenant_id = (SELECT id FROM tenants WHERE slug = 'crmtree-gold')`,
      );
      expect(rows[0].ai_definition).toBe(before.rows[0].ai_definition);
    });
  });

  test('points/active/label/short_description pozostają bez zmian', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT s.key, s.points, s.active, s.label, s.short_description
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.slug = 'crmtree-gold' AND s.key = ANY($1::text[])`,
        [FLOOR_KEYS],
      );
      const expected = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s]));
      for (const row of rows) {
        expect(Number(row.points)).toBe(expected[row.key].points);
        expect(row.active).toBe(expected[row.key].active);
        expect(row.label).toBe(expected[row.key].label);
        expect(row.short_description).toBe(expected[row.key].short_description);
      }
    });
  });

  test('targeted: tylko wiersze z ROZPOZNANYM (pierwsza tura) tekstem są aktualizowane — dowód konstrukcji migracji', () => {
    // Migracja buduje UPDATE ... WHERE s.ai_definition = ANY(d.old_variants),
    // gdzie old_variants to dokładne, aktualne (przed migracją) wartości z
    // bazy pobrane w momencie generowania migracji (patrz jej nagłówek) —
    // nie "wszystkie wiersze o tym kluczu". To gwarantuje nietkniętość
    // dowolnego tenanta z ręcznie zmienioną ai_definition, testowane niżej.
    expect(MIGRATION_SQL).toMatch(/AND s\.ai_definition = ANY\(d\.old_variants\)/);
  });

  test('tenant z WŁASNĄ, ręcznie zmienioną ai_definition dla dzial_handlowy zostaje NIETKNIĘTY', async () => {
    const CUSTOM_TEXT = 'Własna, ręcznie napisana definicja klienta dla dzial_handlowy — nie ruszać.';
    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('ICP floor custom test', $1, TRUE) RETURNING id`,
      [CUSTOM_DEF],
    );
    try {
      await db.query(
        `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
         VALUES ($1, 'dzial_handlowy', 'Dział handlowy', $2, 'podpis', 30, 'wysoka', true, 1)`,
        [tenant.id, CUSTOM_TEXT],
      );
      await withMigration(1, async (client) => {
        const { rows } = await client.query(
          `SELECT ai_definition FROM tenant_icp_signals WHERE tenant_id = $1 AND key = 'dzial_handlowy'`,
          [tenant.id],
        );
        expect(rows[0].ai_definition).toBe(CUSTOM_TEXT);
      });
    } finally {
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]);
    }
  });

  test('idempotencja — drugie uruchomienie w tej samej transakcji nic więcej nie zmienia', async () => {
    await withMigration(2, async (client) => {
      const goldId = (await client.query(`SELECT id FROM tenants WHERE slug='crmtree-gold'`)).rows[0].id;
      const { rows } = await client.query(
        `SELECT key, ai_definition FROM tenant_icp_signals WHERE tenant_id = $1 AND key = ANY($2::text[])`,
        [goldId, FLOOR_KEYS],
      );
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const row of rows) {
        expect(row.ai_definition).toBe(expectedByKey[row.key]);
      }
    });
  });
});
