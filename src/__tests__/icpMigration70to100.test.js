'use strict';

// Test regresyjny migracji 0288_icp_signals_70_to_100.sql — automatyczne
// przejście starego seedu 0285 (suma aktywnych = 70, skrócone nazwy) na
// aktualny schemat (suma = 100, nazwy identyczne u wszystkich tenantów).
// Wcześniej robił to ręcznie uruchamiany skrypt
// src/scripts/migrateIcpSignalsTo100.js, przez co INT/PROD po deployu miały
// martwy enrichment do czasu, aż ktoś o nim pamiętał.
//
// Migracja jest wykonywana W TRANSAKCJI, która zawsze kończy się ROLLBACK —
// test nie zostawia śladu ani na danych lokalnej bazy, ani w _migrations.
// Tenanci testowi są tworzeni/usuwani poza tą transakcją (zz-icp-mig-*).

const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0288_icp_signals_70_to_100.sql'),
  'utf8',
);

const SLUG_PREFIX = 'zz-icp-mig-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';
const PRISTINE = `${SLUG_PREFIX}pristine`;
const CUSTOM   = `${SLUG_PREFIX}custom`;
const EMPTY    = `${SLUG_PREFIX}empty`;
const MIGRATED = `${SLUG_PREFIX}migrated`;
// Tenant technicznie już poprawny (9 sygnałów, suma 100), ale z własnymi
// nazwami i podpisami wpisanymi ręcznie przez admina w Ustawieniach.
const MIGRATED_LABELS = `${SLUG_PREFIX}migrated-labels`;

// Krotka sygnału: [key, label, short_description, points, tier, active, sort_order]

// Stan "tenant sprzed migracji": punkty starego seedu 0285 (suma 70) i brak
// short_description (kolumna doszła dopiero w 0287), ale nazwy RĘCZNIE
// skrócone przez admina — tak wyglądały realnie gold i nordic-solutions.
// (Sam 0285 seedował pełne nazwy; krótkie to już zmiana admina w Ustawieniach.)
const OLD_SEED = [
  ['dzial_handlowy',           'Dział handlowy',           null, 15, 'wysoka',  true, 1],
  ['zlozony_proces_sprzedazy', 'Indywidualna wycena',      null, 10, 'wysoka',  true, 2],
  ['konsultacja_demo',         'Konsultacja demo',         null, 10, 'wysoka',  true, 3],
  ['opieka_nad_klientem',      'Dedykowana opieka',        null, 10, 'wysoka',  true, 4],
  ['przetargi',                'Przetargi',                null, 10, 'wysoka',  true, 5],
  ['rozproszona_struktura',    'Rozproszona struktura',    null,  5, 'srednia', true, 6],
  ['siec_partnerow',           'Sieć partnerów',           null,  5, 'srednia', true, 7],
  ['ecommerce_b2b',            'E-commerce B2B',           null,  5, 'srednia', true, 8],
];

// Stan docelowy — 1:1 z DEFAULT_SIGNALS w tenantIcpConfigService.js.
const TARGET = [
  ['dzial_handlowy', 'Dział handlowy',
   'Jawnie nazwany dział/zespół sprzedaży albo kilka konkretnych osób pełniących role handlowe.',      30, 'wysoka',  true,  1],
  ['zlozony_proces_sprzedazy', 'Złożony proces sprzedaży / indywidualna wycena',
   'Firma przygotowuje ofertę, wycenę lub warunki indywidualnie dla konkretnego klienta.',             25, 'wysoka',  true,  2],
  ['konsultacja_demo', 'Konsultacja, demo lub analiza potrzeb',
   'Przed zakupem występuje realny etap doradztwa, analizy potrzeb, doboru rozwiązania lub demo.',     15, 'wysoka',  true,  3],
  ['opieka_nad_klientem', 'Dedykowana opieka nad klientem B2B',
   'Konkretny opiekun/KAM/osoba lub zespół jest stale odpowiedzialny za klienta, konto albo segment.', 10, 'wysoka',  true,  4],
  ['przetargi', 'Przetargi / dział ofertowania',
   'Firma występuje jako wykonawca/dostawca w przetargach, nie jako zamawiający.',                      5, 'wysoka',  true,  5],
  ['rozproszona_struktura', 'Rozproszona struktura sprzedaży / wiele oddziałów',
   'Firma ma własne, fizycznie rozproszone oddziały lub przedstawicieli terytorialnych.',               5, 'srednia', false, 6],
  ['siec_partnerow', 'Sieć partnerów / dealerów',
   'Niezależni dealerzy/resellerzy/partnerzy sprzedają ofertę badanej firmy.',                          5, 'srednia', true,  7],
  ['ecommerce_b2b', 'Sprzedaż e-commerce (B2B)',
   'Firma ma sklep/platformę zamówieniową B2B z realną obsługą zamówień online.',                       5, 'srednia', false, 8],
  ['cykliczna_obsluga_klienta_odnowienia', 'Cykliczna obsługa klienta / odnowienia',
   'Po sprzedaży występują powtarzalne zdarzenia: przeglądy, serwis, odnowienia, kolejne wizyty itp.', 10, null,      true,  9],
];

// Ten sam, poprawny schemat 100 pkt, ale z ręcznie zmienionymi nazwami i
// podpisami — migracja nie ma prawa ich tknąć ani opublikować z tego powodu
// nowej wersji configu.
const TARGET_CUSTOM_LABELS = TARGET.map(
  ([key, , , points, tier, active, sortOrder]) =>
    [key, `Własna nazwa ${key}`, `Własny podpis ${key}`, points, tier, active, sortOrder],
);

const tenantIds = {};

async function createTenant(slug, signals) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
    [`ICP migration test ${slug}`, slug],
  );
  const tenantId = tenant.id;

  for (const [key, label, shortDescription, points, tier, active, sortOrder] of signals) {
    await db.query(
      `INSERT INTO tenant_icp_signals
         (tenant_id, key, label, ai_definition, short_description, points, tier, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, key, label, `definicja ${key}`, shortDescription, points, tier, active, sortOrder],
    );
  }

  if (signals.length) {
    const maxScore = signals.filter((s) => s[5]).reduce((sum, s) => sum + s[3], 0);
    const snapshot = signals.map(([key, label, shortDescription, points, tier, active, sortOrder]) => ({
      key, label, short_description: shortDescription, ai_definition: `definicja ${key}`,
      points, tier, active, sort_order: sortOrder, requires_any_of: null,
    }));
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
  }
  return tenantId;
}

// Uruchamia migrację `times` razy w jednej transakcji, odpala asercje na tym
// samym kliencie i ZAWSZE cofa transakcję.
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
    `SELECT key, points, active, sort_order, label, ai_definition, short_description
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

const activeSum = (signals) => signals.filter((s) => s.active).reduce((sum, s) => sum + Number(s.points), 0);

beforeAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
  tenantIds[PRISTINE] = await createTenant(PRISTINE, OLD_SEED);
  tenantIds[MIGRATED] = await createTenant(MIGRATED, TARGET);
  tenantIds[EMPTY]    = await createTenant(EMPTY, []);
  tenantIds[MIGRATED_LABELS] = await createTenant(MIGRATED_LABELS, TARGET_CUSTOM_LABELS);
  // Realnie dostosowany config: własne punkty + własny, dodatkowy sygnał.
  tenantIds[CUSTOM]   = await createTenant(CUSTOM, [
    ...OLD_SEED.map((s) => (s[0] === 'dzial_handlowy' ? [s[0], s[1], s[2], 20, s[4], s[5], s[6]] : s)),
    ['wlasny_sygnal_tenanta', 'Własny sygnał', null, 7, null, true, 9],
  ]);
});

afterAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

describe('0288 — migracja ICP 70 → 100', () => {
  test('pristine (seed 0285, suma 70) → 9 sygnałów, suma 100, nowa opublikowana wersja', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);

      expect(signals).toHaveLength(9);
      expect(activeSum(signals)).toBe(100);

      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
      expect(Number(byKey.dzial_handlowy.points)).toBe(30);
      expect(Number(byKey.zlozony_proces_sprzedazy.points)).toBe(25);
      expect(Number(byKey.konsultacja_demo.points)).toBe(15);
      expect(Number(byKey.przetargi.points)).toBe(5);
      // Dwa sygnały wyłączone w aktualnym schemacie.
      expect(byKey.rozproszona_struktura.active).toBe(false);
      expect(byKey.ecommerce_b2b.active).toBe(false);
      // Sygnał, którego seed 0285 w ogóle nie zawierał — dodany z pełną treścią.
      expect(byKey.cykliczna_obsluga_klienta_odnowienia).toBeDefined();
      expect(Number(byKey.cykliczna_obsluga_klienta_odnowienia.points)).toBe(10);
      expect(byKey.cykliczna_obsluga_klienta_odnowienia.ai_definition.length).toBeGreaterThan(50);

      const published = await readPublished(client, tenantIds[PRISTINE]);
      expect(published.max_score).toBe(100);
      expect(published.version).toBe(2);
      expect(published.snapshot).toHaveLength(9);
      expect(published.config_revision).toBe(2);
    });
  });

  // A. Stary 70-pkt tenant ze skróconymi nazwami → punkty przechodzą na 100,
  // ale ręczne nazwy zostają nietknięte (config ICP jest per tenant).
  test('A: stary seed 70 + własne skrócone nazwy → 100 pkt, nazwy BEZ ZMIAN', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));

      expect(activeSum(signals)).toBe(100);

      // Każdy sygnał ze starego seedu zachowuje swoją nazwę.
      for (const [key, label] of OLD_SEED) {
        expect(byKey[key].label).toBe(label);
      }
      expect(byKey.zlozony_proces_sprzedazy.label).toBe('Indywidualna wycena');
      expect(byKey.opieka_nad_klientem.label).toBe('Dedykowana opieka');

      // Enrichment czyta PUBLISHED — tam też muszą zostać własne nazwy.
      const published = await readPublished(client, tenantIds[PRISTINE]);
      const snapByKey = Object.fromEntries(published.snapshot.map((s) => [s.key, s]));
      expect(snapByKey.zlozony_proces_sprzedazy.label).toBe('Indywidualna wycena');
      expect(snapByKey.opieka_nad_klientem.label).toBe('Dedykowana opieka');
      expect(published.max_score).toBe(100);
    });
  });

  // B. Własne ai_definition i short_description przeżywają migrację.
  test('B: własne ai_definition i short_description zostają bez zmian', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[MIGRATED_LABELS]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));

      for (const [key] of TARGET_CUSTOM_LABELS) {
        expect(byKey[key].ai_definition).toBe(`definicja ${key}`);
        expect(byKey[key].short_description).toBe(`Własny podpis ${key}`);
        expect(byKey[key].label).toBe(`Własna nazwa ${key}`);
      }
    });
  });

  // Świadomy wyjątek: short_description dodane w 0287 i nigdy nie backfillowane
  // (NULL = pusty tooltip) jest UZUPEŁNIANE — to wypełnienie pustki, nie
  // nadpisanie decyzji admina. Nazwa nadal zostaje własna.
  test('B2: puste (NULL) short_description jest uzupełniane, label nadal własny', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
      const targetByKey = Object.fromEntries(TARGET.map(([key, , sd]) => [key, sd]));

      expect(byKey.zlozony_proces_sprzedazy.short_description).toBe(targetByKey.zlozony_proces_sprzedazy);
      expect(byKey.zlozony_proces_sprzedazy.label).toBe('Indywidualna wycena');
    });
  });

  // C. Tenant już poprawny technicznie (9/100), ale z własnymi nazwami —
  // ponowne uruchomienie migracji musi być prawdziwym no-opem.
  test('C: poprawny 100-pkt tenant z własnymi nazwami → zero zmian, zero nowych wersji', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[MIGRATED_LABELS]);
      expect(signals).toHaveLength(9);
      expect(activeSum(signals)).toBe(100);

      const published = await readPublished(client, tenantIds[MIGRATED_LABELS]);
      expect(Number(published.versions_total)).toBe(1);
      expect(published.version).toBe(1);
      expect(published.config_revision).toBe(1);
    });
  });

  // D. Sygnał, którego tenant w ogóle nie ma, dochodzi z pełnymi defaultami.
  test('D: brakujący sygnał dodany z domyślną nazwą, definicją i podpisem', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);
      const added = signals.find((s) => s.key === 'cykliczna_obsluga_klienta_odnowienia');
      const [, defLabel, defShort] = TARGET.find(([key]) => key === 'cykliczna_obsluga_klienta_odnowienia');

      expect(added).toBeDefined();
      expect(added.label).toBe(defLabel);
      expect(added.short_description).toBe(defShort);
      expect(added.ai_definition.length).toBeGreaterThan(50);
      expect(Number(added.points)).toBe(10);
      expect(added.active).toBe(true);
    });
  });

  test('migracja NIE dotyka definicji AI istniejących sygnałów', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);
      const dzial = signals.find((s) => s.key === 'dzial_handlowy');
      expect(dzial.ai_definition).toBe('definicja dzial_handlowy');
    });
  });

  test('tenant z własnym configiem zostaje nietknięty (też nazwy)', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[CUSTOM]);

      expect(signals).toHaveLength(9);
      const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
      expect(Number(byKey.dzial_handlowy.points)).toBe(20);
      expect(Number(byKey.przetargi.points)).toBe(10);
      expect(byKey.rozproszona_struktura.active).toBe(true);
      expect(byKey.wlasny_sygnal_tenanta).toBeDefined();
      expect(byKey.cykliczna_obsluga_klienta_odnowienia).toBeUndefined();
      // Skrócone nazwy zostają — tenant sam decyduje o swoim configu.
      expect(byKey.zlozony_proces_sprzedazy.label).toBe('Indywidualna wycena');
      expect(byKey.opieka_nad_klientem.label).toBe('Dedykowana opieka');

      const published = await readPublished(client, tenantIds[CUSTOM]);
      expect(published.version).toBe(1);
      expect(Number(published.versions_total)).toBe(1);
      expect(published.config_revision).toBe(1);
    });
  });

  test('tenant bez wierszy zostaje na fallbacku DEFAULT_SIGNALS (0 wierszy)', async () => {
    await withMigration(1, async (client) => {
      const signals = await readSignals(client, tenantIds[EMPTY]);
      expect(signals).toHaveLength(0);
    });
  });

  test('tenant już zgodny ze wzorcem → brak nowej wersji (no-op)', async () => {
    await withMigration(1, async (client) => {
      const published = await readPublished(client, tenantIds[MIGRATED]);
      expect(Number(published.versions_total)).toBe(1);
      expect(published.max_score).toBe(100);
      expect(published.config_revision).toBe(1);
    });
  });

  test('idempotencja — drugie uruchomienie nic nie zmienia', async () => {
    await withMigration(2, async (client) => {
      const signals = await readSignals(client, tenantIds[PRISTINE]);
      expect(signals).toHaveLength(9);
      expect(activeSum(signals)).toBe(100);

      const published = await readPublished(client, tenantIds[PRISTINE]);
      // Dokładnie JEDNA nowa wersja mimo dwóch uruchomień.
      expect(Number(published.versions_total)).toBe(2);
      expect(published.version).toBe(2);
      expect(published.max_score).toBe(100);
      expect(published.config_revision).toBe(2);

      const custom = await readSignals(client, tenantIds[CUSTOM]);
      expect(Number(custom.find((s) => s.key === 'dzial_handlowy').points)).toBe(20);

      // Tenant poprawny, lecz z własnymi nazwami — po DWÓCH uruchomieniach
      // nadal ani jednej nowej wersji i nadal własne nazwy.
      const labelsTenant = await readPublished(client, tenantIds[MIGRATED_LABELS]);
      expect(Number(labelsTenant.versions_total)).toBe(1);
      expect(labelsTenant.config_revision).toBe(1);
      const labelsSignals = await readSignals(client, tenantIds[MIGRATED_LABELS]);
      expect(labelsSignals.find((s) => s.key === 'przetargi').label).toBe('Własna nazwa przetargi');
    });
  });
});
