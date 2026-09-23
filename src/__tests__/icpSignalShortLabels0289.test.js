'use strict';

// Test regresyjny migracji 0289_icp_signal_short_labels.sql — jednorazowe,
// świadome ujednolicenie WSZYSTKICH tenantów do krótkich nazw (decyzja
// produktowa 23.09, po incydencie z 0288: technika nadpisała ręczne skróty
// gold/nordic-solutions z powrotem na pełne nazwy z kodu).
//
// Od tej migracji label jest zwykłym ustawieniem per tenant — po jej
// zastosowaniu żaden kolejny seed/migracja/restart nie może już przywrócić
// tenanta do defaultu wbrew jego własnej, późniejszej zmianie.
//
// Migracja jest wykonywana W TRANSAKCJI, która zawsze kończy się ROLLBACK —
// test nie zostawia śladu ani na danych lokalnej bazy, ani w _migrations.
// Tenanci testowi są tworzeni/usuwani poza tą transakcją (zz-icp-labels-*).

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0289_icp_signal_short_labels.sql'),
  'utf8',
);

const SLUG_PREFIX = 'zz-icp-labels-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';
const OLD_LONG   = `${SLUG_PREFIX}old-long`;   // pełne nazwy z kodu sprzed 0289
const SHORT_OK   = `${SLUG_PREFIX}short-ok`;   // już ma docelowe krótkie nazwy
const GOLD_LIKE  = `${SLUG_PREFIX}gold-like`;  // symuluje incydent 0288: pełne po nadpisaniu
const NORDIC_LIKE = `${SLUG_PREFIX}nordic-like`;
const CUSTOM_TEXT = `${SLUG_PREFIX}custom-text`; // tenant z WŁASNYM, nietypowym labelem

// Docelowe krótkie nazwy z prompta użytkownika (23.09).
const TARGET_SHORT_LABELS = [
  ['dzial_handlowy',                       'Dział handlowy'],
  ['zlozony_proces_sprzedazy',             'Indywidualna wycena'],
  ['konsultacja_demo',                     'Konsultacja / demo'],
  ['opieka_nad_klientem',                  'Dedykowana opieka'],
  ['przetargi',                            'Przetargi'],
  ['siec_partnerow',                       'Sieć partnerów'],
  ['cykliczna_obsluga_klienta_odnowienia', 'Cykliczna obsługa'],
  ['rozproszona_struktura',                'Rozproszona struktura'],
  ['ecommerce_b2b',                        'E-commerce B2B'],
];

// Pełne nazwy z kodu sprzed 0289 (to, co miał każdy "zwykły" tenant, np.
// crmtree/vanguard-travel — zseedowane pełnymi nazwami przez 0285/0288).
const OLD_LONG_LABELS = {
  dzial_handlowy: 'Dział handlowy',
  zlozony_proces_sprzedazy: 'Złożony proces sprzedaży / indywidualna wycena',
  konsultacja_demo: 'Konsultacja, demo lub analiza potrzeb',
  opieka_nad_klientem: 'Dedykowana opieka nad klientem B2B',
  przetargi: 'Przetargi / dział ofertowania',
  siec_partnerow: 'Sieć partnerów / dealerów',
  cykliczna_obsluga_klienta_odnowienia: 'Cykliczna obsługa klienta / odnowienia',
  rozproszona_struktura: 'Rozproszona struktura sprzedaży / wiele oddziałów',
  ecommerce_b2b: 'Sprzedaż e-commerce (B2B)',
};

const POINTS = { dzial_handlowy: 30, zlozony_proces_sprzedazy: 25, konsultacja_demo: 15,
  opieka_nad_klientem: 10, przetargi: 5, siec_partnerow: 5,
  cykliczna_obsluga_klienta_odnowienia: 10, rozproszona_struktura: 5, ecommerce_b2b: 5 };
const ACTIVE = { rozproszona_struktura: false, ecommerce_b2b: false };
const KEYS_ORDER = ['dzial_handlowy', 'zlozony_proces_sprzedazy', 'konsultacja_demo',
  'opieka_nad_klientem', 'przetargi', 'rozproszona_struktura', 'siec_partnerow',
  'ecommerce_b2b', 'cykliczna_obsluga_klienta_odnowienia'];

const tenantIds = {};

async function createTenant(slug, labelsByKey) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
    [`ICP labels test ${slug}`, slug],
  );
  const tenantId = tenant.id;

  const signals = KEYS_ORDER.map((key, i) => ({
    key,
    label: labelsByKey[key],
    ai_definition: `definicja ${key}`,
    short_description: `podpis ${key}`,
    points: POINTS[key],
    tier: null,
    active: ACTIVE[key] !== undefined ? ACTIVE[key] : true,
    sort_order: i + 1,
  }));

  for (const s of signals) {
    await db.query(
      `INSERT INTO tenant_icp_signals
         (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, s.key, s.label, s.ai_definition, s.short_description, s.points, s.tier, s.active, s.sort_order],
    );
  }

  const maxScore = signals.filter((s) => s.active).reduce((sum, s) => sum + s.points, 0);
  const snapshot = signals.map((s) => ({ ...s, id: null, requires_any_of: null }));
  const { rows: [version] } = await db.query(
    `INSERT INTO tenant_icp_config_versions (tenant_id, version, qualification_threshold, max_score, snapshot)
     VALUES ($1, 1, 45, $2, $3::jsonb) RETURNING id`,
    [tenantId, maxScore, JSON.stringify(snapshot)],
  );
  await db.query(
    `INSERT INTO tenant_icp_configs (tenant_id, current_version_id, config_revision)
     VALUES ($1, $2, 1)`,
    [tenantId, version.id],
  );
  return tenantId;
}

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

async function readSignals(client, tenantId) {
  const { rows } = await client.query(
    `SELECT key, label, ai_definition, short_description, points, active
       FROM tenant_icp_signals WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  );
  return rows;
}

async function readPublished(client, tenantId) {
  const { rows: [row] } = await client.query(
    `SELECT v.version, v.max_score, v.snapshot, c.config_revision,
            (SELECT COUNT(*) FROM tenant_icp_config_versions x WHERE x.tenant_id = $1) AS versions_total
       FROM tenant_icp_configs c
       LEFT JOIN tenant_icp_config_versions v ON v.id = c.current_version_id
      WHERE c.tenant_id = $1`,
    [tenantId],
  );
  return row;
}

beforeAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);

  tenantIds[OLD_LONG] = await createTenant(OLD_LONG, OLD_LONG_LABELS);
  tenantIds[SHORT_OK] = await createTenant(
    SHORT_OK,
    Object.fromEntries(TARGET_SHORT_LABELS),
  );
  // Symuluje realny stan po incydencie 0288: gold/nordic-solutions miały
  // ręczne skróty, ale 0288 nadpisała je z powrotem na pełne nazwy z kodu.
  tenantIds[GOLD_LIKE]   = await createTenant(GOLD_LIKE, OLD_LONG_LABELS);
  tenantIds[NORDIC_LIKE] = await createTenant(NORDIC_LIKE, OLD_LONG_LABELS);
  // Tenant z własnym, biznesowym labelem — inny niż zarówno stary pełny, jak
  // i nowy krótki default. 0289 ma prawo go nadpisać (to jednorazowy,
  // świadomy reset), ale test dokumentuje, że to JEDYNY moment, kiedy to
  // się dzieje — patrz test "ręczna zmiana Tenant A nie wpływa na Tenant B".
  tenantIds[CUSTOM_TEXT] = await createTenant(CUSTOM_TEXT, {
    ...OLD_LONG_LABELS,
    zlozony_proces_sprzedazy: 'Zupełnie inna, własna nazwa klienta',
  });
});

afterAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

describe('0289 — ICP: jednorazowe ujednolicenie do krótkich labeli', () => {
  test('tenant ze starymi długimi nazwami → po 0289 ma krótkie', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[OLD_LONG]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
      for (const [key, shortLabel] of TARGET_SHORT_LABELS) {
        expect(byKey[key].label).toBe(shortLabel);
      }
    });
  });

  test('Gold/Nordic (symulacja po incydencie 0288) → mają krótkie', async () => {
    await withMigration(1, async (client) => {
      for (const tid of [tenantIds[GOLD_LIKE], tenantIds[NORDIC_LIKE]]) {
        const signals = await readSignals(client, tid);
        const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
        for (const [key, shortLabel] of TARGET_SHORT_LABELS) {
          expect(byKey[key].label).toBe(shortLabel);
        }
      }
    });
  });

  test('wszystkie 9 kluczy dostają dokładnie ustalone labelki', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[OLD_LONG]);
      expect(signals).toHaveLength(9);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s.label]));
      expect(byKey).toEqual(Object.fromEntries(TARGET_SHORT_LABELS));
    });
  });

  test('ai_definition, short_description, points, active pozostają bez zmian', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[OLD_LONG]);
      for (const s of signals) {
        expect(s.ai_definition).toBe(`definicja ${s.key}`);
        expect(s.short_description).toBe(`podpis ${s.key}`);
        expect(Number(s.points)).toBe(POINTS[s.key]);
        expect(s.active).toBe(ACTIVE[s.key] !== undefined ? ACTIVE[s.key] : true);
      }
    });
  });

  test('powstaje poprawny PUBLISHED snapshot z krótkimi nazwami', async () => {
    await withMigration(1, async (client) => {
      const published = await readPublished(client, tenantIds[OLD_LONG]);
      expect(published.max_score).toBe(100);
      expect(published.version).toBe(2);
      expect(published.snapshot).toHaveLength(9);
      const snapByKey = Object.fromEntries(published.snapshot.map((s) => [s.key, s]));
      for (const [key, shortLabel] of TARGET_SHORT_LABELS) {
        expect(snapByKey[key].label).toBe(shortLabel);
      }
    });
  });

  test('tenant już z krótkimi nazwami → zero zmian, zero nowej wersji', async () => {
    await withMigration(1, async (client) => {
      const published = await readPublished(client, tenantIds[SHORT_OK]);
      expect(Number(published.versions_total)).toBe(1);
      expect(published.version).toBe(1);
      expect(published.config_revision).toBe(1);

      const signals = await readSignals(client, tenantIds[SHORT_OK]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s.label]));
      expect(byKey).toEqual(Object.fromEntries(TARGET_SHORT_LABELS));
    });
  });

  test('druga migracja/no-op nie tworzy kolejnej wersji', async () => {
    await withMigration(2, async (client) => {
      const published = await readPublished(client, tenantIds[OLD_LONG]);
      // Dokładnie JEDNA nowa wersja mimo dwóch uruchomień.
      expect(Number(published.versions_total)).toBe(2);
      expect(published.version).toBe(2);
      expect(published.config_revision).toBe(2);

      const signals = await readSignals(client, tenantIds[OLD_LONG]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s.label]));
      expect(byKey).toEqual(Object.fromEntries(TARGET_SHORT_LABELS));
    });
  });

  // Po 0289 label jest zwykłym ustawieniem per tenant — ręczna zmiana
  // jednego tenanta nie może przeciekać do drugiego ani zostać cofnięta.
  test('po migracji: ręczna zmiana labela Tenant A nie wpływa na Tenant B', async () => {
    await withMigration(1, async (client) => {
      // Tenant A (custom-text) ręcznie zmienia nazwę PO 0289 — symulacja
      // edycji w Ustawieniach, poza samą migracją.
      await client.query(
        `UPDATE tenant_icp_signals SET label = 'Wycena indywidualna'
          WHERE tenant_id = $1 AND key = 'zlozony_proces_sprzedazy'`,
        [tenantIds[CUSTOM_TEXT]],
      );

      const aSignals = await readSignals(client, tenantIds[CUSTOM_TEXT]);
      expect(aSignals.find((s) => s.key === 'zlozony_proces_sprzedazy').label).toBe('Wycena indywidualna');

      // Tenant B (old-long, już zmigrowany w tej samej transakcji) zachowuje
      // domyślną krótką nazwę — zmiana A go nie dotyka.
      const bSignals = await readSignals(client, tenantIds[OLD_LONG]);
      expect(bSignals.find((s) => s.key === 'zlozony_proces_sprzedazy').label).toBe('Indywidualna wycena');
    });
  });

  // Runtime (seedDefaultConfigForTenant / getActiveConfig fallback) używa
  // DEFAULT_SIGNALS z tenantIcpConfigService.js — nie tej migracji SQL. Ten
  // test dokumentuje kontrakt: po 0289 DEFAULT_SIGNALS MUSI mieć te same
  // krótkie nazwy, inaczej nowy tenant dostałby inny label niż zmigrowany
  // stary, a restart/lazy-seed nowego tenanta nie przywróciłby ręcznej
  // zmiany istniejącego (bo to osobny tenant, osobne wiersze) — ale gdyby
  // DEFAULT_SIGNALS się rozjechało z 0289, powstałaby niespójność między
  // "nowym" a "zmigrowanym" tenantem od pierwszego dnia.
  test('DEFAULT_SIGNALS (nowe tenanty) ma te same krótkie nazwy co 0289', () => {
    const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');
    const byKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.label]));
    for (const [key, shortLabel] of TARGET_SHORT_LABELS) {
      expect(byKey[key]).toBe(shortLabel);
    }
  });

  test('runtime nie przywraca później ręcznie zmienionego labela do defaultu', async () => {
    // Nie ma miejsca w bieżącym kodzie (poza migracjami), które pisze do
    // tenant_icp_signals.label na podstawie DEFAULT_SIGNALS dla ISTNIEJĄCEGO
    // wiersza — seedDefaultConfigForTenant/materializePlaceholderSignals
    // (tenantIcpConfigService.js) insertują tylko BRAKUJĄCE wiersze
    // (NOT EXISTS / ON CONFLICT DO NOTHING), nigdy UPDATE istniejącego key.
    // Ten test to potwierdza empirycznie: wywołanie ścieżki materializacji
    // na tenancie, który JUŻ ma wiersz z ręcznie zmienionym labelem, go nie
    // rusza.
    const tenantIcpConfigService = require('../services/tenantIcpConfigService');
    await db.query(
      `UPDATE tenant_icp_signals SET label = 'Ręcznie zmieniona nazwa'
        WHERE tenant_id = $1 AND key = 'przetargi'`,
      [tenantIds[SHORT_OK]],
    );
    await tenantIcpConfigService.getActiveConfig(tenantIds[SHORT_OK]);

    const { rows } = await db.query(
      `SELECT label FROM tenant_icp_signals WHERE tenant_id = $1 AND key = 'przetargi'`,
      [tenantIds[SHORT_OK]],
    );
    expect(rows[0].label).toBe('Ręcznie zmieniona nazwa');

    // sprzątanie tego jednego ręcznego UPDATE (poza migracją/transakcją)
    await db.query(
      `UPDATE tenant_icp_signals SET label = 'Przetargi'
        WHERE tenant_id = $1 AND key = 'przetargi'`,
      [tenantIds[SHORT_OK]],
    );
  });
});
