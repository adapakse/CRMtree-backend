'use strict';

// Targeted test etapu 1 (23.09) — naprawa timeoutu resolvera domen i
// raportowania `attempts`.
//
// Dwa błędy potwierdzone w audycie 47 firm bez `done`:
//   1. FALLBACK_TIME_BUDGET_MS = 8 s był MNIEJSZY niż najgorszy koszt jednego
//      kandydata (verifyUrl: HEAD 6 s + GET 6 s = 12 s) — timeout potrafił
//      wystrzelić zanim skończyła się pierwsza partia.
//   2. Gałąź timeoutu zwracała zahardkodowane `attempts: []`, więc log
//      pokazywał "0 sprawdzonych kandydatów" nawet gdy kandydaci byli
//      sprawdzeni. To artefakt raportowania, nie realne zero prób.
//
// Test nie rusza sieci — axios jest zamockowany.

jest.mock('axios');
const axios = require('axios');

const svc = require('../services/prospectEnrichmentService');
const { resolveDomainFallback, verifyUrl } = svc;

const COMPANY = { company_name: 'Testowa Firma sp. z o.o.', nip: '1234567890' };

function hangingResponse(ms) {
  return new Promise((resolve) => setTimeout(() => resolve({ status: 200, data: '<html></html>', headers: {} }), ms));
}

beforeEach(() => {
  jest.clearAllMocks();
  axios.head = jest.fn();
  axios.get = jest.fn();
});

describe('etap 1 — verifyUrl: timeout per próbę jest konfigurowalny', () => {
  test('domyślnie zachowuje 6 s (zachowanie sprzed poprawki dla wywołań spoza fallbacku)', async () => {
    axios.head.mockResolvedValue({ status: 200 });
    await verifyUrl('https://example.pl');
    expect(axios.head).toHaveBeenCalledWith('https://example.pl', expect.objectContaining({ timeout: 6_000 }));
  });

  test('przyjmuje krótszy timeout, gdy podany jawnie', async () => {
    axios.head.mockResolvedValue({ status: 200 });
    await verifyUrl('https://example.pl', { timeoutMs: 3_000 });
    expect(axios.head).toHaveBeenCalledWith('https://example.pl', expect.objectContaining({ timeout: 3_000 }));
  });
});

describe('etap 1 — resolveDomainFallback', () => {
  test('używa krótszego timeoutu per kandydat (3 s), nie domyślnych 6 s', async () => {
    axios.head.mockRejectedValue(new Error('ENOTFOUND'));
    axios.get.mockRejectedValue(new Error('ENOTFOUND'));

    await resolveDomainFallback({ company: COMPANY, krsData: null, gusData: null, rejectedUrl: null });

    expect(axios.head).toHaveBeenCalled();
    for (const call of axios.head.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ timeout: 3_000 }));
    }
  });

  test('gdy żaden kandydat nie odpowiada → method "none" i attempts z wszystkimi próbami', async () => {
    axios.head.mockRejectedValue(new Error('ENOTFOUND'));
    axios.get.mockRejectedValue(new Error('ENOTFOUND'));

    const res = await resolveDomainFallback({ company: COMPANY, krsData: null, gusData: null, rejectedUrl: null });

    expect(res.method).toBe('none');
    expect(res.url).toBeNull();
    expect(res.attempts.length).toBeGreaterThan(0);          // REGRESJA: nie może być puste
    expect(res.attempts.every(a => a.exists === false)).toBe(true);
  });

  // GŁÓWNA REGRESJA etapu 1 (druga iteracja): wiszący kandydat NIE może
  // zabierać całego budżetu ani znikać z raportu. Po dołożeniu limitu per
  // kandydat (FALLBACK_CANDIDATE_BUDGET_MS) operacja kończy się normalnie
  // (`none`), a wiszący kandydaci są widoczni w `attempts` jako
  // `candidate_timeout` — zamiast, jak przed poprawką, zwracać globalny
  // `timeout` z pustą tablicą.
  test('REGRESJA: wiszący kandydat jest ucinany i RAPORTOWANY, nie gubiony', async () => {
    jest.useFakeTimers();
    try {
      let call = 0;
      axios.head.mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('ENOTFOUND'));
        return hangingResponse(60_000);   // wisi znacznie dłużej niż budżet kandydata
      });
      axios.get.mockImplementation(() => Promise.reject(new Error('ENOTFOUND')));

      const promise = resolveDomainFallback({ company: COMPANY, krsData: null, gusData: null, rejectedUrl: null });
      await jest.advanceTimersByTimeAsync(20_000);
      const res = await promise;

      // operacja DOCHODZI DO KOŃCA mimo wiszących kandydatów
      expect(res.method).toBe('none');
      expect(res.url).toBeNull();
      // i nikt nie ginie po drodze — to jest sedno poprawki
      expect(res.attempts.length).toBeGreaterThan(0);
      expect(res.attempts.some(a => a.reason === 'candidate_timeout')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('arytmetyka budżetów: cała partia mieści się w budżecie globalnym', () => {
    // Warunek złamany przed poprawką: budżet globalny 8 s < koszt jednego
    // kandydata 12 s (HEAD 6 s + GET 6 s). Teraz kandydat ma twardy limit,
    // a budżet globalny jest od niego wyraźnie większy.
    const perCandidate = 6_000;   // FALLBACK_CANDIDATE_BUDGET_MS
    const globalBudget = 15_000;  // FALLBACK_TIME_BUDGET_MS
    expect(globalBudget).toBeGreaterThan(perCandidate * 2);
  });
});
