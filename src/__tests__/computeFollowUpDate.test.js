'use strict';
//
// computeFollowUpDate — nazwa dnia + kwalifikator tygodnia ("za tydzień w
// czwartek", "przyszły czwartek" itd.) ma dawać ten dzień w docelowym tygodniu,
// a nie sam offset +7 dni. Plus regresja: pozostałe frazy bez zmian.
//
// Punkt odniesienia: wtorek 2026-09-01.

const { computeFollowUpDate } = require('../services/callAnalysisService');

const REF = new Date(2026, 8, 1); // 2026-09-01, wtorek
const d = (hint) => computeFollowUpDate(hint, REF);

describe('computeFollowUpDate — dzień + kwalifikator tygodnia (nowe)', () => {
  test('"za tydzień w czwartek" → czwartek następnego tygodnia', () => {
    expect(d('za tydzień w czwartek')).toBe('2026-09-10');
  });
  test('"za 2 tygodnie we wtorek" → wtorek za dwa tygodnie', () => {
    expect(d('za 2 tygodnie we wtorek')).toBe('2026-09-15');
  });
  test('"w przyszły czwartek" → czwartek przyszłego tygodnia', () => {
    expect(d('w przyszły czwartek')).toBe('2026-09-10');
  });
  test('"następny piątek" → piątek przyszłego tygodnia', () => {
    expect(d('następny piątek')).toBe('2026-09-11');
  });
  test('"za tydzień w poniedziałek" → poniedziałek przyszłego tygodnia', () => {
    expect(d('za tydzień w poniedziałek')).toBe('2026-09-07');
  });
});

describe('computeFollowUpDate — regresja (bez zmian)', () => {
  test('"jutro"', () => expect(d('jutro')).toBe('2026-09-02'));
  test('"za 3 dni"', () => expect(d('za 3 dni')).toBe('2026-09-04'));
  test('"za tydzień" (bez dnia) → dziś + 7', () => expect(d('za tydzień')).toBe('2026-09-08'));
  test('"za 2 tygodnie" (bez dnia) → dziś + 14', () => expect(d('za 2 tygodnie')).toBe('2026-09-15'));
  test('"w piątek" → najbliższy piątek', () => expect(d('w piątek')).toBe('2026-09-04'));
  test('"czwartek" → najbliższy czwartek', () => expect(d('czwartek')).toBe('2026-09-03'));
  test('"przyszły tydzień" (bez dnia) → +4 dni robocze', () => expect(d('przyszły tydzień')).toBe('2026-09-07'));
  test('"koniec tygodnia" → piątek', () => expect(d('koniec tygodnia')).toBe('2026-09-04'));
  test('"na początku tygodnia" → następny poniedziałek', () => expect(d('na początku tygodnia')).toBe('2026-09-07'));
  test('"10.09" → konkretna data', () => expect(d('10.09')).toBe('2026-09-10'));
  test('"za miesiąc"', () => expect(d('za miesiąc')).toBe('2026-10-01'));
  test('null / pusty hint → null', () => {
    expect(computeFollowUpDate(null, REF)).toBeNull();
    expect(computeFollowUpDate('', REF)).toBeNull();
  });
});
