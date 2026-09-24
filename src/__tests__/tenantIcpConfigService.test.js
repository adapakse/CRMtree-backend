'use strict';

// tenantIcpConfigService — LIVE (roboczy stan admina, może być CHWILOWO
// invalid) vs PUBLISHED (ostatnia poprawna, opublikowana wersja — jedyna
// używana przez enrichment). Testuje: fallback do DEFAULT_SIGNALS, CRUD
// sygnałów, auto-publikację TYLKO dla poprawnego configu (signals_sum ==
// ICP_REQUIRED_SIGNALS_MAX_SCORE), config_revision jako niezależny licznik
// optimistic-concurrency dla edycji roboczej, soft/hard delete wg historii
// publikacji, seedDefaultConfigForTenant. NIE testuje promptu/AI — to
// prospectEnrichmentService.js.
//
// Multi-tenant: wszystko pod jednym dedykowanym test tenantem, tabele ICP
// czyszczone w afterEach (nie tenant sam), żeby każdy test liczył od zera.

const db = require('../config/database');
const svc = require('../services/tenantIcpConfigService');
const { ICP_REQUIRED_SIGNALS_MAX_SCORE } = require('../services/prospectEnrichmentService');

const SLUG = 'zz-icp-config-test';

let tenantId;

async function cleanupIcpTables() {
  await db.query(`DELETE FROM tenant_icp_config_versions WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_configs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_icp_signals WHERE tenant_id = $1`, [tenantId]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active)
     VALUES ('ICP Config Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await cleanupIcpTables();
});

afterEach(async () => {
  await cleanupIcpTables();
});

afterAll(async () => {
  await cleanupIcpTables();
  await db.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);
});

describe('getActiveConfig / getPublishedConfig — fallback do DEFAULT_SIGNALS', () => {
  test('tenant bez własnych wierszy: LIVE i PUBLISHED oba fallbackują do DEFAULT_SIGNALS (9 sygnałów, maxScore=100)', async () => {
    const live = await svc.getActiveConfig(tenantId);
    const published = await svc.getPublishedConfig(tenantId);

    expect(live.isDefault).toBe(true);
    expect(published.isDefault).toBe(true);
    expect(live.signals).toHaveLength(9);
    expect(published.signals).toHaveLength(9);
    expect(live.maxScore).toBe(100);
    expect(published.maxScore).toBe(100);
    expect(live.configRevision).toBe(0);
    expect(published.currentVersionId).toBeNull();
    expect(published.currentVersionNumber).toBeNull();
  });

  test('DEFAULT_SIGNALS ma stabilne key 1:1 z dzisiejszym ICP_SIGNALS[].id', () => {
    const keys = svc.DEFAULT_SIGNALS.map((s) => s.key).sort();
    expect(keys).toEqual([
      'cykliczna_obsluga_klienta_odnowienia', 'dzial_handlowy', 'ecommerce_b2b', 'konsultacja_demo',
      'opieka_nad_klientem', 'przetargi', 'rozproszona_struktura', 'siec_partnerow', 'zlozony_proces_sprzedazy',
    ].sort());
  });
});

describe('LIVE vs PUBLISHED — auto-publikacja TYLKO dla poprawnego configu', () => {
  test('przejście 100 → 105 → 100: current_version_id publikuje się tylko przy poprawnej sumie', async () => {
    const add1 = await svc.addSignal(tenantId, {
      label: 'Jedyny sygnał', aiDefinition: 'x', points: ICP_REQUIRED_SIGNALS_MAX_SCORE,
    });
    expect(add1.published).toBe(true);
    expect(add1.version.version).toBe(1);
    expect(add1.version.max_score).toBe(100);
    expect(add1.configRevision).toBe(1);

    let published = await svc.getPublishedConfig(tenantId);
    expect(published.currentVersionNumber).toBe(1);
    expect(published.maxScore).toBe(100);

    // 100 → 105: LIVE się zmienia, PUBLISHED (i current_version_id) zostają przy wersji 1.
    const bump = await svc.updateSignal(tenantId, add1.signal.id, { points: 105 });
    expect(bump.published).toBe(false);
    expect(bump.version).toBeNull();
    expect(bump.configRevision).toBe(2); // rośnie MIMO braku publikacji

    const liveInvalid = await svc.getActiveConfig(tenantId);
    expect(liveInvalid.maxScore).toBe(105);
    expect(liveInvalid.currentVersionId).not.toBeNull(); // wciąż wskazuje na wersję 1

    published = await svc.getPublishedConfig(tenantId);
    expect(published.currentVersionNumber).toBe(1); // bez zmian mimo invalid LIVE
    expect(published.maxScore).toBe(100);
    expect(published.activeSignals[0].points).toBe(100); // stary, poprawny snapshot — NIE 105

    // 105 → 100: dopiero teraz publikuje się nowa wersja.
    const fix = await svc.updateSignal(tenantId, add1.signal.id, { points: 100 });
    expect(fix.published).toBe(true);
    expect(fix.version.version).toBe(2);
    expect(fix.configRevision).toBe(3);

    published = await svc.getPublishedConfig(tenantId);
    expect(published.currentVersionNumber).toBe(2);
    expect(published.maxScore).toBe(100);
  });

  test('config_revision rośnie przy KAŻDEJ mutacji LIVE, niezależnie od tego czy publikuje', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 10 }); // invalid
    expect(a.published).toBe(false);
    expect(a.configRevision).toBe(1);

    const b = await svc.setSignalActive(tenantId, a.signal.id, false); // dalej invalid (0 != 100), inny typ mutacji
    expect(b.published).toBe(false);
    expect(b.configRevision).toBe(2);

    await svc.setSignalActive(tenantId, a.signal.id, true);
    const c = await svc.updateSignal(tenantId, a.signal.id, { points: ICP_REQUIRED_SIGNALS_MAX_SCORE });
    expect(c.published).toBe(true);
    expect(c.configRevision).toBe(4);
  });

  test('publikacja zamraża do snapshotu AKTUALNY app_settings.prospect_lead_min_score tego tenanta', async () => {
    // qualification_threshold nie jest już edytowalny przez ten serwis (patrz
    // opis w getTenantQualificationThreshold) — jedyne źródło to app_settings,
    // ustawiane tu bezpośrednio, tak jak robi to prawdziwa strona Ustawień.
    await db.query(
      `INSERT INTO app_settings (tenant_id, key, value, value_type, label, category)
       VALUES ($1, 'prospect_lead_min_score', '80', 'number', 'test', 'crm')
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = '80'`,
      [tenantId],
    );

    const result = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: ICP_REQUIRED_SIGNALS_MAX_SCORE });
    expect(result.published).toBe(true);
    expect(result.version.qualification_threshold).toBe(80);

    const live = await svc.getActiveConfig(tenantId);
    expect(live.qualificationThreshold).toBe(80);

    await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'prospect_lead_min_score'`, [tenantId]);
  });
});

describe('enrichment w stanie invalid — getPublishedConfig() nadal zwraca starą, poprawną konfigurację', () => {
  test('nie rzuca, nie zwraca invalid stanu, mimo że LIVE jest akurat zepsuty', async () => {
    const add1 = await svc.addSignal(tenantId, {
      label: 'Sygnał bazowy', aiDefinition: 'x', points: ICP_REQUIRED_SIGNALS_MAX_SCORE,
    });
    expect(add1.published).toBe(true);

    await svc.addSignal(tenantId, { label: 'Nowy, psujący sumę', aiDefinition: 'y', points: 5 }); // 105/100, invalid

    const live = await svc.getActiveConfig(tenantId);
    expect(live.maxScore).toBe(105);

    const published = await svc.getPublishedConfig(tenantId); // to dokładnie czyta enrichOne()
    expect(published.maxScore).toBe(100);
    expect(published.activeSignals).toHaveLength(1);
    expect(published.activeSignals[0].label).toBe('Sygnał bazowy');
  });
});

describe('materializacja DEFAULT_SIGNALS przy pierwszej mutacji fallbackowego tenanta', () => {
  test('updateSignal na placeholder-id z DEFAULT_SIGNALS materializuje 9 defaultów i edytuje właściwy', async () => {
    const before = await svc.getActiveConfig(tenantId);
    expect(before.isDefault).toBe(true);
    const dzialHandlowyPlaceholder = svc.DEFAULT_SIGNALS.find((s) => s.key === 'dzial_handlowy');

    const result = await svc.updateSignal(tenantId, dzialHandlowyPlaceholder.id, { points: 20 });
    expect(result.signal.key).toBe('dzial_handlowy');
    expect(result.signal.points).toBe(20);
    expect(result.signal.id).not.toBe(dzialHandlowyPlaceholder.id); // realne id, nie placeholder

    const after = await svc.getActiveConfig(tenantId);
    expect(after.isDefault).toBe(false);
    expect(after.signals).toHaveLength(9); // pozostałych 8 defaultów NIE zniknęło
    const edited = after.signals.find((s) => s.key === 'dzial_handlowy');
    expect(edited.points).toBe(20);
    const untouched = after.signals.find((s) => s.key === 'zlozony_proces_sprzedazy');
    expect(untouched.points).toBe(25); // reszta materializowana bez zmian
  });

  test('deleteSignal na placeholder-id materializuje i poprawnie usuwa (hard delete — materializacja sama w sobie NIE publikuje, ta konkretna mutacja jeszcze nic nie zdążyła opublikować)', async () => {
    const siecPartnerowPlaceholder = svc.DEFAULT_SIGNALS.find((s) => s.key === 'siec_partnerow');
    const result = await svc.deleteSignal(tenantId, siecPartnerowPlaceholder.id);
    expect(result.softDeleted).toBe(false);
    expect(result.published).toBe(false); // 6 pozostałych aktywnych sygnałów sumuje się do 95, nie 100

    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.isDefault).toBe(false); // 8 realnych wierszy, nie fallback
    expect(cfg.signals).toHaveLength(8); // siec_partnerow usunięty całkowicie, nie tylko wyłączony
    expect(cfg.maxScore).toBe(95);
  });
});

describe('addSignal', () => {
  test('dodaje sygnał, generuje key ze slugified label; publikuje tylko jeśli suma jest poprawna', async () => {
    const result = await svc.addSignal(tenantId, {
      label: 'Testowy sygnał ICP', aiDefinition: 'Definicja testowa dla AI.', points: 20,
    });
    expect(result.signal.key).toBe('testowy_sygnal_icp');
    expect(result.signal.points).toBe(20);
    expect(result.signal.active).toBe(true);
    expect(result.published).toBe(false);
    expect(result.configRevision).toBe(1);

    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.isDefault).toBe(false);
    expect(cfg.signals).toHaveLength(1);
  });

  test('kolizja slugów dostaje deduplikowany key (_1, _2, ...)', async () => {
    const a = await svc.addSignal(tenantId, { label: 'Sygnał X', aiDefinition: 'a', points: 5 });
    const b = await svc.addSignal(tenantId, { label: 'Sygnał X', aiDefinition: 'b', points: 5 });
    expect(a.signal.key).toBe('sygnal_x');
    expect(b.signal.key).toBe('sygnal_x_1');
  });

  test('odrzuca points ujemne', async () => {
    await expect(
      svc.addSignal(tenantId, { label: 'Zły sygnał', aiDefinition: 'x', points: -5 }),
    ).rejects.toThrow(/points/);
  });

  test('requiresAnyOf wskazujące na nieistniejący id jest odrzucane', async () => {
    await expect(
      svc.addSignal(tenantId, {
        label: 'Zależny sygnał', aiDefinition: 'x', points: 5,
        requiresAnyOf: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).rejects.toThrow(/requires_any_of/);
  });
});

describe('updateSignal', () => {
  test('zmienia label/points, key zostaje bez zmian', async () => {
    const created = await svc.addSignal(tenantId, { label: 'Stara nazwa', aiDefinition: 'x', points: 10 });
    const updated = await svc.updateSignal(tenantId, created.signal.id, { label: 'Nowa nazwa', points: 25 });

    expect(updated.signal.key).toBe(created.signal.key);
    expect(updated.signal.label).toBe('Nowa nazwa');
    expect(updated.signal.points).toBe(25);
    expect(updated.configRevision).toBe(2);
  });

  test('odrzuca próbę edycji key', async () => {
    const created = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 5 });
    await expect(
      svc.updateSignal(tenantId, created.signal.id, { key: 'cos_innego' }),
    ).rejects.toThrow(/key jest niezmienny/);
  });

  test('nieistniejący sygnał rzuca błąd', async () => {
    await expect(
      svc.updateSignal(tenantId, '00000000-0000-0000-0000-000000000000', { points: 1 }),
    ).rejects.toThrow(/nie istnieje/);
  });
});

describe('setSignalActive / maxScore (LIVE)', () => {
  test('dezaktywacja sygnału zmniejsza maxScore w LIVE', async () => {
    const created = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 30 });
    let cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.maxScore).toBe(30);

    await svc.setSignalActive(tenantId, created.signal.id, false);
    cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.maxScore).toBe(0);
    expect(cfg.activeSignals).toHaveLength(0);
    expect(cfg.signals).toHaveLength(1); // sygnał zostaje w liście, tylko active=false
  });
});

describe('reorderSignals', () => {
  test('zmienia sort_order zgodnie z podaną kolejnością', async () => {
    const s1 = await svc.addSignal(tenantId, { label: 'Pierwszy', aiDefinition: 'x', points: 1 });
    const s2 = await svc.addSignal(tenantId, { label: 'Drugi', aiDefinition: 'x', points: 1 });

    await svc.reorderSignals(tenantId, [s2.signal.id, s1.signal.id]);

    const cfg = await svc.getActiveConfig(tenantId);
    const bySortOrder = [...cfg.signals].sort((a, b) => a.sort_order - b.sort_order);
    expect(bySortOrder.map((s) => s.id)).toEqual([s2.signal.id, s1.signal.id]);
  });

  test('niekompletna lista (brakujący id) jest odrzucana', async () => {
    const s1 = await svc.addSignal(tenantId, { label: 'Pierwszy', aiDefinition: 'x', points: 1 });
    await svc.addSignal(tenantId, { label: 'Drugi', aiDefinition: 'x', points: 1 });

    await expect(svc.reorderSignals(tenantId, [s1.signal.id])).rejects.toThrow(/dokładnie wszystkie/);
  });
});

describe('deleteSignal — soft delete dla opublikowanej historii, hard delete dla nigdy nieopublikowanego', () => {
  test('sygnał NIGDY nieopublikowany: hard delete, wiersz znika', async () => {
    const created = await svc.addSignal(tenantId, { label: 'Nigdy opublikowany', aiDefinition: 'x', points: 5 });
    expect(created.published).toBe(false);

    const result = await svc.deleteSignal(tenantId, created.signal.id);
    expect(result.softDeleted).toBe(false);

    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.signals.find((s) => s.id === created.signal.id)).toBeUndefined();
  });

  test('sygnał, który BYŁ w opublikowanym snapshocie: soft delete (active=false), wiersz zostaje', async () => {
    const created = await svc.addSignal(tenantId, {
      label: 'Bazowy', aiDefinition: 'x', points: ICP_REQUIRED_SIGNALS_MAX_SCORE,
    });
    expect(created.published).toBe(true); // ma historię publikacji

    const result = await svc.deleteSignal(tenantId, created.signal.id);
    expect(result.softDeleted).toBe(true);

    const cfg = await svc.getActiveConfig(tenantId);
    const stillThere = cfg.signals.find((s) => s.id === created.signal.id);
    expect(stillThere).toBeDefined();
    expect(stillThere.active).toBe(false);

    // Historyczny snapshot (v1) nadal pokazuje go jako pełnoprawny wpis —
    // soft delete nie rusza już opublikowanej historii.
    const published = await svc.getConfigVersionById(tenantId, created.version.id);
    expect(published.snapshot[0].active).toBe(true);
  });

  test('usuwa sygnał (hard) i czyści referencje requires_any_of u innych', async () => {
    const base = await svc.addSignal(tenantId, { label: 'Bazowy2', aiDefinition: 'x', points: 10 });
    const dependent = await svc.addSignal(tenantId, {
      label: 'Zależny', aiDefinition: 'x', points: 5, requiresAnyOf: [base.signal.id],
    });
    expect(base.published).toBe(false);
    expect(dependent.published).toBe(false);

    await svc.deleteSignal(tenantId, base.signal.id);

    const cfg = await svc.getActiveConfig(tenantId);
    const refreshedDependent = cfg.signals.find((s) => s.id === dependent.signal.id);
    expect(refreshedDependent.requires_any_of).toBeNull();
  });

  test('nieistniejący sygnał rzuca błąd', async () => {
    await expect(
      svc.deleteSignal(tenantId, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/nie istnieje/);
  });
});

describe('getTenantQualificationThreshold — jedyne źródło to app_settings.prospect_lead_min_score', () => {
  afterEach(async () => {
    await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'prospect_lead_min_score'`, [tenantId]);
  });

  test('brak wiersza w app_settings → fallback 45 (ten sam default co getMinScore() w crm-prospects-dashboard.js)', async () => {
    expect(await svc.getTenantQualificationThreshold(tenantId)).toBe(45);
    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.qualificationThreshold).toBe(45);
  });

  test('czyta live wartość z app_settings, bez pośrednika w tenant_icp_configs', async () => {
    await db.query(
      `INSERT INTO app_settings (tenant_id, key, value, value_type, label, category)
       VALUES ($1, 'prospect_lead_min_score', '65', 'number', 'test', 'crm')`,
      [tenantId],
    );
    expect(await svc.getTenantQualificationThreshold(tenantId)).toBe(65);
    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.qualificationThreshold).toBe(65);
  });

  test('serwis nie eksportuje żadnego settera — próg edytuje się wyłącznie przez app_settings (Ustawienia aplikacji)', () => {
    expect(svc.setQualificationThreshold).toBeUndefined();
  });
});

describe('optimistic concurrency (expected_revision, niezależny od opublikowanej wersji)', () => {
  test('mutacja z poprawnym expected_revision przechodzi', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 5 });
    expect(a.configRevision).toBe(1);

    await expect(
      svc.setSignalActive(tenantId, a.signal.id, false, { expectedRevision: 1 }),
    ).resolves.toBeDefined();
  });

  test('mutacja ze złym expected_revision rzuca ConfigRevisionConflictError', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 5 }); // revision 1

    await expect(
      svc.setSignalActive(tenantId, a.signal.id, false, { expectedRevision: 99 }),
    ).rejects.toBeInstanceOf(svc.ConfigRevisionConflictError);
  });

  test('409 działa również gdy LIVE jest akurat invalid — config_revision nie zależy od publikacji', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 10 }); // invalid, revision 1
    expect(a.published).toBe(false);
    await svc.updateSignal(tenantId, a.signal.id, { points: 20 }); // "ktoś inny" edytuje, revision 2, dalej invalid

    await expect(
      svc.updateSignal(tenantId, a.signal.id, { points: 100 }, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(svc.ConfigRevisionConflictError);
  });

  test('brak expected_revision pomija sprawdzenie (backward-compatible wywołanie)', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 5 });
    await expect(svc.setSignalActive(tenantId, a.signal.id, false)).resolves.toBeDefined();
  });
});

describe('wersjonowanie — snapshot i traceability (tylko dla poprawnych/opublikowanych stanów)', () => {
  test('każda PUBLIKACJA tworzy nową wersję; current_version_id zawsze wskazuje najnowszą poprawną', async () => {
    const a = await svc.addSignal(tenantId, { label: 'A', aiDefinition: 'x', points: 70 });
    expect(a.published).toBe(false); // 70/100

    const b = await svc.addSignal(tenantId, { label: 'B', aiDefinition: 'x', points: 30 });
    expect(b.published).toBe(true); // 100/100
    expect(b.version.version).toBe(1);

    // Przenieś 10 pkt z A do B — suma zostaje 100, ale przejściowo (po pierwszym
    // z dwóch kroków) jest invalid, dopiero drugi krok znów publikuje.
    const moveA = await svc.updateSignal(tenantId, a.signal.id, { points: 60 });
    expect(moveA.published).toBe(false); // 60+30=90

    const moveB = await svc.updateSignal(tenantId, b.signal.id, { points: 40 });
    expect(moveB.published).toBe(true); // 60+40=100
    expect(moveB.version.version).toBe(2);

    const cfg = await svc.getActiveConfig(tenantId);
    expect(cfg.currentVersionId).toBe(moveB.version.id);
  });

  test('stara opublikowana wersja pozostaje czytelna po kolejnej zmianie punktów (wyjaśnialność starego enrichmentu)', async () => {
    const a = await svc.addSignal(tenantId, { label: 'Sieć partnerów', aiDefinition: 'x', points: 70 });
    const b = await svc.addSignal(tenantId, { label: 'Reszta', aiDefinition: 'y', points: 30 });
    expect(b.published).toBe(true);
    const v1 = b.version;

    // Symulacja: prospekt oceniony pod v1 zapisałby v1.id jako icp_config_version_id.
    await svc.updateSignal(tenantId, a.signal.id, { points: 80 }); // 110/100, invalid
    const fix = await svc.updateSignal(tenantId, b.signal.id, { points: 20 }); // 100/100
    expect(fix.published).toBe(true);
    const v2 = fix.version;

    const explainOldProspect = await svc.getConfigVersionById(tenantId, v1.id);
    const explainNewState = await svc.getConfigVersionById(tenantId, v2.id);
    expect(explainOldProspect.snapshot.find((s) => s.label === 'Sieć partnerów').points).toBe(70);
    expect(explainNewState.snapshot.find((s) => s.label === 'Sieć partnerów').points).toBe(80);

    const published = await svc.getPublishedConfig(tenantId);
    expect(published.activeSignals.find((s) => s.label === 'Sieć partnerów').points).toBe(80);
  });

  test('snapshot zawiera komplet pól wymaganych do wyjaśnienia enrichmentu', async () => {
    const result = await svc.addSignal(tenantId, {
      label: 'Pełny sygnał', aiDefinition: 'Definicja dla AI', points: ICP_REQUIRED_SIGNALS_MAX_SCORE, tier: 'wysoka',
    });
    expect(result.published).toBe(true);
    expect(result.version.snapshot).toHaveLength(1);

    const entry = result.version.snapshot[0];
    expect(entry).toMatchObject({
      id: result.signal.id,
      key: result.signal.key,
      label: 'Pełny sygnał',
      ai_definition: 'Definicja dla AI',
      points: 100,
      tier: 'wysoka',
      active: true,
    });
    expect(result.version.qualification_threshold).toBe(45);
    expect(result.version.max_score).toBe(100);
  });
});

describe('seedDefaultConfigForTenant — nowy tenant dostaje LIVE + PUBLISHED config, nie tylko fallback', () => {
  const SOURCE_SLUG = 'zz-icp-config-test-source';
  const TARGET_SLUG = 'zz-icp-config-test-target';
  let sourceTenantId;
  let targetTenantId;

  async function cleanupExtraTenant(slug) {
    const { rows: [t] } = await db.query(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
    if (!t) return null;
    await db.query(`DELETE FROM tenant_icp_config_versions WHERE tenant_id = $1`, [t.id]);
    await db.query(`DELETE FROM tenant_icp_configs WHERE tenant_id = $1`, [t.id]);
    await db.query(`DELETE FROM tenant_icp_signals WHERE tenant_id = $1`, [t.id]);
    return t.id;
  }

  afterEach(async () => {
    await cleanupExtraTenant(SOURCE_SLUG);
    await cleanupExtraTenant(TARGET_SLUG);
    await db.query(`DELETE FROM tenants WHERE slug = ANY($1)`, [[SOURCE_SLUG, TARGET_SLUG]]);
  });

  test('bez sourceTenantId (gold nie istnieje jeszcze): seeduje 9 sygnałów 1:1 z DEFAULT_SIGNALS, publikuje wersję 1 (100/100, schemat Gold)', async () => {
    const { rows: [t] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Seed Target (fallback)', $1, TRUE) RETURNING id`,
      [TARGET_SLUG],
    );
    targetTenantId = t.id;

    const result = await db.transaction((client) => svc.seedDefaultConfigForTenant(client, targetTenantId));
    expect(result.signalsSeeded).toBe(9);
    expect(result.published).toBe(true);
    expect(result.version.version).toBe(1);

    const live = await svc.getActiveConfig(targetTenantId);
    expect(live.isDefault).toBe(false); // ma teraz WŁASNE wiersze, nie fallback
    expect(live.signals).toHaveLength(9);
    expect(live.qualificationThreshold).toBe(45);
    expect(live.maxScore).toBe(100);
    expect(live.currentVersionId).toBe(result.version.id);

    const published = await svc.getPublishedConfig(targetTenantId);
    expect(published.currentVersionNumber).toBe(1);
    expect(published.maxScore).toBe(100);

    const ecommerce = live.signals.find((s) => s.key === 'ecommerce_b2b');
    const dzialHandlowy = live.signals.find((s) => s.key === 'dzial_handlowy');
    const opiekaNadKlientem = live.signals.find((s) => s.key === 'opieka_nad_klientem');
    expect(ecommerce.requires_any_of.sort()).toEqual([dzialHandlowy.id, opiekaNadKlientem.id].sort());
  });

  test('z sourceTenantId: kopiuje PUBLISHED (nie LIVE) config źródła, z poprawnie przetłumaczonym requires_any_of', async () => {
    const { rows: [source] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Seed Source', $1, TRUE) RETURNING id`,
      [SOURCE_SLUG],
    );
    sourceTenantId = source.id;
    const { rows: [target] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Seed Target (copy)', $1, TRUE) RETURNING id`,
      [TARGET_SLUG],
    );
    targetTenantId = target.id;

    const base = await svc.addSignal(sourceTenantId, { label: 'Własna flota', aiDefinition: 'x', points: 70 });
    const dep = await svc.addSignal(sourceTenantId, {
      label: 'Sprzedaż eksportowa', aiDefinition: 'y', points: 30, requiresAnyOf: [base.signal.id],
    });
    expect(dep.published).toBe(true); // 70+30=100 — źródło MA opublikowaną wersję

    const result = await db.transaction((client) =>
      svc.seedDefaultConfigForTenant(client, targetTenantId, { sourceTenantId }),
    );
    expect(result.signalsSeeded).toBe(2);
    expect(result.published).toBe(true);

    const live = await svc.getActiveConfig(targetTenantId);
    expect(live.signals).toHaveLength(2);
    expect(live.maxScore).toBe(100);

    const wlasnaFlota = live.signals.find((s) => s.key === 'wlasna_flota');
    const eksport = live.signals.find((s) => s.key === 'sprzedaz_eksportowa');
    expect(wlasnaFlota).toBeDefined();
    expect(eksport).toBeDefined();
    expect(wlasnaFlota.id).not.toBe(base.signal.id); // NOWE id, nie skopiowane ze źródła
    expect(eksport.requires_any_of).toEqual([wlasnaFlota.id]); // przetłumaczone na NOWE id (po key)
  });

  test('z sourceTenantId, którego LIVE jest akurat invalid (mid-edit): kopiuje mimo to PUBLISHED, nie zepsuty LIVE', async () => {
    const { rows: [source] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Seed Source Midedit', $1, TRUE) RETURNING id`,
      [SOURCE_SLUG],
    );
    sourceTenantId = source.id;
    const { rows: [target] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Seed Target Midedit', $1, TRUE) RETURNING id`,
      [TARGET_SLUG],
    );
    targetTenantId = target.id;

    const only = await svc.addSignal(sourceTenantId, { label: 'Jedyny', aiDefinition: 'x', points: ICP_REQUIRED_SIGNALS_MAX_SCORE });
    expect(only.published).toBe(true); // źródło ma opublikowaną wersję 1 (100/100)

    // Ktoś w międzyczasie zaczął edytować źródło i zepsuł LIVE (nie opublikowane).
    await svc.updateSignal(sourceTenantId, only.signal.id, { points: 999 });
    const sourceLive = await svc.getActiveConfig(sourceTenantId);
    expect(sourceLive.maxScore).toBe(999); // LIVE jest invalid w momencie seedowania

    const result = await db.transaction((client) =>
      svc.seedDefaultConfigForTenant(client, targetTenantId, { sourceTenantId }),
    );

    const live = await svc.getActiveConfig(targetTenantId);
    expect(live.maxScore).toBe(100); // skopiowane z PUBLISHED źródła, NIE ze zepsutego LIVE (999)
    expect(result.published).toBe(true);
  });
});
