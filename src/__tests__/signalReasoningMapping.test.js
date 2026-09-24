'use strict';

// Poprawka 22.09: enrichLog.claude.signal_reasoning dopasowywał wpisy AI po
// `s.id === entry.id`, ale AI zwraca `entry.key` (nie `entry.id` — kontrakt
// {key,value,reasoning}, ten sam pattern po którym już poprawnie liczy
// calcIcpScore()) — reasoning zawsze wychodziło puste {}, mimo że AI je
// realnie zwracało. buildSignalReasoningMap() naprawia to, dopasowując po key.

const svc = require('../services/prospectEnrichmentService');

const TENANT_SIGNALS = [
  { id: 'uuid-1', key: 'dzial_handlowy', label: 'Dział handlowy', points: 30 },
  { id: 'uuid-2', key: 'zlozony_proces_sprzedazy', label: 'Indywidualna wycena', points: 25 },
  { id: 'uuid-3', key: 'konsultacja_demo', label: 'Konsultacja demo', points: 15 },
];

describe('buildSignalReasoningMap — mapowanie reasoning po key (nie po id)', () => {
  test('zwraca reasoning dla TRUE sygnału, kluczowane po key', () => {
    const aiSignals = [
      { key: 'dzial_handlowy', value: false, reasoning: 'Brak nazwanego działu' },
      { key: 'konsultacja_demo', value: true, reasoning: 'Umów demo w menu' },
    ];
    const result = svc.buildSignalReasoningMap(aiSignals, TENANT_SIGNALS);
    expect(result.konsultacja_demo).toBe('Umów demo w menu');
  });

  test('zwraca reasoning RÓWNIEŻ dla FALSE sygnału — reasoning nie zależy od value', () => {
    const aiSignals = [
      { key: 'dzial_handlowy', value: false, reasoning: 'Brak nazwanego działu' },
    ];
    const result = svc.buildSignalReasoningMap(aiSignals, TENANT_SIGNALS);
    expect(result.dzial_handlowy).toBe('Brak nazwanego działu');
  });

  test('regresja: dopasowanie po id (stary, błędny kontrakt) nie może dawać pustego wyniku', () => {
    // AI nigdy nie wysyła "id" — to jest dokładnie to wejście, które wcześniej
    // (błędnie) próbowano dopasować przez s.id===entry.id i zawsze dostawało {}.
    const aiSignals = [
      { key: 'zlozony_proces_sprzedazy', value: false, reasoning: 'Cennik stały, brak wyceny' },
    ];
    const result = svc.buildSignalReasoningMap(aiSignals, TENANT_SIGNALS);
    expect(result).not.toEqual({});
    expect(result.zlozony_proces_sprzedazy).toBe('Cennik stały, brak wyceny');
  });

  test('nieznany key spoza configu tenanta jest pomijany, nie rzuca błędu', () => {
    const aiSignals = [{ key: 'nieznany_sygnal', value: true, reasoning: 'x' }];
    const result = svc.buildSignalReasoningMap(aiSignals, TENANT_SIGNALS);
    expect(result).toEqual({});
  });

  test('brak/niepoprawne aiSignals -> null (nie rzuca, spójne z enrichLog gdy AI się nie powiodło)', () => {
    expect(svc.buildSignalReasoningMap(null, TENANT_SIGNALS)).toBeNull();
    expect(svc.buildSignalReasoningMap(undefined, TENANT_SIGNALS)).toBeNull();
  });

  test('pusta reasoning (AI nie podało) -> null, nie undefined ani pominięcie klucza', () => {
    const aiSignals = [{ key: 'dzial_handlowy', value: true }];
    const result = svc.buildSignalReasoningMap(aiSignals, TENANT_SIGNALS);
    expect(result.dzial_handlowy).toBeNull();
  });
});

describe('calcIcpScore — spójność score z sumą aktywnych sygnałów (case Nordbeton)', () => {
  test('tylko jeden TRUE sygnał (15 pkt) -> score dokładnie 15, bez wpływu pozostałych false', () => {
    const aiSignals = [
      { key: 'dzial_handlowy', value: false },
      { key: 'zlozony_proces_sprzedazy', value: false },
      { key: 'konsultacja_demo', value: true },
    ];
    const result = svc.calcIcpScore(aiSignals, TENANT_SIGNALS);
    expect(result.raw).toBe(15);
    expect(result.capped).toBe(15);
  });

  test('score = dokładna suma punktów wszystkich TRUE sygnałów, niezależnie (bez requires_any_of/gates/bonus)', () => {
    const aiSignals = [
      { key: 'dzial_handlowy', value: true },
      { key: 'zlozony_proces_sprzedazy', value: true },
      { key: 'konsultacja_demo', value: false },
    ];
    const result = svc.calcIcpScore(aiSignals, TENANT_SIGNALS);
    expect(result.raw).toBe(30 + 25);
  });

  test('wszystkie false -> score 0', () => {
    const aiSignals = TENANT_SIGNALS.map(s => ({ key: s.key, value: false }));
    const result = svc.calcIcpScore(aiSignals, TENANT_SIGNALS);
    expect(result.raw).toBe(0);
  });
});
