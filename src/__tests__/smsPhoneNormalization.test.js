'use strict';

// Regresja 06.10 — numery stacjonarne zapisane z zerem kierunkowym
// ("041 378 66 05") normalizowały się do "+0413786605", a ip-pbx.eu odrzucał
// je z 400 przy KAŻDYM przebiegu jobu SMS (co 5 minut, w logach produkcji
// m.in. 0998122075, 0146272079, 0856518528). Efekt: leady z takim numerem
// nigdy nie dostawały korespondencji SMS do CRM. Naprawa: 10 cyfr
// zaczynających się od "0" traktujemy jako numer krajowy — odcinamy zero
// i doklejamy "+48".

const { normalizePolishPhone } = require('../services/smsSyncService');

describe('normalizePolishPhone — numery z zerem kierunkowym', () => {
  test('odcina wiodące zero i dokleja +48', () => {
    expect(normalizePolishPhone('041 378 66 05')).toBe('+48413786605');
    expect(normalizePolishPhone('0146272079')).toBe('+48146272079');
    expect(normalizePolishPhone('0856518528')).toBe('+48856518528');
  });

  test('nigdy nie zwraca numeru z zerem zaraz po plusie', () => {
    expect(normalizePolishPhone('0998122075')).not.toMatch(/^\+0/);
  });
});

describe('normalizePolishPhone — formaty działające wcześniej', () => {
  test('zachowuje numer podany z plusem', () => {
    expect(normalizePolishPhone('+48 690 365 095')).toBe('+48690365095');
  });

  test('zamienia prefiks 00 na plus', () => {
    expect(normalizePolishPhone('0048600123456')).toBe('+48600123456');
  });

  test('dokleja +48 do numeru 9-cyfrowego', () => {
    expect(normalizePolishPhone('600452782')).toBe('+48600452782');
    expect(normalizePolishPhone('514-611-514')).toBe('+48514611514');
  });

  test('zachowuje numer z kodem kraju bez plusa', () => {
    expect(normalizePolishPhone('48413517491')).toBe('+48413517491');
  });
});
