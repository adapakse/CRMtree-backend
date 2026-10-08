'use strict';
// ─────────────────────────────────────────────────────────────────
// services/leadStageService.js
//
// Konfigurowalne etapy leada per tenant (migracja 0326). Jedyne źródło prawdy
// o tym, jakie etapy istnieją u danego tenanta, jak się nazywają i jakie
// przejścia między nimi są dozwolone.
//
// ROZDZIELENIE key/label — fundament całego mechanizmu:
//   key   jest niezmienny i to ON leży w crm_leads.stage oraz w SQL raportów.
//   label jest edytowalny i dotyczy WYŁĄCZNIE tego, co widzi user.
// Dlatego zmiana nazwy etapu nie rusza żadnego zapytania raportowego i nie
// migruje ani jednego leada. label = null → frontend bierze wbudowane
// tłumaczenie crm.labels.stages.<key>.
//
// NIE MA etapów „systemowych" (migracja 0326). Wszystko, co jest krokiem lejka
// albo zamknięciem — włącznie z Wygraną i Przegraną — admin może usunąć,
// przemianować i przestawić. Tenant, który nie rozlicza wygranych, po prostu nie
// ma etapu `won`; metryki oparte na nim (win rate, wartość wygrana, długość
// cyklu) znikają wtedy z ekranów, zamiast pokazywać zero.
//
// Granice są strukturalne, nie uznaniowe — i są dokładnie trzy:
//   1. Lejek musi mieć co najmniej jeden etap `open`. To arytmetyka: lead musi
//      gdzieś powstać.
//   2. `converted` i `archived` są nieusuwalne, bo to nie kroki lejka, a stany
//      zapisywane PRZEZ KOD (konwersja leada na partnera w crm-partners.js,
//      archiwizacja w crm-leads.js). Nazwę i im można zmienić.
//   3. Jest najwyżej jeden etap `won` i jeden `lost` — nowe etapy powstają
//      zawsze jako `open`, więc nie da się tego naruszyć.
//
// USUNIĘCIE ETAPU Z LEADAMI nie jest blokowane i nie wymaga niczego od admina:
// backend sam ustala etap docelowy (resolveDeleteTarget) i przenosi leady w tej
// samej transakcji. Admin tylko potwierdza, a panel pokazuje mu w pytaniu, gdzie
// te leady pójdą — żadnego wpisywania kodu etapu. `moveLeadsTo` zostaje jako
// opcjonalne nadpisanie dla wywołań API.
//
// PRZEJŚCIA MIĘDZY ETAPAMI wynikają z kolejności (sort_order) aktywnych etapów
// 'open' + etapu 'won' na końcu, jeśli istnieje — tak jak dotychczasowe,
// zahardkodowane STAGE_SEQ w crm-leads.js. Przestawienie kolejności w panelu
// zmienia więc dozwolone przejścia, i to jest zamierzone.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');

// Maksymalna liczba etapów LEJKA (kind='open') — tyle kolumn ma sens na
// kanbanie i tyle widzi handlowiec w rozwijanej liście. Etapy zamknięcia,
// konwersji i archiwum nie wchodzą do tego limitu, bo admin ich nie dodaje.
const MAX_OPEN_STAGES = 10;

// Kolory dla etapów dodanych przez tenanta. Admin ich nie wybiera — panel
// pokazuje tylko numer i nazwę — ale etap bez koloru byłby szary na kanbanie
// i wyglądałby na zepsuty, a nie na własny.
const NEW_STAGE_COLORS = Object.freeze([
  '#0EA5E9', '#14B8A6', '#8B5CF6', '#EC4899', '#EAB308',
  '#6366F1', '#F43F5E', '#10B981', '#D946EF', '#64748B',
]);

// Fallback dla tenanta, który (jeszcze) nie ma wierszy w tenant_lead_stages —
// np. tenant utworzony między deployem kodu a zaaplikowaniem migracji 0326.
// 1:1 seed z tej migracji, żeby aplikacja nigdy nie została bez etapów.
const DEFAULT_STAGES = Object.freeze([
  { key: 'new',           kind: 'open',      probability: 10,  color: '#94A3B8', sort_order: 1 },
  { key: 'qualification', kind: 'open',      probability: 25,  color: '#F59E0B', sort_order: 2 },
  { key: 'presentation',  kind: 'open',      probability: 50,  color: '#3B82F6', sort_order: 3 },
  { key: 'offer',         kind: 'open',      probability: 70,  color: '#A855F7', sort_order: 4 },
  { key: 'negotiation',   kind: 'open',      probability: 85,  color: '#F97316', sort_order: 5 },
  { key: 'closed_won',    kind: 'won',       probability: 100, color: '#22C55E', sort_order: 6 },
  { key: 'closed_lost',   kind: 'lost',      probability: 0,   color: '#EF4444', sort_order: 7 },
  { key: 'onboarding',    kind: 'converted', probability: 100, color: '#15803D', sort_order: 8 },
  { key: 'onboarded',     kind: 'converted', probability: 100, color: '#15803D', sort_order: 9 },
  { key: 'archived',      kind: 'archived',  probability: 0,   color: '#9CA3AF', sort_order: 10 },
].map(s => Object.freeze({ ...s, id: null, label: null, active: true })));

// Stany zapisywane przez kod, nie wybierane z listy — patrz nagłówek pliku.
const CODE_WRITTEN_KINDS = Object.freeze(['converted', 'archived']);

// Wbudowane nazwy polskie — używane TYLKO w komunikatach błędów backendu
// („Niedozwolone przejście: ... → ..."), które i tak są po polsku. UI bierze
// nazwy z label albo z własnych tłumaczeń, nie z tej mapy.
const BUILTIN_LABELS = Object.freeze({
  new: 'Nowy', qualification: 'Kwalifikacja', presentation: 'Prezentacja',
  offer: 'Oferta', negotiation: 'Negocjacje', closed_won: 'Wygrana',
  closed_lost: 'Przegrana', onboarding: 'Wdrożenie', onboarded: 'Partner',
  archived: 'Archiwum',
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Nazwa etapu do komunikatów backendu: własna nazwa tenanta, inaczej wbudowana. */
function stageLabel(stage) {
  if (!stage) return null;
  return stage.label || BUILTIN_LABELS[stage.key] || stage.key;
}

/**
 * Etapy tenanta w kolejności sort_order — wraz z nieaktywnymi, bo lead może
 * nadal siedzieć na etapie, który admin właśnie wyłączył.
 */
async function listStages(tenantId) {
  const { rows } = await db.query(
    `SELECT id, key, label, kind, probability, color, active, sort_order
       FROM tenant_lead_stages
      WHERE tenant_id = $1
      ORDER BY sort_order, key`,
    [tenantId],
  );
  return rows.length ? rows : DEFAULT_STAGES.map(s => ({ ...s }));
}

/**
 * Etapy + wszystkie listy kodów, których potrzebuje logika leadów. Jedno
 * zapytanie na żądanie — wołane z walidacji i z handlerów w crm-leads.js.
 */
async function getStageConfig(tenantId) {
  const stages = await listStages(tenantId);
  const byKey = new Map(stages.map(s => [s.key, s]));
  const active = stages.filter(s => s.active);
  const openStages = active.filter(s => s.kind === 'open');

  // NULL, gdy tenant usunął ten etap — Wygrana i Przegrana są opcjonalne.
  // Każdy, kto to czyta, MUSI obsłużyć null: metryki oparte na wygranej/
  // przegranej po prostu nie istnieją dla takiego tenanta (patrz nagłówek).
  const wonKey  = active.find(s => s.kind === 'won')?.key  ?? null;
  const lostKey = active.find(s => s.kind === 'lost')?.key ?? null;

  // Sekwencja przejść: lejek w kolejności + wygrana na końcu, jeśli istnieje.
  const sequence = [...openStages.map(s => s.key), ...(wonKey ? [wonKey] : [])];

  // Etap wejściowy: pierwszy w lejku. Lejek nie może zostać bez żadnego etapu
  // 'open' (patrz nagłówek), więc po poprawnej konfiguracji zawsze istnieje.
  const entryKey = openStages[0]?.key ?? null;

  const closedKeys = [wonKey, lostKey].filter(Boolean);
  const convertedKeys = active.filter(s => s.kind === 'converted').map(s => s.key);

  return {
    stages,
    byKey,
    sequence,
    entryKey,
    wonKey,
    lostKey,
    closedKeys,
    convertedKeys,
    archivedKey: active.find(s => s.kind === 'archived')?.key ?? null,
    /** Kody, które user może ustawić ręcznie — bez stanów zapisywanych przez kod. */
    selectableKeys: [...openStages.map(s => s.key), ...closedKeys],
    /**
     * Etapy wliczane do „aktywnego pipeline'u" w raportach i na dashboardach.
     * UWAGA: zawiera też stany konwersji (onboarding/onboarded), bo dotychczasowe
     * zapytania pisały to jako NOT IN (etap wejściowy, wygrana, przegrana) — czyli
     * lead skonwertowany na partnera BYŁ liczony jako aktywna szansa. Zachowujemy
     * to 1:1, żeby wymiana literałów na konfigurację nie zmieniła żadnej liczby
     * w raporcie. Jeśli kiedyś uznamy to za błąd, to osobna, świadoma decyzja.
     */
    pipelineKeys: [...openStages.slice(1).map(s => s.key), ...convertedKeys],
    /** Etapy, na których lead może dostać Hold — lejek bez etapu wejściowego. */
    holdKeys: openStages.slice(1).map(s => s.key),
    /**
     * Etap, od wejścia w który liczymy długość cyklu sprzedaży. Drugi krok lejka,
     * czyli pierwszy po utworzeniu leada — dotąd był to na sztywno
     * 'qualification'. Null, gdy lejek ma tylko jeden etap.
     */
    cycleStartKey: openStages[1]?.key ?? null,
  };
}

/**
 * Dozwolone przejścia z danego etapu — krok w przód, krok w tył, awaryjne
 * wyjście w przegraną. Reguły 1:1 jak dotychczasowe allowedNext() w
 * crm-leads.js, tylko na sekwencji z konfiguracji tenanta.
 */
function allowedNextStages(config, currentKey) {
  const { sequence, entryKey, wonKey, lostKey, archivedKey } = config;
  // Wyjście z archiwum i z przegranej prowadzi na początek lejka.
  if (currentKey === archivedKey || (lostKey && currentKey === lostKey)) {
    return entryKey ? [entryKey] : [];
  }
  if (wonKey && currentKey === wonKey) {
    // Cofnięcie wygranej wraca na ostatni etap lejka przed nią.
    const previous = sequence[sequence.length - 2];
    return previous ? [previous] : [];
  }
  const idx = sequence.indexOf(currentKey);
  if (idx === -1) return [];
  const result = [];
  if (idx > 0) result.push(sequence[idx - 1]);
  if (idx < sequence.length - 1) result.push(sequence[idx + 1]);
  // Awaryjne wyjście w przegraną istnieje tylko, gdy tenant ma taki etap.
  if (lostKey) result.push(lostKey);
  return result;
}

/**
 * Pomocnik do wstawiania kodów etapów do zapytań SQL.
 *
 * PO CO: kody etapów nie mogą już być literałami w SQL (tenant je zmienia), więc
 * jadą jako parametry. Postgres ODRZUCA jednak zapytanie, do którego przekazano
 * parametr nigdzie nieużyty („nie można określić typu danych parametru $N"), a
 * zapytania raportowe używają różnych podzbiorów tych kodów. Dlatego nie da się
 * dopisać wszystkich „na wszelki wypadek" ze stałą numeracją — ten pomysł
 * wywalał się właśnie na tym.
 *
 * Ten pomocnik dokłada parametr DOPIERO przy pierwszym użyciu i zapamiętuje jego
 * numer, więc `values` zawiera dokładnie to, co w zapytaniu wystąpiło.
 * Każde zapytanie potrzebuje własnej instancji (inna baza numeracji).
 *
 *   const s = stageRefs(params, config);
 *   const sql = `... WHERE l.stage = ANY(${s.pipeline()}) AND l.stage <> ${s.won()}`;
 *   db.query(sql, [...params, ...s.values]);   // values czytane PO zbudowaniu sql
 *
 * Rzutowania są jawne (::text / ::text[]), bo wartością może być NULL — tenant,
 * który usunął Wygraną, nie ma `wonKey`, a `l.stage = NULL` ma po prostu dać
 * fałsz, a nie błąd typu.
 */
function stageRefs(baseParams, config) {
  const values = [];
  const cache = new Map();
  const ref = (name, value, cast) => {
    if (!cache.has(name)) {
      values.push(value);
      cache.set(name, `$${baseParams.length + values.length}${cast}`);
    }
    return cache.get(name);
  };
  return {
    values,
    /** Etapy aktywnego pipeline'u (lejek bez wejściowego + stany konwersji). */
    pipeline: () => ref('pipeline', config.pipelineKeys, '::text[]'),
    won:      () => ref('won',      config.wonKey,       '::text'),
    lost:     () => ref('lost',     config.lostKey,      '::text'),
    /** Wygrana + przegrana, bez NULL-i — do „zamknięte" i do win rate. */
    closed:   () => ref('closed',   config.closedKeys,   '::text[]'),
    entry:    () => ref('entry',    config.entryKey,     '::text'),
    archived: () => ref('archived', config.archivedKey,  '::text'),
    /** Kolejność wszystkich etapów — do ORDER BY array_position(...). */
    order:    () => ref('order',    config.stages.map(s => s.key), '::text[]'),
    /** Etap, od wejścia w który liczymy długość cyklu sprzedaży. */
    cycle:    () => ref('cycle',    config.cycleStartKey, '::text'),
  };
}

/**
 * Walidacja wartości `stage` z żądania. Osobna od express-validator, bo lista
 * dozwolonych wartości zależy od tenanta, a nie od stałej w kodzie.
 */
async function assertStageSelectable(tenantId, stageKey) {
  const config = await getStageConfig(tenantId);
  if (!config.selectableKeys.includes(stageKey)) {
    throw httpError(400, `Nieznany etap leada: "${stageKey}".`);
  }
  return config;
}

// ── Mutacje konfiguracji (admin tenanta) ─────────────────────────────────

/** Slug kodu nowego etapu z nazwy + deduplikacja. Nadawany raz, nigdy nie zmieniany. */
function slugifyKey(label, takenKeys) {
  const base = label
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, ch => ({ ą:'a', ć:'c', ę:'e', ł:'l', ń:'n', ó:'o', ś:'s', ź:'z', ż:'z' }[ch]))
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50) || 'stage';
  if (!takenKeys.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`;
    if (!takenKeys.has(candidate)) return candidate;
  }
  throw httpError(409, 'Nie udało się nadać unikalnego kodu etapu.');
}

/**
 * Tenant bez wierszy (tryb fallback) dostaje je fizycznie przed pierwszą
 * mutacją — inaczej edycja etapu nie miałaby czego zmienić.
 */
async function materializeDefaults(tenantId, client = db) {
  const { rows } = await client.query(
    'SELECT 1 FROM tenant_lead_stages WHERE tenant_id = $1 LIMIT 1', [tenantId],
  );
  if (rows.length) return;
  for (const stage of DEFAULT_STAGES) {
    await client.query(
      `INSERT INTO tenant_lead_stages (tenant_id, key, kind, probability, color, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, stage.key, stage.kind, stage.probability, stage.color, stage.sort_order],
    );
  }
}

/** Nowy etap lejka. Nowe etapy są zawsze kind='open' — zamknięć się nie dodaje. */
async function addStage(tenantId, { label, probability, color, sortOrder }) {
  return db.transaction(async (client) => {
    await materializeDefaults(tenantId, client);
    const { rows: existing } = await client.query(
      `SELECT key, kind, probability, sort_order FROM tenant_lead_stages WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    const openStages = existing.filter(s => s.kind === 'open');
    if (openStages.length >= MAX_OPEN_STAGES) {
      throw httpError(422, `Maksymalna liczba etapów lejka to ${MAX_OPEN_STAGES}.`);
    }
    const key = slugifyKey(label, new Set(existing.map(s => s.key)));

    // Nowy etap domyślnie na końcu lejka — czyli przed etapem wygranej, nie na
    // samym końcu listy, gdzie siedzą zamknięcia i archiwum.
    const lastOpenOrder = Math.max(0, ...openStages.map(s => s.sort_order));
    const position = sortOrder ?? lastOpenOrder + 1;

    // Prawdopodobieństwo i kolor wynikają z POZYCJI etapu w lejku — admin ich nie
    // wpisuje (panel pokazuje tylko numer i nazwę). Prawdopodobieństwo to połowa
    // drogi między etapem poprzedzającym a wygraną (100), czyli im dalej w lejku,
    // tym wyżej — zgodnie z sensem paska postępu na kanbanie.
    const previous = openStages
      .filter(s => s.sort_order < position)
      .sort((a, b) => b.sort_order - a.sort_order)[0];
    const derivedProbability = Math.round(((previous?.probability ?? 0) + 100) / 2);
    const derivedColor = NEW_STAGE_COLORS[openStages.length % NEW_STAGE_COLORS.length];

    await client.query(
      `UPDATE tenant_lead_stages SET sort_order = sort_order + 1, updated_at = now()
        WHERE tenant_id = $1 AND sort_order >= $2`,
      [tenantId, position],
    );
    const { rows } = await client.query(
      `INSERT INTO tenant_lead_stages (tenant_id, key, label, kind, probability, color, sort_order)
       VALUES ($1,$2,$3,'open',$4,$5,$6)
       RETURNING id, key, label, kind, probability, color, active, sort_order`,
      [tenantId, key, label, probability ?? derivedProbability, color ?? derivedColor, position],
    );
    return rows[0];
  });
}

/**
 * Zmiana etapu. `key` i `kind` są celowo nieedytowalne — key bo leży w danych
 * leadów, kind bo niesie zachowanie.
 */
async function updateStage(tenantId, stageId, patch) {
  return db.transaction(async (client) => {
    await materializeDefaults(tenantId, client);
    const { rows: found } = await client.query(
      `SELECT * FROM tenant_lead_stages WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, stageId],
    );
    if (!found.length) throw httpError(404, 'Etap nie znaleziony.');
    const stage = found[0];

    // Wyłączenie etapu z leadami jest dozwolone: wiersz zostaje, więc lead nadal
    // ma skąd wziąć nazwę swojego etapu — po prostu nikt nowy go już nie wybierze.
    // Nie da się tylko wyłączyć ostatniego etapu lejka (lead musi gdzieś powstać).
    if (patch.active === false && stage.kind === 'open') {
      const { rows: [{ count }] } = await client.query(
        `SELECT COUNT(*)::int AS count FROM tenant_lead_stages
          WHERE tenant_id = $1 AND kind = 'open' AND active AND id <> $2`,
        [tenantId, stageId],
      );
      if (count === 0) {
        throw httpError(422, 'Lejek musi mieć co najmniej jeden aktywny etap — nowe leady muszą gdzieś powstawać.');
      }
    }

    const sets = [];
    const params = [];
    let p = 1;
    // label: pusty string → NULL, czyli powrót do wbudowanego tłumaczenia.
    if ('label' in patch) {
      sets.push(`label = $${p++}`);
      params.push(patch.label ? patch.label.trim() : null);
    }
    for (const [field, column] of [['probability', 'probability'], ['color', 'color'], ['active', 'active']]) {
      if (field in patch) {
        sets.push(`${column} = $${p++}`);
        params.push(patch[field]);
      }
    }
    if (!sets.length) throw httpError(400, 'Brak pól do aktualizacji.');

    sets.push('updated_at = now()');
    params.push(tenantId, stageId);
    const { rows } = await client.query(
      `UPDATE tenant_lead_stages SET ${sets.join(', ')}
        WHERE tenant_id = $${p++} AND id = $${p}
        RETURNING id, key, label, kind, probability, color, active, sort_order`,
      params,
    );
    return rows[0];
  });
}

/**
 * Gdzie trafią leady po usunięciu danego etapu. Reguła jest celowo przewidywalna,
 * żeby panel mógł pokazać ten etap w pytaniu „usunąć?", a admin nie musiał go
 * wybierać:
 *   krok lejka      → poprzedni krok lejka, a dla pierwszego — następny,
 *   wygrana/przegrana → ostatni krok lejka (lead wraca na koniec lejka).
 * Zwraca null, gdy nie ma gdzie przenieść (etapu i tak nie da się wtedy usunąć).
 */
function resolveDeleteTarget(stages, stage) {
  const open = stages
    .filter(s => s.kind === 'open' && s.id !== stage.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (!open.length) return null;
  if (stage.kind !== 'open') return open[open.length - 1].key;
  const earlier = open.filter(s => s.sort_order < stage.sort_order);
  return (earlier.length ? earlier[earlier.length - 1] : open[0]).key;
}

/**
 * Usunięcie etapu — dowolnego kroku lejka oraz Wygranej/Przegranej. Leady z tego
 * etapu przechodzą w TEJ SAMEJ transakcji na etap z resolveDeleteTarget (albo na
 * jawnie podany `moveLeadsTo`), więc usunięcie nigdy nie zostawia leada z kodem
 * etapu, którego już nie ma, i nigdy nie kończy się odmową „najpierw przenieś".
 *
 * Nieusuwalne są tylko stany zapisywane przez kod (converted/archived) i ostatni
 * etap lejka — powody w nagłówku pliku. Historia w audit_logs zachowuje stary kod
 * etapu i tego nie przepisujemy: to zapis tego, co się wtedy stało.
 */
async function deleteStage(tenantId, stageId, { moveLeadsTo = null } = {}) {
  return db.transaction(async (client) => {
    await materializeDefaults(tenantId, client);
    const { rows: all } = await client.query(
      `SELECT * FROM tenant_lead_stages WHERE tenant_id = $1 FOR UPDATE`, [tenantId],
    );
    const stage = all.find(s => s.id === stageId);
    if (!stage) throw httpError(404, 'Etap nie znaleziony.');

    if (CODE_WRITTEN_KINDS.includes(stage.kind)) {
      throw httpError(422, `"${stageLabel(stage)}" nie jest krokiem lejka, a stanem, który aplikacja ustawia sama (${stage.kind === 'archived' ? 'archiwizacja leada' : 'konwersja leada na partnera'}), więc nie da się go usunąć. Nazwę możesz zmienić.`);
    }
    if (stage.kind === 'open' && all.filter(s => s.kind === 'open').length === 1) {
      throw httpError(422, 'Nie można usunąć ostatniego etapu lejka — nowe leady muszą gdzieś powstawać.');
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::int AS count FROM crm_leads WHERE tenant_id = $1 AND stage = $2',
      [tenantId, stage.key],
    );

    let movedLeads = 0;
    let movedTo = null;
    if (count > 0) {
      // Brak wskazanego celu NIE jest błędem — ustalamy go sami, tą samą regułą,
      // którą panel pokazał adminowi w pytaniu „usunąć?".
      const targetKey = moveLeadsTo ?? resolveDeleteTarget(all, stage);
      const target = all.find(s => s.key === targetKey && s.id !== stageId);
      if (!target) throw httpError(422, 'Nie ma etapu, na który można przenieść leady z tego etapu.');
      if (CODE_WRITTEN_KINDS.includes(target.kind)) {
        throw httpError(422, `Nie można przenieść leadów na "${stageLabel(target)}" — ten stan aplikacja ustawia sama.`);
      }
      const { rowCount } = await client.query(
        'UPDATE crm_leads SET stage = $1, updated_at = now() WHERE tenant_id = $2 AND stage = $3',
        [target.key, tenantId, stage.key],
      );
      movedLeads = rowCount;
      movedTo = target.key;
    }

    await client.query('DELETE FROM tenant_lead_stages WHERE tenant_id = $1 AND id = $2', [tenantId, stageId]);
    return { key: stage.key, movedLeads, movedTo };
  });
}

/**
 * Nowa kolejność etapów lejka. Zmienia też dozwolone przejścia — sekwencja
 * wynika z sort_order (patrz nagłówek pliku).
 */
async function reorderStages(tenantId, orderedIds) {
  return db.transaction(async (client) => {
    await materializeDefaults(tenantId, client);
    const { rows: openStages } = await client.query(
      `SELECT id FROM tenant_lead_stages WHERE tenant_id = $1 AND kind = 'open' FOR UPDATE`,
      [tenantId],
    );
    const openIds = new Set(openStages.map(s => s.id));
    if (orderedIds.length !== openIds.size || orderedIds.some(id => !openIds.has(id))) {
      throw httpError(422, 'Nowa kolejność musi zawierać dokładnie wszystkie etapy lejka, każdy raz.');
    }
    // Lejek zajmuje pozycje 1..n; zamknięcia i archiwum przesuwają się za niego.
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE tenant_lead_stages SET sort_order = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3',
        [i + 1, tenantId, orderedIds[i]],
      );
    }
    let next = orderedIds.length + 1;
    const { rows: rest } = await client.query(
      `SELECT id FROM tenant_lead_stages
        WHERE tenant_id = $1 AND kind <> 'open'
        ORDER BY CASE kind WHEN 'won' THEN 1 WHEN 'lost' THEN 2 WHEN 'converted' THEN 3 ELSE 4 END, sort_order`,
      [tenantId],
    );
    for (const row of rest) {
      await client.query(
        'UPDATE tenant_lead_stages SET sort_order = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3',
        [next++, tenantId, row.id],
      );
    }
    return listStages(tenantId);
  });
}

/**
 * Etapy dla NOWO tworzonego tenanta — kopia z tenanta wzorcowego (crmtree-gold),
 * a gdy ten jeszcze nic nie ma, wbudowany lejek. Ten sam wzorzec co
 * tenantIcpConfigService.seedDefaultConfigForTenant — wołane z transakcji
 * tworzenia tenanta (admin-tenants.js), dlatego przyjmuje `client`.
 * Bez tego nowy tenant miałby etapy tylko dzięki fallbackowi w kodzie, a panel
 * „Etapy leada" byłby pusty (brak wierszy do edycji).
 */
async function seedStagesForTenant(client, tenantId, { sourceTenantId = null } = {}) {
  if (sourceTenantId) {
    const { rowCount } = await client.query(
      `INSERT INTO tenant_lead_stages (tenant_id, key, label, kind, probability, color, active, sort_order)
       SELECT $1, key, label, kind, probability, color, active, sort_order
         FROM tenant_lead_stages WHERE tenant_id = $2
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, sourceTenantId],
    );
    if (rowCount > 0) return;
  }
  await materializeDefaults(tenantId, client);
}

/** Liczba leadów per etap — panel pokazuje, czego usunięcie nie przejdzie. */
async function countLeadsPerStage(tenantId) {
  const { rows } = await db.query(
    'SELECT stage, COUNT(*)::int AS count FROM crm_leads WHERE tenant_id = $1 GROUP BY stage',
    [tenantId],
  );
  return Object.fromEntries(rows.map(r => [r.stage, r.count]));
}

module.exports = {
  MAX_OPEN_STAGES,
  DEFAULT_STAGES,
  listStages,
  getStageConfig,
  allowedNextStages,
  stageRefs,
  resolveDeleteTarget,
  assertStageSelectable,
  stageLabel,
  addStage,
  updateStage,
  deleteStage,
  reorderStages,
  countLeadsPerStage,
  materializeDefaults,
  seedStagesForTenant,
};
