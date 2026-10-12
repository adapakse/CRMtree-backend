'use strict';
//
// parseIsoFollowUpDate — data policzona przez model (follow_up_date_iso).
// Ma działać niezależnie od języka rozmowy, ale jest zwykłym wejściem od AI,
// więc testujemy przede wszystkim ODRZUCANIE śmieci.
//
// Punkt odniesienia: poniedziałek 2026-10-12 (data rozmowy).

const { parseIsoFollowUpDate } = require('../services/callAnalysisService');

const REF = new Date(2026, 9, 12); // 2026-10-12, poniedziałek
const p = (raw) => parseIsoFollowUpDate(raw, REF);

describe('parseIsoFollowUpDate — poprawne daty', () => {
  test('data w przyszłości przechodzi bez zmian', () => {
    expect(p('2026-10-27')).toBe('2026-10-27');
  });

  test('dzień rozmowy jest dozwolony', () => {
    expect(p('2026-10-12')).toBe('2026-10-12');
  });

  test('sobota przesuwa się na najbliższy dzień roboczy', () => {
    expect(p('2026-10-17')).toBe('2026-10-19'); // sobota → poniedziałek
  });

  test('niedziela przesuwa się na poniedziałek', () => {
    expect(p('2026-10-18')).toBe('2026-10-19');
  });

  test('spacje wokół wartości nie przeszkadzają', () => {
    expect(p('  2026-11-30  ')).toBe('2026-11-30');
  });
});

describe('parseIsoFollowUpDate — odrzucanie', () => {
  test('data przed rozmową', () => {
    expect(p('2026-10-11')).toBeNull();
  });

  test('data dalej niż 18 miesięcy od rozmowy', () => {
    expect(p('2028-10-12')).toBeNull();
  });

  test('dzień, którego nie ma w kalendarzu', () => {
    expect(p('2027-02-31')).toBeNull();
  });

  test('miesiąc poza zakresem', () => {
    expect(p('2026-13-01')).toBeNull();
  });

  test('inny format daty', () => {
    expect(p('27.10.2026')).toBeNull();
    expect(p('2026/10/27')).toBeNull();
    expect(p('27 октября')).toBeNull();
  });

  test('null, pusty string i typy inne niż string', () => {
    expect(p(null)).toBeNull();
    expect(p('')).toBeNull();
    expect(p(20261027)).toBeNull();
    expect(p({ date: '2026-10-27' })).toBeNull();
  });
});

describe('parseIsoFollowUpDate — granica 18 miesięcy', () => {
  test('dokładnie 18 miesięcy przechodzi', () => {
    expect(p('2028-04-12')).toBe('2028-04-12');
  });

  test('dzień po granicy odpada', () => {
    expect(p('2028-04-13')).toBeNull();
  });
});
