'use strict';

// calcIcpScore() / getIcpScoringRules() — od ETAPU B (dynamiczny ICP per tenant)
// obie funkcje operują na configu tenanta (tenantIcpConfigService), nie na
// hardkodowanym ICP_SIGNALS. Od decyzji 2026-09-22 DEFAULT_SIGNALS to schemat
// Gold (9 sygnałów, 7 aktywnych sumujących się do 100 — rozproszona_struktura i
// ecommerce_b2b domyślnie wyłączone) i icp_score to WYŁĄCZNIE suma aktywnych
// sygnałów (gates/bonus informacyjne, requires_any_of nie wpływa na wynik).

const svc = require('../services/prospectEnrichmentService');
const tenantIcpConfigService = require('../services/tenantIcpConfigService');

const { DEFAULT_SIGNALS } = tenantIcpConfigService;

// Buduje odpowiedź AI w nowym kontrakcie {signals:[{key,value,reasoning}]} z listy
// key-i, które mają wyjść jako true — czyta się analogicznie do dawnego
// `{ field_sales_team: true }`. Kontrakt AI operuje na `key` (nie na technicznym
// UUID `id`) — decyzja po analizie: krótszy prompt/output, brak ryzyka, że model
// błędnie przepisze losowy UUID, key nie ma mniejszej stabilności niż id.
function aiSignalsFromKeys(trueKeys) {
  return DEFAULT_SIGNALS.map(s => ({
    key: s.key,
    value: trueKeys.includes(s.key),
    reasoning: 'test',
  }));
}

// Sygnały AKTYWNE domyślnego configu (schemat Gold) — to dokładnie to, co
// enrichOne() faktycznie przekazuje do calcIcpScore() (icpConfig.activeSignals,
// nie surowe icpConfig.signals). calcIcpScore() sam NIE filtruje po `active` —
// filtrowanie robi wywołujący, stąd testy "realistycznego" wywołania używają
// tego podzbioru, nie całej (9-elementowej) tablicy DEFAULT_SIGNALS.
const ACTIVE_DEFAULT_SIGNALS = DEFAULT_SIGNALS.filter(s => s.active);

describe('calcIcpScore — domyślny config CRMtree (7 aktywnych sygnałów, suma 100)', () => {
  test('dzial_handlowy=true samodzielnie daje 30 pkt', () => {
    const result = svc.calcIcpScore(aiSignalsFromKeys(['dzial_handlowy']), ACTIVE_DEFAULT_SIGNALS);
    expect(result.raw).toBe(30);
  });

  test('maxPossible (suma wag aktywnych sygnałów) wynosi 100', () => {
    const result = svc.calcIcpScore(aiSignalsFromKeys([]), ACTIVE_DEFAULT_SIGNALS);
    expect(result.maxPossible).toBe(100);
  });

  test('wszystkie 7 aktywnych sygnałów true daje raw=100 (30+25+15+10+5+5+10)', () => {
    const result = svc.calcIcpScore(
      aiSignalsFromKeys(ACTIVE_DEFAULT_SIGNALS.map(s => s.key)),
      ACTIVE_DEFAULT_SIGNALS,
    );
    expect(result.raw).toBe(100);
  });

  test('breakdown[].id używa stabilnego key ("dzial_handlowy"), NIE technicznego UUID — zachowuje backward-compat z historycznymi danymi i frontendem', () => {
    const result = svc.calcIcpScore(aiSignalsFromKeys(['dzial_handlowy']), ACTIVE_DEFAULT_SIGNALS);
    const entry = result.breakdown.find(b => b.hit);
    expect(entry.id).toBe('dzial_handlowy');
    expect(entry.id).not.toMatch(/^[0-9a-f-]{36}$/); // nie UUID
  });

  test('brak odpowiedzi AI (aiSignals=undefined) scoruje wszystko jako false — graceful degradation jak przed refaktorem', () => {
    const result = svc.calcIcpScore(undefined, ACTIVE_DEFAULT_SIGNALS);
    expect(result.raw).toBe(0);
    expect(result.breakdown.every(b => b.hit === false)).toBe(true);
    expect(result.breakdown).toHaveLength(7);
  });
});

describe('calcIcpScore — requires_any_of nie wpływa już na scoring (decyzja 2026-09-22)', () => {
  test('ecommerce_b2b liczy się nawet bez dzial_handlowy/opieka_nad_klientem (requires_any_of zignorowane, suppressed zawsze false)', () => {
    // ecommerce_b2b jest domyślnie inactive, ale wywołanie samego calcIcpScore() z
    // pełną (niefiltrowaną) listą pokazuje, że sama obecność requires_any_of na
    // sygnale już nic nie blokuje — to wywołujący decyduje, które sygnały w ogóle
    // przekazać (patrz ACTIVE_DEFAULT_SIGNALS wyżej).
    const result = svc.calcIcpScore(aiSignalsFromKeys(['ecommerce_b2b']), DEFAULT_SIGNALS);
    const entry = result.breakdown.find(b => b.id === 'ecommerce_b2b');
    expect(entry.hit).toBe(true);
    expect(entry.suppressed).toBe(false);
    expect(result.raw).toBe(5);
  });
});

describe('validateAiSignalsResponse — kontrakt AI oparty o key, nie UUID', () => {
  test('poprawna odpowiedź (9/9 po key) przechodzi', () => {
    expect(() => svc.validateAiSignalsResponse(aiSignalsFromKeys(['dzial_handlowy']), DEFAULT_SIGNALS))
      .not.toThrow();
  });

  test('wpis z technicznym id zamiast key jest odrzucany (brak pola "key")', () => {
    const badSignals = DEFAULT_SIGNALS.map(s => ({ id: s.id, value: false, reasoning: 'x' }));
    expect(() => svc.validateAiSignalsResponse(badSignals, DEFAULT_SIGNALS))
      .toThrow(svc.IcpAiResponseValidationError);
  });

  test('brakujący key rzuca błąd wymieniający brakujący key (nie UUID)', () => {
    const incomplete = aiSignalsFromKeys(['dzial_handlowy']).slice(0, 7);
    expect(() => svc.validateAiSignalsResponse(incomplete, DEFAULT_SIGNALS))
      .toThrow(/brak wpisu "signals" dla key: /);
  });
});

describe('ICP_REQUIRED_SIGNALS_MAX_SCORE — stałe 100, niezależne od gates/bonus (decyzja 2026-09-22)', () => {
  test('równa się ICP_TOTAL_MAX_SCORE — sygnały same muszą wypełnić cały sufit', () => {
    expect(svc.ICP_REQUIRED_SIGNALS_MAX_SCORE).toBe(svc.ICP_TOTAL_MAX_SCORE);
    expect(svc.ICP_REQUIRED_SIGNALS_MAX_SCORE).toBe(100);
  });

  test('evaluateIcpConfigValidity oznacza config z sumą sygnałów=100 jako poprawny, finalMaxScore=signalsSum (gates/bonus już nie dodają punktów)', () => {
    const result = svc.evaluateIcpConfigValidity({ maxScore: 100 });
    expect(result).toEqual({ signalsSum: 100, signalsMax: 100, isValid: true, finalMaxScore: 100 });
  });

  test('evaluateIcpConfigValidity oznacza config z sumą != 100 jako niepoprawny (np. wyłączony sygnał bez rekompensaty punktów gdzie indziej)', () => {
    const result = svc.evaluateIcpConfigValidity({ maxScore: 70 });
    expect(result.isValid).toBe(false);
    expect(result.finalMaxScore).toBe(70);
  });
});

describe('getIcpScoringRules — max_possible_score == 100 dla domyślnego configu (schemat Gold)', () => {
  // tenant_id nieistniejący celowo — brak wierszy w tenant_icp_signals/
  // tenant_icp_configs/app_settings sprawia, że wszystko wraca do wartości
  // domyślnych (DEFAULT_SIGNALS + próg 45), nie wymaga realnego tenanta.
  const FAKE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

  test('dzial_handlowy ma wagę 30 w definicjach sygnałów', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    const def = rules.signals.definitions.find(d => d.id === 'dzial_handlowy');
    expect(def.points).toBe(30);
  });

  test('max_possible_score wynosi dokładnie 100 (wyłącznie suma aktywnych sygnałów — gates/bonus informacyjne)', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    expect(rules.max_possible_score).toBe(100);
  });

  test('sekcja signals jest oznaczona jako domyślny (fallback) config, poprawny (100/100)', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    expect(rules.signals.is_default_config).toBe(true);
    expect(rules.signals.is_valid).toBe(true);
    expect(rules.signals.max_points).toBe(100);
  });
});
