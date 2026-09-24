'use strict';

// Regresja 21.09 — bug "Wielkość" → company_size: findColumnKey() nie usuwał
// polskiej diakrytyki, więc nagłówek "Wielkość" (po normalizacji: "wielkość")
// nigdy nie dopasowywał się do kandydata "wielkosc" (ASCII) — sizeKey wychodził
// zawsze null, company_size nigdy się nie zapisywał mimo poprawnie wypełnionej
// kolumny w pliku źródłowym. Naprawa: deaccentHeader() (NFD + usunięcie
// combining marks + jawna podmiana "ł"/"Ł", bo ta litera nie dekomponuje się
// w NFD) wołane PRZED resztą normalizacji, zarówno dla kandydatów jak i
// nagłówków z pliku.

const { findColumnKey, deaccentHeader } = require('../routes/admin-prospects');

describe('deaccentHeader — usuwanie polskiej diakrytyki', () => {
  test.each([
    'Wielkość', 'Branża', 'Średnia', 'Zatrudnienie', 'Łączność', 'Województwo',
  ])('%s -> wynik nie zawiera już żadnego znaku diakrytycznego', (input) => {
    expect(deaccentHeader(input)).not.toMatch(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/);
  });

  test('"ł"/"Ł" — NIE dekomponują się w Unicode NFD, wymagają jawnej podmiany przed normalizacją', () => {
    // Sam NFD + strip combining marks (bez jawnej podmiany ł/Ł) zostawiłby "ł" nietknięte —
    // to właśnie ta luka pozwalała firmom z "ł" w nagłówku (np. "Wielkość") przejść
    // NFD i wciąż nie dopasować się do kandydata bez diakrytyki.
    expect(deaccentHeader('Łączność').toLowerCase()).toBe('lacznosc');
  });

  test.each([
    ['Wielkość', 'wielkosc'],
    ['Branża', 'branza'],
    ['Średnia', 'srednia'],
    ['Województwo', 'wojewodztwo'],
    ['Komórka', 'komorka'],
  ])('%s -> lowercase deaccent = %s', (input, expected) => {
    expect(deaccentHeader(input).toLowerCase()).toBe(expected);
  });
});

describe('findColumnKey — dopasowuje nagłówki CSV z polską diakrytyką (regresja "Wielkość")', () => {
  const realHeaders = [
    'BAZA', 'Nazwa', 'NIP', 'WWW', 'Zatrudnienie', 'obrot', 'Rok', 'Forma prawna',
    'Wielkość', 'Branża', 'Profil', 'Osoba Decyzyjna', 'Stanowisko', 'Komórka',
    'Telefon', 'Email', 'Adres', 'Kod Pocztowy', 'Miasto', 'Województwo',
    'PKD-ID', 'PKD-opis',
  ];

  test('sizeKey: "Wielkość" jest znajdowane przez kandydata "wielkosc" (przed poprawką: null)', () => {
    const key = findColumnKey(realHeaders, ['wielkosc', 'size', 'rozmiar', 'kategoriarozmiaru', 'wielkoscfirmy']);
    expect(key).toBe('Wielkość');
  });

  test('industryKey: "Branża" jest znajdowane przez kandydata "branza"', () => {
    const key = findColumnKey(realHeaders, ['branza', 'industry', 'sektor', 'sector', 'branzafirmy']);
    expect(key).toBe('Branża');
  });

  test('voivodeshipKey: "Województwo" jest znajdowane przez kandydata "wojewodztwo"', () => {
    const key = findColumnKey(realHeaders, ['wojewodztwo', 'voivodeship', 'region', 'woj']);
    expect(key).toBe('Województwo');
  });

  test('dmDeptKey: "Komórka" jest znajdowane przez kandydata "komorka"', () => {
    const key = findColumnKey(realHeaders, ['komorka', 'department', 'dzial', 'jednostka', 'oddzial']);
    expect(key).toBe('Komórka');
  });

  test('employmentKey: "Zatrudnienie" nadal działa (bez diakrytyki, kontrola że nic się nie zepsuło)', () => {
    const key = findColumnKey(realHeaders, ['zatrudnienie', 'employment', 'pracownicy', 'employees']);
    expect(key).toBe('Zatrudnienie');
  });

  test('nadal odporne na spacje/podkreślenia/myślniki (dotychczasowa normalizacja nie regresuje)', () => {
    expect(findColumnKey(['Kod Pocztowy'], ['kodpocztowy'])).toBe('Kod Pocztowy');
    expect(findColumnKey(['pkd-id'], ['pkdid'])).toBe('pkd-id');
    expect(findColumnKey(['website_url'], ['websiteurl'])).toBe('website_url');
  });

  test('brak dopasowania zwraca null (nie rzuca, nie dopasowuje przypadkowo)', () => {
    expect(findColumnKey(realHeaders, ['nieistniejącakolumna'])).toBeNull();
  });
});
