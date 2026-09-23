'use strict';

// Test regresyjny migracji 0293_icp_signal_opieka_durable_ownership.sql —
// CZWARTA TURA, wyłącznie opieka_nad_klientem (decyzja biznesowa 23.09).
// Benchmark 100 firm po trzeciej turze pokazał ~38% miękkich TRUE na tym
// sygnale (najwyższy odsetek z siedmiu). Migracja zaostrza definicję do
// TRWAŁEJ odpowiedzialności za konkretnego klienta i usuwa sprzeczność
// (lista równoważników zawierała "opiekun regionalny", co kolidowało
// z wykluczeniem przypisania do regionu z drugiej tury).
//
// Migracja wykonywana W TRANSAKCJI kończącej się ROLLBACK — test nie zostawia
// śladu w danych ani w _migrations. Tenanci testowi poza transakcją.

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0293_icp_signal_opieka_durable_ownership.sql'),
  'utf8',
);

const KEY = 'opieka_nad_klientem';
const UNTOUCHED = ['dzial_handlowy', 'zlozony_proces_sprzedazy', 'konsultacja_demo',
  'przetargi', 'siec_partnerow', 'cykliczna_obsluga_klienta_odnowienia'];
const SLUG_PREFIX = 'zz-icp-opieka-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';

async function withMigration(times, assertFn) {
  const rollbackSentinel = new Error('__rollback__');
  try {
    await db.transaction(async (client) => {
      for (let i = 0; i < times; i += 1) await client.query(MIGRATION_SQL);
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

describe('0293 — ICP: opieka_nad_klientem wymaga trwałej odpowiedzialności', () => {
  test('realne tenanty dostają dokładnie DEFAULT_SIGNALS.ai_definition dla opieka_nad_klientem', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT s.ai_definition FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.deleted_at IS NULL AND s.key = $1 AND t.slug NOT LIKE $2`,
        [KEY, ALL_TEST_SLUGS],
      );
      expect(rows.length).toBeGreaterThan(0);
      const expected = DEFAULT_SIGNALS.find((s) => s.key === KEY).ai_definition;
      for (const row of rows) expect(row.ai_definition).toBe(expected);
    });
  });

  test('pozostałe 6 sygnałów pozostaje NIETKNIĘTE', async () => {
    await withMigration(1, async (client) => {
      const before = await db.query(
        `SELECT key, ai_definition FROM tenant_icp_signals
          WHERE key = ANY($1::text[]) AND tenant_id = (SELECT id FROM tenants WHERE slug='crmtree-gold')
          ORDER BY key`, [UNTOUCHED]);
      const { rows } = await client.query(
        `SELECT key, ai_definition FROM tenant_icp_signals
          WHERE key = ANY($1::text[]) AND tenant_id = (SELECT id FROM tenants WHERE slug='crmtree-gold')
          ORDER BY key`, [UNTOUCHED]);
      expect(rows).toEqual(before.rows);
    });
  });

  test('points/active/label/short_description bez zmian', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT points, active, label, short_description FROM tenant_icp_signals
          WHERE key = $1 AND tenant_id = (SELECT id FROM tenants WHERE slug='crmtree-gold')`, [KEY]);
      const expected = DEFAULT_SIGNALS.find((s) => s.key === KEY);
      expect(Number(rows[0].points)).toBe(expected.points);
      expect(rows[0].active).toBe(expected.active);
      expect(rows[0].label).toBe(expected.label);
      expect(rows[0].short_description).toBe(expected.short_description);
    });
  });

  test('tenant z WŁASNĄ ai_definition zostaje NIETKNIĘTY', async () => {
    const CUSTOM = 'Własna definicja opieki klienta — nie ruszać.';
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('ICP opieka custom', $1, TRUE) RETURNING id`,
      [`${SLUG_PREFIX}custom`]);
    try {
      await db.query(
        `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
         VALUES ($1, $2, 'Dedykowana opieka', $3, 'podpis', 10, 'wysoka', true, 4)`,
        [t.id, KEY, CUSTOM]);
      await withMigration(1, async (client) => {
        const { rows } = await client.query(
          `SELECT ai_definition FROM tenant_icp_signals WHERE tenant_id=$1 AND key=$2`, [t.id, KEY]);
        expect(rows[0].ai_definition).toBe(CUSTOM);
      });
    } finally {
      await db.query(`DELETE FROM tenants WHERE id=$1`, [t.id]);
    }
  });

  test('idempotencja — drugie uruchomienie nic nie zmienia', async () => {
    await withMigration(2, async (client) => {
      const { rows } = await client.query(
        `SELECT ai_definition FROM tenant_icp_signals
          WHERE key=$1 AND tenant_id=(SELECT id FROM tenants WHERE slug='crmtree-gold')`, [KEY]);
      expect(rows[0].ai_definition).toBe(DEFAULT_SIGNALS.find((s) => s.key === KEY).ai_definition);
    });
  });

  // Regresje dla 5 konkretnych przypadków z benchmarku 100 firm
  test.each([
    ['Pharma Nord (region)', /przypisanie przedstawiciela\/handlowca TYLKO do\s+REGIONU\/terytorium\/województwa/],
    ['Pharma Nord (sprzeczność usunięta)', /dotyczy to także osoby nazwanej "opiekunem\s+regionalnym"\/"terytorialnym"/],
    ['Top Promotion (stała współpraca)', /ogólne hasło "stała współpraca"\/"wieloletnia współpraca" bez\s+wskazania osoby/],
    ['Lacroix (trusted partner)', /"partner biznesowy"\/"dedykowany\s+partner"\/"trusted partner" bez informacji/],
    ['Polski Transport (rola operacyjna)', /rola OPERACYJNA \(dyspozytor, koordynator transportu, planista, obsługa zleceń\)/],
    ['Nuuxe (rola techniczna)', /rola TECHNICZNA \(serwisant,\s+wdrożeniowiec, tester, inżynier wsparcia\)/],
  ])('REGRESJA: %s', (_label, pattern) => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === KEY).ai_definition;
    expect(def).toMatch(pattern);
  });

  test('recall zachowany — semantyczne odpowiedniki bez słowa "opiekun" nadal liczą się', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === KEY).ai_definition;
    expect(def).toMatch(/osoba prowadząca konto klienta/);
    expect(def).toMatch(/Specjalista ds\. Kluczowych Klientów/);
    expect(def).toMatch(/kontakt z konsultantem odpowiedzialnym za daną\s+branżę/);
  });
});
