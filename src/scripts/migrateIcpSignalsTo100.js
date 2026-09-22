'use strict';
// ─────────────────────────────────────────────────────────────────
// Jednorazowy skrypt migracji: ICP signals suma=70 (stary model, gates+bonus
// wliczone w icp_score) → suma=100 (nowy model, wyłącznie sygnały, decyzja
// 2026-09-22). Uruchom ręcznie: `node src/scripts/migrateIcpSignalsTo100.js`.
//
// MUSI zostać uruchomiony PRZED deployem kodu, który wymaga
// ICP_REQUIRED_SIGNALS_MAX_SCORE=100 — w przeciwnym razie enrichOne() rzuca
// błąd (per-prospekt, złapany, ale enrichment efektywnie martwy) dla każdego
// tenanta, którego PUBLISHED snapshot wciąż ma max_score=70.
//
// Trzy ścieżki per tenant:
//   1. Brak wierszy w tenant_icp_signals (czysty fallback) — nic nie robimy,
//      automatycznie dostanie nowy DEFAULT_SIGNALS przy najbliższym odczycie.
//   2. CRMtree Gold (slug 'crmtree-gold') — jawny override: wyłącz
//      rozproszona_struktura i ecommerce_b2b (reszta punktów już się zgadza
//      z ustalonym schematem, patrz plan migracji).
//   3. Config identyczny 1:1 ze STARYM DEFAULT_SIGNALS (8 sygnałów, te same
//      key/points/active) — resynchronizuj key-po-key do NOWEGO
//      DEFAULT_SIGNALS (tenantIcpConfigService.DEFAULT_SIGNALS), dodając
//      brakujący 9. sygnał (cykliczna_obsluga_klienta_odnowienia).
//   4. Wszystko inne (realnie dostosowany config, nie Gold) — POMIŃ, wypisz
//      do ręcznego przeglądu. Nigdy nie zgaduje nowych wag za admina/tenanta.
//
// Skrypt jest idempotentny — po migracji żaden tenant nie jest już "pristine
// ze starym configiem", więc drugie uruchomienie nic więcej nie zmieni.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const svc = require('../services/tenantIcpConfigService');
const enrichSvc = require('../services/prospectEnrichmentService');

const OLD_DEFAULT_SIGNALS = [
  { key: 'dzial_handlowy', points: 15, active: true },
  { key: 'zlozony_proces_sprzedazy', points: 10, active: true },
  { key: 'konsultacja_demo', points: 10, active: true },
  { key: 'opieka_nad_klientem', points: 10, active: true },
  { key: 'przetargi', points: 10, active: true },
  { key: 'rozproszona_struktura', points: 5, active: true },
  { key: 'siec_partnerow', points: 5, active: true },
  { key: 'ecommerce_b2b', points: 5, active: true },
];

function isPristineOldDefault(rows) {
  if (rows.length !== OLD_DEFAULT_SIGNALS.length) return false;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return OLD_DEFAULT_SIGNALS.every((def) => {
    const row = byKey.get(def.key);
    return row && row.active === def.active && Number(row.points) === def.points;
  });
}

const GOLD_SLUG = 'crmtree-gold';
const GOLD_DEACTIVATE_KEYS = ['rozproszona_struktura', 'ecommerce_b2b'];

async function migrateTenant(tenant) {
  const { rows: liveSignals } = await db.query(
    `SELECT id, key, points, active FROM tenant_icp_signals WHERE tenant_id = $1`,
    [tenant.id],
  );

  if (liveSignals.length === 0) {
    return { tenant: tenant.name, action: 'skip_fallback', detail: 'brak wierszy — czysty fallback do nowego DEFAULT_SIGNALS' };
  }

  if (tenant.slug === GOLD_SLUG) {
    for (const key of GOLD_DEACTIVATE_KEYS) {
      const row = liveSignals.find((r) => r.key === key);
      if (row && row.active) {
        await svc.setSignalActive(tenant.id, row.id, false);
      }
    }
    return { tenant: tenant.name, action: 'migrated_gold' };
  }

  if (isPristineOldDefault(liveSignals)) {
    const byKey = new Map(liveSignals.map((r) => [r.key, r]));
    for (const def of svc.DEFAULT_SIGNALS) {
      const row = byKey.get(def.key);
      if (row) {
        if (row.active !== def.active || Number(row.points) !== def.points) {
          await svc.updateSignal(tenant.id, row.id, { points: def.points, active: def.active });
        }
      } else {
        await svc.addSignal(tenant.id, {
          key: def.key, label: def.label, aiDefinition: def.ai_definition,
          points: def.points, tier: def.tier, active: def.active,
        });
      }
    }
    return { tenant: tenant.name, action: 'migrated_pristine' };
  }

  const activeSum = liveSignals.filter((r) => r.active).reduce((sum, r) => sum + Number(r.points), 0);
  return {
    tenant: tenant.name,
    action: 'needs_manual_review',
    detail: `${liveSignals.length} sygnałów, suma aktywnych ${activeSum} — config nie jest ani pristine-default ani Gold, nie ruszam automatycznie`,
  };
}

async function main() {
  const { rows: tenants } = await db.query(
    `SELECT id, name, slug FROM tenants WHERE deleted_at IS NULL ORDER BY name`,
  );

  const results = [];
  for (const tenant of tenants) {
    try {
      results.push(await migrateTenant(tenant));
    } catch (err) {
      results.push({ tenant: tenant.name, action: 'error', detail: err.message });
    }
  }

  console.log('\n=== Migracja ICP signals: suma=70 -> suma=100 ===\n');
  for (const r of results) {
    console.log(`- ${r.tenant}: ${r.action}${r.detail ? ' (' + r.detail + ')' : ''}`);
  }

  console.log('\n=== Weryfikacja koncowa (kazdy tenant, PUBLISHED config) ===\n');
  let allOk = true;
  for (const tenant of tenants) {
    const published = await svc.getPublishedConfig(tenant.id);
    const validity = enrichSvc.evaluateIcpConfigValidity(published);
    const status = validity.isValid ? 'OK' : 'INVALID';
    if (!validity.isValid) allOk = false;
    console.log(`- ${tenant.name}: PUBLISHED maxScore=${published.maxScore} isDefault=${published.isDefault} -> ${status}`);
  }

  console.log(
    allOk
      ? '\nWszyscy tenanci maja wazna (100/100) PUBLISHED konfiguracje.'
      : '\nUWAGA: czesc tenantow NIE ma wazniej PUBLISHED konfiguracji -- sprawdz liste wyzej przed deployem.',
  );

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
