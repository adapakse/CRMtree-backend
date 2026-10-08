'use strict';

// leadStageService — konfigurowalne etapy leada per tenant (migracja 0326).
// Testuje to, co nowe w tym mechanizmie i co łatwo zepsuć:
//   - rozdzielenie key/label: zmiana nazwy NIE zmienia kodu etapu, a pusty label
//     wraca do wbudowanego tłumaczenia,
//   - sekwencja przejść wynika z kolejności etapów, nie ze stałej w kodzie,
//   - NIE MA etapów „systemowych": Wygraną i Przegraną też da się usunąć, a wtedy
//     wonKey/lostKey są NULL i przejścia muszą to znieść,
//   - etap z leadami usuwa się ze wskazaniem etapu docelowego (leady przechodzą),
//   - jedyne granice to: ostatni etap lejka oraz stany zapisywane przez kod
//     (converted/archived),
//   - limit MAX_OPEN_STAGES liczy TYLKO etapy lejka,
//   - fallback dla tenanta bez wierszy i seed nowego tenanta.
//
// Multi-tenant: wszystko pod dedykowanym test tenantem, tabela czyszczona
// w afterEach, żeby każdy test liczył od zera.

const db = require('../config/database');
const svc = require('../services/leadStageService');

const SLUG = 'zz-lead-stage-test';

let tenantId;

async function cleanup() {
  await db.query('DELETE FROM crm_leads WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenant_lead_stages WHERE tenant_id = $1', [tenantId]);
}

async function seedDefaults() {
  await svc.materializeDefaults(tenantId);
}

async function stageByKey(key) {
  const { rows } = await db.query(
    'SELECT * FROM tenant_lead_stages WHERE tenant_id = $1 AND key = $2', [tenantId, key],
  );
  return rows[0];
}

async function insertLead(stage) {
  const { rows } = await db.query(
    `INSERT INTO crm_leads (company, stage, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    ['Stage Test Co', stage, tenantId],
  );
  return rows[0].id;
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active)
     VALUES ('Lead Stage Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

describe('fallback i seed', () => {
  test('tenant bez wierszy dostaje wbudowany lejek, a nie pustą listę', async () => {
    const stages = await svc.listStages(tenantId);
    expect(stages.map(s => s.key)).toEqual(svc.DEFAULT_STAGES.map(s => s.key));
    // Tryb fallback nie ma id — nie da się go edytować, dopiero materializacja.
    expect(stages.every(s => s.id === null)).toBe(true);
  });

  test('seedStagesForTenant kopiuje etapy tenanta wzorcowego RAZEM z nazwami', async () => {
    await seedDefaults();
    const won = await stageByKey('closed_won');
    await svc.updateStage(tenantId, won.id, { label: 'Zamknięte sukcesem' });

    const { rows: [target] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active) VALUES ('Stage Seed Target', $1, TRUE)
       ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
      ['zz-lead-stage-seed-target'],
    );
    try {
      await db.transaction(client =>
        svc.seedStagesForTenant(client, target.id, { sourceTenantId: tenantId }));

      const { rows } = await db.query(
        `SELECT key, label FROM tenant_lead_stages WHERE tenant_id = $1 AND key = 'closed_won'`,
        [target.id],
      );
      expect(rows[0].label).toBe('Zamknięte sukcesem');
    } finally {
      await db.query('DELETE FROM tenant_lead_stages WHERE tenant_id = $1', [target.id]);
      await db.query('DELETE FROM tenants WHERE id = $1', [target.id]);
    }
  });
});

describe('zmiana nazwy etapu', () => {
  beforeEach(seedDefaults);

  test('nowa nazwa NIE zmienia kodu etapu — dane leadów zostają nietknięte', async () => {
    const won = await stageByKey('closed_won');
    const leadId = await insertLead('closed_won');

    const updated = await svc.updateStage(tenantId, won.id, { label: 'Deal zamknięty' });

    expect(updated.key).toBe('closed_won');
    expect(updated.label).toBe('Deal zamknięty');
    const { rows } = await db.query('SELECT stage FROM crm_leads WHERE id = $1', [leadId]);
    expect(rows[0].stage).toBe('closed_won');
  });

  test('nie ma już pojęcia etapu systemowego — Wygraną można i przemianować, i usunąć', async () => {
    const won = await stageByKey('closed_won');
    expect(won.is_system).toBeUndefined();

    await expect(svc.updateStage(tenantId, won.id, { label: 'Sukces' }))
      .resolves.toMatchObject({ label: 'Sukces' });
    await expect(svc.deleteStage(tenantId, won.id)).resolves.toMatchObject({ key: 'closed_won' });
  });

  test('pusta nazwa wraca do wbudowanego tłumaczenia (label = NULL)', async () => {
    const won = await stageByKey('closed_won');
    await svc.updateStage(tenantId, won.id, { label: 'Sukces' });

    const cleared = await svc.updateStage(tenantId, won.id, { label: '' });
    expect(cleared.label).toBeNull();
  });
});

describe('sekwencja i dozwolone przejścia', () => {
  beforeEach(seedDefaults);

  test('sekwencja to etapy lejka w kolejności + wygrana na końcu', async () => {
    const config = await svc.getStageConfig(tenantId);
    expect(config.sequence).toEqual([
      'new', 'qualification', 'presentation', 'offer', 'negotiation', 'closed_won',
    ]);
    expect(config.entryKey).toBe('new');
    expect(config.holdKeys).toEqual(['qualification', 'presentation', 'offer', 'negotiation']);
  });

  test('krok w przód, krok w tył i awaryjne wyjście w przegraną', async () => {
    const config = await svc.getStageConfig(tenantId);
    expect(svc.allowedNextStages(config, 'offer').sort())
      .toEqual(['closed_lost', 'negotiation', 'presentation']);
    expect(svc.allowedNextStages(config, 'new').sort())
      .toEqual(['closed_lost', 'qualification']);
  });

  test('z przegranej i z archiwum jedyne wyjście to etap wejściowy', async () => {
    const config = await svc.getStageConfig(tenantId);
    expect(svc.allowedNextStages(config, 'closed_lost')).toEqual(['new']);
    expect(svc.allowedNextStages(config, 'archived')).toEqual(['new']);
  });

  test('cofnięcie wygranej wraca na ostatni etap lejka, nie na sztywne "negotiation"', async () => {
    const added = await svc.addStage(tenantId, { label: 'Podpis umowy' });
    const config = await svc.getStageConfig(tenantId);

    expect(config.sequence[config.sequence.length - 2]).toBe(added.key);
    expect(svc.allowedNextStages(config, 'closed_won')).toEqual([added.key]);
  });

  test('nowy etap wchodzi do sekwencji przejść i da się go ustawić na leadzie', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });
    const config = await svc.assertStageSelectable(tenantId, added.key);
    expect(config.selectableKeys).toContain(added.key);
  });

  test('nieznany etap jest odrzucany', async () => {
    await expect(svc.assertStageSelectable(tenantId, 'nie_ma_takiego'))
      .rejects.toMatchObject({ status: 400 });
  });

  test('przestawienie kolejności zmienia dozwolone przejścia', async () => {
    const before = await svc.getStageConfig(tenantId);
    const openIds = before.stages.filter(s => s.kind === 'open').map(s => s.id);
    // Zamiana Prezentacji i Oferty miejscami (indeksy 2 i 3).
    [openIds[2], openIds[3]] = [openIds[3], openIds[2]];
    await svc.reorderStages(tenantId, openIds);

    const after = await svc.getStageConfig(tenantId);
    expect(after.sequence).toEqual([
      'new', 'qualification', 'offer', 'presentation', 'negotiation', 'closed_won',
    ]);
    expect(svc.allowedNextStages(after, 'offer').sort())
      .toEqual(['closed_lost', 'presentation', 'qualification']);
  });

  test('reorder musi objąć dokładnie wszystkie etapy lejka', async () => {
    const config = await svc.getStageConfig(tenantId);
    const openIds = config.stages.filter(s => s.kind === 'open').map(s => s.id);
    await expect(svc.reorderStages(tenantId, openIds.slice(1)))
      .rejects.toMatchObject({ status: 422 });
  });
});

describe('dodawanie i usuwanie', () => {
  beforeEach(seedDefaults);

  test('nowy etap dostaje slug z nazwy i ląduje na końcu lejka, przed wygraną', async () => {
    const added = await svc.addStage(tenantId, { label: 'Wycena końcowa' });
    expect(added.key).toBe('wycena_koncowa');
    expect(added.kind).toBe('open');

    const config = await svc.getStageConfig(tenantId);
    expect(config.sequence).toEqual([
      'new', 'qualification', 'presentation', 'offer', 'negotiation', 'wycena_koncowa', 'closed_won',
    ]);
  });

  test('nowy etap dostaje prawdopodobieństwo i kolor z pozycji w lejku, bez pytania admina', async () => {
    // Panel pokazuje tylko numer i nazwę, więc backend musi wyliczyć jedno i drugie.
    // Po Negocjacjach (85) połowa drogi do wygranej (100) to 93.
    const added = await svc.addStage(tenantId, { label: 'Podpis umowy' });
    expect(added.probability).toBe(93);
    expect(added.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  test('dwa etapy o tej samej nazwie dostają różne, unikalne kody', async () => {
    const first  = await svc.addStage(tenantId, { label: 'Pilotaż' });
    const second = await svc.addStage(tenantId, { label: 'Pilotaż' });
    expect(first.key).toBe('pilotaz');
    expect(second.key).toBe('pilotaz_2');
  });

  test('limit liczy TYLKO etapy lejka — zamknięcia i archiwum go nie zajmują', async () => {
    const config = await svc.getStageConfig(tenantId);
    const openCount = config.stages.filter(s => s.kind === 'open').length;
    expect(openCount).toBe(5);

    for (let i = 0; i < svc.MAX_OPEN_STAGES - openCount; i++) {
      await svc.addStage(tenantId, { label: `Etap ${i}` });
    }
    await expect(svc.addStage(tenantId, { label: 'Jeszcze jeden' }))
      .rejects.toMatchObject({ status: 422 });
  });

  test('etap z leadami usuwa się BEZ wskazywania celu — leady same przechodzą na poprzedni krok', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });  // ląduje po Negocjacjach
    const leadId = await insertLead(added.key);

    const result = await svc.deleteStage(tenantId, added.id);
    expect(result).toMatchObject({ movedLeads: 1, movedTo: 'negotiation' });

    const { rows } = await db.query('SELECT stage FROM crm_leads WHERE id = $1', [leadId]);
    expect(rows[0].stage).toBe('negotiation');
  });

  test('resolveDeleteTarget: pierwszy krok lejka oddaje leady następnemu, zamknięcie — ostatniemu', async () => {
    const stages = await svc.listStages(tenantId);
    const byKey = k => stages.find(s => s.key === k);

    expect(svc.resolveDeleteTarget(stages, byKey('new'))).toBe('qualification');
    expect(svc.resolveDeleteTarget(stages, byKey('offer'))).toBe('presentation');
    expect(svc.resolveDeleteTarget(stages, byKey('closed_won'))).toBe('negotiation');
    expect(svc.resolveDeleteTarget(stages, byKey('closed_lost'))).toBe('negotiation');
  });

  test('leady z usuniętej Wygranej wracają na koniec lejka', async () => {
    const won = await stageByKey('closed_won');
    const leadId = await insertLead('closed_won');

    const result = await svc.deleteStage(tenantId, won.id);
    expect(result).toMatchObject({ movedLeads: 1, movedTo: 'negotiation' });

    const { rows } = await db.query('SELECT stage FROM crm_leads WHERE id = $1', [leadId]);
    expect(rows[0].stage).toBe('negotiation');
  });

  test('etap z leadami DA się usunąć ze wskazaniem etapu docelowego — leady przechodzą', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });
    const leadId = await insertLead(added.key);

    const result = await svc.deleteStage(tenantId, added.id, { moveLeadsTo: 'offer' });
    expect(result).toMatchObject({ movedLeads: 1, movedTo: 'offer' });

    const { rows } = await db.query('SELECT stage FROM crm_leads WHERE id = $1', [leadId]);
    expect(rows[0].stage).toBe('offer');
    expect(await stageByKey(added.key)).toBeUndefined();
  });

  test('nie da się przenieść leadów na stan zapisywany przez kod', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });
    await insertLead(added.key);
    await expect(svc.deleteStage(tenantId, added.id, { moveLeadsTo: 'archived' }))
      .rejects.toMatchObject({ status: 422 });
  });

  test('pusty etap da się usunąć, a lejek się domyka', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });
    await svc.deleteStage(tenantId, added.id);

    const config = await svc.getStageConfig(tenantId);
    expect(config.sequence).not.toContain(added.key);
    expect(await stageByKey(added.key)).toBeUndefined();
  });

  test('stanów zapisywanych przez kod (archiwum, konwersja) nie da się usunąć, ale da się przemianować', async () => {
    for (const key of ['archived', 'onboarding']) {
      const target = await stageByKey(key);
      await expect(svc.deleteStage(tenantId, target.id)).rejects.toMatchObject({ status: 422 });
      await expect(svc.updateStage(tenantId, target.id, { label: 'Inna nazwa' }))
        .resolves.toMatchObject({ label: 'Inna nazwa' });
    }
  });

  test('nie da się usunąć ani wyłączyć OSTATNIEGO etapu lejka', async () => {
    const config = await svc.getStageConfig(tenantId);
    const open = config.stages.filter(s => s.kind === 'open');
    for (const s of open.slice(1)) {
      await svc.deleteStage(tenantId, s.id, { moveLeadsTo: open[0].key });
    }
    await expect(svc.deleteStage(tenantId, open[0].id)).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateStage(tenantId, open[0].id, { active: false }))
      .rejects.toMatchObject({ status: 422 });
  });

  test('wyłączony etap wypada z lejka, ale zostaje na liście (lead może na nim siedzieć)', async () => {
    const added = await svc.addStage(tenantId, { label: 'Pilotaż' });
    await insertLead(added.key);
    await svc.updateStage(tenantId, added.id, { active: false });

    const config = await svc.getStageConfig(tenantId);
    expect(config.sequence).not.toContain(added.key);
    expect(config.selectableKeys).not.toContain(added.key);
    // Wiersz zostaje, więc lead nadal ma skąd wziąć nazwę swojego etapu.
    expect(config.stages.map(s => s.key)).toContain(added.key);
  });
});

describe('lejek bez Wygranej i bez Przegranej', () => {
  beforeEach(seedDefaults);

  test('po usunięciu Wygranej wonKey jest NULL, a sekwencja to sam lejek', async () => {
    const won = await stageByKey('closed_won');
    await svc.deleteStage(tenantId, won.id);

    const config = await svc.getStageConfig(tenantId);
    expect(config.wonKey).toBeNull();
    expect(config.sequence).toEqual(['new', 'qualification', 'presentation', 'offer', 'negotiation']);
    expect(config.selectableKeys).not.toContain('closed_won');
  });

  test('bez Przegranej przejścia nie proponują awaryjnego wyjścia', async () => {
    const lost = await stageByKey('closed_lost');
    await svc.deleteStage(tenantId, lost.id);

    const config = await svc.getStageConfig(tenantId);
    expect(config.lostKey).toBeNull();
    expect(svc.allowedNextStages(config, 'offer').sort()).toEqual(['negotiation', 'presentation']);
  });

  test('bez Wygranej ostatni etap lejka nie ma już kroku w przód', async () => {
    const won = await stageByKey('closed_won');
    await svc.deleteStage(tenantId, won.id);

    const config = await svc.getStageConfig(tenantId);
    expect(svc.allowedNextStages(config, 'negotiation').sort()).toEqual(['closed_lost', 'offer']);
  });
});

describe('countLeadsPerStage', () => {
  beforeEach(seedDefaults);

  test('zwraca liczbę leadów per kod etapu', async () => {
    await insertLead('new');
    await insertLead('new');
    await insertLead('offer');

    const counts = await svc.countLeadsPerStage(tenantId);
    expect(counts).toMatchObject({ new: 2, offer: 1 });
  });
});
