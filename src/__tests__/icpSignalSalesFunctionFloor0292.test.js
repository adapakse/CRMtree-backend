'use strict';

// Test regresyjny migracji 0292_icp_signal_definitions_sales_function_floor.sql
// — TRZECIA TURA recall-first (decyzja biznesowa 23.09, po benchmarku 100
// firm). Dotyka WYŁĄCZNIE dzial_handlowy i konsultacja_demo. Benchmark
// pokazał: 63% wyników miało dokładnie tercet dzial_handlowy+
// zlozony_proces_sprzedazy+konsultacja_demo, 81% przekraczało próg 45 —
// za dużo jak na losowy import firm. Ta migracja przywraca wymóg realnej
// funkcji sprzedażowej (nie dowolnego śladu biznesowego) i realnej
// interakcji przedsprzedażowej, plus zasadę niezależności dowodu.
//
// Migracja jest wykonywana W TRANSAKCJI, która zawsze kończy się ROLLBACK —
// test nie zostawia śladu ani na danych lokalnej bazy, ani w _migrations.
// Tenanci testowi są tworzeni/usuwani poza tą transakcją (zz-icp-sales-*).

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');
const { PROMPT_STATIC_HEADER } = require('../services/prospectEnrichmentService');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0292_icp_signal_definitions_sales_function_floor.sql'),
  'utf8',
);

const THIRD_TOUR_KEYS = ['dzial_handlowy', 'konsultacja_demo'];
const UNTOUCHED_KEYS = ['zlozony_proces_sprzedazy', 'opieka_nad_klientem', 'przetargi', 'siec_partnerow', 'cykliczna_obsluga_klienta_odnowienia'];

const SLUG_PREFIX = 'zz-icp-sales-';
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

describe('0292 — ICP: trzecia tura, realna funkcja sprzedażowa (dzial_handlowy + konsultacja_demo)', () => {
  test('realne tenanty mają po migracji dokładnie DEFAULT_SIGNALS.ai_definition dla obu skorygowanych kluczy', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT t.name, s.key, s.ai_definition
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.deleted_at IS NULL AND s.key = ANY($1::text[]) AND t.slug NOT LIKE $2`,
        [THIRD_TOUR_KEYS, ALL_TEST_SLUGS],
      );
      expect(rows.length).toBeGreaterThan(0);
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const row of rows) {
        expect(row.ai_definition).toBe(expectedByKey[row.key]);
      }
    });
  });

  test('pozostałe 5 sygnałów (zlozony_proces_sprzedazy, opieka, przetargi, siec_partnerow, cykliczna) pozostają NIETKNIĘTE', async () => {
    await withMigration(1, async (client) => {
      const before = await db.query(
        `SELECT key, ai_definition FROM tenant_icp_signals
          WHERE key = ANY($1::text[]) AND tenant_id = (SELECT id FROM tenants WHERE slug = 'crmtree-gold')
          ORDER BY key`,
        [UNTOUCHED_KEYS],
      );
      const { rows } = await client.query(
        `SELECT key, ai_definition FROM tenant_icp_signals
          WHERE key = ANY($1::text[]) AND tenant_id = (SELECT id FROM tenants WHERE slug = 'crmtree-gold')
          ORDER BY key`,
        [UNTOUCHED_KEYS],
      );
      expect(rows).toEqual(before.rows);
    });
  });

  test('points/active/label/short_description pozostają bez zmian', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT s.key, s.points, s.active, s.label, s.short_description
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.slug = 'crmtree-gold' AND s.key = ANY($1::text[])`,
        [THIRD_TOUR_KEYS],
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

  test('tenant z WŁASNĄ, ręcznie zmienioną ai_definition dla konsultacja_demo zostaje NIETKNIĘTY', async () => {
    const CUSTOM_TEXT = 'Własna, ręcznie napisana definicja klienta dla konsultacja_demo — nie ruszać.';
    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('ICP sales-function custom test', $1, TRUE) RETURNING id`,
      [CUSTOM_DEF],
    );
    try {
      await db.query(
        `INSERT INTO tenant_icp_signals (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
         VALUES ($1, 'konsultacja_demo', 'Konsultacja / demo', $2, 'podpis', 15, 'wysoka', true, 3)`,
        [tenant.id, CUSTOM_TEXT],
      );
      await withMigration(1, async (client) => {
        const { rows } = await client.query(
          `SELECT ai_definition FROM tenant_icp_signals WHERE tenant_id = $1 AND key = 'konsultacja_demo'`,
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
        [goldId, THIRD_TOUR_KEYS],
      );
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const row of rows) {
        expect(row.ai_definition).toBe(expectedByKey[row.key]);
      }
    });
  });

  // ── Regresje dla dokładnych przypadków z benchmarku 100 firm ─────────────

  test('REGRESJA (Energokessel): sam Dyrektor ds. Handlowych w zarządzie, bez opisu roli, NIE daje TRUE-wystarczającego dowodu', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy').ai_definition;
    expect(def).toMatch(/sama osoba "Dyrektor Handlowy"\/"Dyrektor ds\. Handlowych" wymieniona np\. w składzie\s+zarządu, BEZ żadnego opisu, że realnie prowadzi sprzedaż/);
  });

  test('REGRESJA (Telbeskid): sekcja "Dla firm"/"Dla biznesu" NIE wystarcza do dzial_handlowy', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy').ai_definition;
    expect(def).toMatch(/sekcja\/strona "Dla firm"\/"Dla\s+biznesu" \(to oferta kierowana do biznesu, nie dowód na istnienie działu sprzedaży\)/);
  });

  test('REGRESJA (Budrem): ogólne "biuro"/"obsługa zleceń" NIE wystarcza do dzial_handlowy', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy').ai_definition;
    expect(def).toMatch(/ogólne "biuro"\/"obsługa zleceń" \(to może być\s+administracja\/logistyka, nie\s+sprzedaż\)/);
  });

  test('REGRESJA (Tank Mark): samo "przedstawimy ofertę"/"skontaktuj się" NIE wystarcza do konsultacja_demo', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === 'konsultacja_demo').ai_definition;
    expect(def).toMatch(/samo "skontaktuj się z nami"\/"przedstawimy ofertę"\/"zapytaj o ofertę" — to zaproszenie\s+do kontaktu, nie dowód analizy\/doboru/);
  });

  test('REGRESJA (Izoserwis): samo biuro projektowe NIE może automatycznie zapalić zarówno dzial_handlowy jak i konsultacja_demo', () => {
    const dzial = DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy').ai_definition;
    const konsultacja = DEFAULT_SIGNALS.find((s) => s.key === 'konsultacja_demo').ai_definition;
    expect(dzial).toMatch(/samo biuro projektowe\/dział B\+R\/dział techniczny/);
    expect(konsultacja).toMatch(/samo istnienie biura\s+projektowego \(to zdolność projektowa, nie opisany etap rozmowy z klientem/);
    expect(konsultacja).toMatch(/oceń każdy sygnał NIEZALEŻNIE — licz go dla więcej niż jednego sygnału\s+TYLKO jeśli fragment faktycznie opisuje osobne zjawiska biznesowe/);
    expect(PROMPT_STATIC_HEADER).toMatch(/ZASADA NIEZALEŻNOŚCI DOWODU/);
  });

  test('REGRESJA (Posadzki Przemysłowe): ogólne "doradztwo techniczno-handlowe" bez struktury/ludzi NIE wystarcza do dzial_handlowy', () => {
    const def = DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy').ai_definition;
    expect(def).toMatch(/ogólne hasło "doradztwo techniczno-\s*handlowe" BEZ wskazania konkretnych ludzi lub struktury\s+odpowiedzialnej za sprzedaż/);
  });
});
