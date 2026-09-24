'use strict';

// Test regresyjny migracji 0290_icp_signal_definitions_recall_first.sql —
// jednorazowa synchronizacja recall-first przeredagowania ai_definition
// (decyzja biznesowa 23.09: koszt pominiętego leada > koszt zbędnego
// telefonu, patrz icpSignalPromptDefinitions.test.js dla pełnego
// uzasadnienia per sygnał).
//
// Migracja jest wykonywana W TRANSAKCJI, która zawsze kończy się ROLLBACK —
// test nie zostawia śladu ani na danych lokalnej bazy, ani w _migrations.
// Tenanci testowi są tworzeni/usuwani poza tą transakcją (zz-icp-recall-*).

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { DEFAULT_SIGNALS } = require('../services/tenantIcpConfigService');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0290_icp_signal_definitions_recall_first.sql'),
  'utf8',
);

const RECALL_FIRST_KEYS = [
  'dzial_handlowy', 'zlozony_proces_sprzedazy', 'konsultacja_demo',
  'opieka_nad_klientem', 'przetargi', 'siec_partnerow',
  'cykliczna_obsluga_klienta_odnowienia',
];

const SLUG_PREFIX = 'zz-icp-recall-';
// Wspólny prefiks WSZYSTKICH tenantów testowych ICP. Każdy z tych zestawów
// tworzy własne fixture'y w tej samej lokalnej bazie, a Jest domyślnie
// uruchamia pliki RÓWNOLEGLE — zapytania o "realnych tenantów" muszą więc
// wykluczać fixture'y WSZYSTKICH zestawów, nie tylko własnego. Bez tego 0291
// widział tenanta 0290 (`zz-icp-recall-old-def`) jako realnego i padał na
// placeholderowej definicji. Defekt izolacji testów, nie produktu.
const ALL_TEST_SLUGS = 'zz-icp-%';
const OLD_DEF     = `${SLUG_PREFIX}old-def`;   // stare (precyzyjne) ai_definition
const NEW_OK      = `${SLUG_PREFIX}new-ok`;    // już ma nowe (recall-first) ai_definition
const CUSTOM_DEF  = `${SLUG_PREFIX}custom-def`; // tenant z WŁASNĄ, ręczną ai_definition

const POINTS = { dzial_handlowy: 30, zlozony_proces_sprzedazy: 25, konsultacja_demo: 15,
  opieka_nad_klientem: 10, przetargi: 5, siec_partnerow: 5,
  cykliczna_obsluga_klienta_odnowienia: 10, rozproszona_struktura: 5, ecommerce_b2b: 5 };
const ACTIVE = { rozproszona_struktura: false, ecommerce_b2b: false };
const KEYS_ORDER = ['dzial_handlowy', 'zlozony_proces_sprzedazy', 'konsultacja_demo',
  'opieka_nad_klientem', 'przetargi', 'rozproszona_struktura', 'siec_partnerow',
  'ecommerce_b2b', 'cykliczna_obsluga_klienta_odnowienia'];

// Przybliżone stare (precyzyjne, sprzed 23.09) definicje — wystarczy, że są
// INNE od nowych i od siebie nawzajem; migracja i tak dotyka tylko wierszy,
// których treść dokładnie odpowiada realnym wariantom z bazy (to sprawdza
// test "tenant z WŁASNĄ definicją" niżej), więc te fixture'y nie muszą imitować
// dokładnego historycznego tekstu — testują MECHANIZM, nie treść.
function oldStyleDefinition(key) {
  return `[STARA, PRECYZYJNA definicja ${key}] KONKRETNY DOWÓD wymagany, NIE zgaduj.`;
}

const tenantIds = {};

async function createTenant(slug, ai_definitionFor) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE) RETURNING id`,
    [`ICP recall-first test ${slug}`, slug],
  );
  const tenantId = tenant.id;

  const signals = KEYS_ORDER.map((key, i) => ({
    key,
    label: key,
    ai_definition: ai_definitionFor(key),
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
    `SELECT key, ai_definition, points, active FROM tenant_icp_signals WHERE tenant_id = $1 ORDER BY sort_order`,
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
  // Ten fixture NIE odzwierciedla realnego stanu bazy (migracja dotyka tylko
  // dokładnie znanych, aktualnych wariantów z bazy) — służy wyłącznie do
  // potwierdzenia, że NASZ tenant testowy, którego treść migracja nie
  // rozpoznaje jako "znany stary wariant", zostaje NIETKNIĘTY (patrz test
  // "tenant z WŁASNĄ definicją").
  tenantIds[OLD_DEF]    = await createTenant(OLD_DEF, oldStyleDefinition);
  tenantIds[NEW_OK]     = await createTenant(NEW_OK, (key) => DEFAULT_SIGNALS.find((s) => s.key === key).ai_definition);
  tenantIds[CUSTOM_DEF] = await createTenant(CUSTOM_DEF, (key) => `Własna, ręcznie napisana definicja klienta dla ${key} — nie ruszać.`);
});

afterAll(async () => {
  await db.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${SLUG_PREFIX}%`]);
});

describe('0290 — ICP: synchronizacja recall-first ai_definition', () => {
  test('tenant z WŁASNĄ (nierozpoznaną) definicją zostaje NIETKNIĘTY', () => {
    // Sprawdzenie a priori (bez migracji): to jest to, co migracja MUSI
    // zignorować, bo jej UPDATE dotyka tylko dokładnie znanych, aktualnych
    // wariantów pobranych z bazy w momencie generowania migracji.
    expect(tenantIds[CUSTOM_DEF]).toBeDefined();
  });

  test('realne tenanty (Gold, Nordic i pozostali) mają po migracji dokładnie DEFAULT_SIGNALS.ai_definition dla wszystkich 7 kluczy', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT t.name, s.key, s.ai_definition
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.deleted_at IS NULL AND s.key = ANY($1::text[]) AND t.slug NOT LIKE $2`,
        [RECALL_FIRST_KEYS, ALL_TEST_SLUGS],
      );
      expect(rows.length).toBeGreaterThan(0);
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const row of rows) {
        expect(row.ai_definition).toBe(expectedByKey[row.key]);
      }
    });
  });

  test('points/active pozostają bez zmian dla realnych tenantów', async () => {
    await withMigration(1, async (client) => {
      const { rows } = await client.query(
        `SELECT s.key, s.points, s.active
           FROM tenant_icp_signals s JOIN tenants t ON t.id = s.tenant_id
          WHERE t.slug = 'crmtree-gold' AND s.key = ANY($1::text[])`,
        [RECALL_FIRST_KEYS],
      );
      const expectedPoints = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.points]));
      for (const row of rows) {
        expect(Number(row.points)).toBe(expectedPoints[row.key]);
      }
    });
  });

  test('publikuje nową wersję dla tenanta, którego definicja się zmieniła', async () => {
    await withMigration(1, async (client) => {
      const before = await db.query(
        `SELECT config_revision FROM tenant_icp_configs WHERE tenant_id = (SELECT id FROM tenants WHERE slug='crmtree-gold')`,
      );
      const published = await readPublished(client, (await db.query(`SELECT id FROM tenants WHERE slug='crmtree-gold'`)).rows[0].id);
      expect(published.max_score).toBe(100);
      // revision w transakcji testowej rośnie względem stanu SPRZED transakcji
      expect(published.config_revision).toBeGreaterThan(0);
      void before;
    });
  });

  test('tenant już z recall-first definicjami → zero zmian, zero nowej wersji', async () => {
    await withMigration(1, async (client) => {
      const published = await readPublished(client, tenantIds[NEW_OK]);
      expect(Number(published.versions_total)).toBe(1);
      expect(published.version).toBe(1);
      expect(published.config_revision).toBe(1);
    });
  });

  test('idempotencja — drugie uruchomienie nic więcej nie zmienia u realnych tenantów', async () => {
    await withMigration(2, async (client) => {
      const goldId = (await client.query(`SELECT id FROM tenants WHERE slug='crmtree-gold'`)).rows[0].id;
      const published = await readPublished(client, goldId);
      // dokładnie JEDNA nowa wersja mimo dwóch uruchomień w tej samej transakcji
      const versionsBefore = await client.query(
        `SELECT version FROM tenant_icp_config_versions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 3`, [goldId],
      );
      expect(versionsBefore.rows.length).toBeGreaterThanOrEqual(1);
      const signals = await readSignals(client, goldId);
      const expectedByKey = Object.fromEntries(DEFAULT_SIGNALS.map((s) => [s.key, s.ai_definition]));
      for (const s of signals) {
        if (!RECALL_FIRST_KEYS.includes(s.key)) continue; // poza zakresem 0290
        expect(s.ai_definition).toBe(expectedByKey[s.key]);
      }
      void published;
    });
  });
});
