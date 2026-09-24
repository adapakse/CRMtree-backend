'use strict';

// Bugfix 23.09 (krok 1 poprawy generatora kandydatów domen).
//
// normalizeName() obcina formę prawną TYLKO na KOŃCU nazwy (kotwica `\s*$`).
// W tych danych forma prawna bardzo często siedzi w ŚRODKU, bo po niej idzie
// opis działalności: "Zimnik sp. z o.o. Kopalnia Granitu". Wtedy tokeny
// 'sp'/'z'/'o' przeżywały filtr i wchodziły do nazwy domeny:
//
//   zimniksp.com.pl  zimnik-sp.com.pl  zimniksp.pl  zimnik-sp.pl
//
// czyli WSZYSCY czterej kandydaci bezużyteczni. Zmierzone na batchu
// workend_ola_9001-10000: 63 firmy z 1096 (5,7%) miały zerową szansę na
// trafienie, niezależnie od tego jak dobrze działa reszta fallbacku.

const svc = require('../services/prospectEnrichmentService');
const { guessFallbackDomains, firstDistinctiveNameToken } = svc;

const hostsOf = (name, exclude = []) =>
  guessFallbackDomains(name, exclude).map(u => u.replace(/^https?:\/\//, ''));
const labelsOf = (name) => hostsOf(name).map(h => h.split('.')[0]);

describe('bugfix — forma prawna w ŚRODKU nazwy nie trafia do kandydatów', () => {
  // Realne nazwy z batcha, wszystkie z potwierdzonym zerowym wynikiem przed poprawką.
  test.each([
    ['Zimnik sp. z o.o. Kopalnia Granitu.', 'zimnik'],
    ['Telkabl sp. z o.o. Usługi Telekomunikacyjne', 'telkabl'],
    ['Tomar sp. z o.o. w Restrukturyzacji', 'tomar'],
    ['Proper sp. z o.o. Ogrzewanie, Klimatyzacja', 'proper'],
    ['Globus sp. z o.o. Biuro Podróży', 'globus'],
  ])('%s — żaden kandydat nie zawiera formy prawnej', (name, brand) => {
    const labels = labelsOf(name);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).not.toMatch(/(^|-)(sp|spzoo|ltd|gmbh|inc|llc)(-|$)/);
      expect(label).not.toMatch(/sp$/);          // forma zwarta: "zimniksp"
    }
    // marka nadal jest podstawą kandydata — nie zgubiliśmy jej przy filtrowaniu
    expect(labels.some(l => l.startsWith(brand))).toBe(true);
  });

  test('REGRESJA: "sp. k." też nie przecieka (zostawiało token "k")', () => {
    for (const label of labelsOf('Epsilon sp.k. Produkcja')) {
      expect(label).not.toMatch(/(^|-)k(-|$)/);
    }
  });

  // ŚWIADOMIE wycinamy FRAZĘ formy prawnej, a nie krótkie tokeny. Pierwsze
  // podejście odfiltrowywało słowa krótsze niż 2 znaki i kosztowało 4
  // potwierdzone domeny, w których jedna litera/cyfra JEST członem marki
  // (l-contact.pl, rytm-l.pl, sectorf.pl, kanal6.pl) — patrz test niżej.
  test.each([
    ['L-contact sp. z o.o.', 'l-contact.pl'],
    ['Rytm-l sp. z o.o.', 'rytm-l.pl'],
    ['Sector F sp. z o.o.', 'sectorf.pl'],
    ['Kanał 6-internet sp. z o.o.', 'kanal6.pl'],
  ])('REGRESJA: %s — jednoznakowy człon marki przeżywa', (name, expectedHost) => {
    expect(hostsOf(name)).toContain(expectedHost);
  });

  // ZNANE OGRANICZENIE, celowo poza zakresem tego bugfixu: wycinamy tylko
  // "sp. z o.o."/"sp. k."/"sp. j.". "S.A." w ŚRODKU nazwy nadal zostawia
  // tokeny 's'/'a' i psuje formę dwusłowną (betas/beta-s zamiast betahandel).
  // Nie ruszamy tego, bo 's' i 'a' bywają realnym członem marki, a w tym
  // zbiorze danych (same sp. z o.o.) przypadek nie wystąpił ani razu.
  test('znane ograniczenie: "S.A." w środku nazwy nadal przecieka', () => {
    expect(labelsOf('Beta S.A. Handel Hurtowy')).toContain('betas');
  });
});

describe('bugfix — granice: nie filtrujemy prawdziwych nazw', () => {
  // ŚWIADOMIE nie ma 'zoo' na liście form prawnych: "z o.o." nigdy nie
  // tokenizuje się do 'zoo' (rozpada się na 'z','o','o'), więc taki filtr
  // trafiałby wyłącznie w prawdziwe nazwy.
  test('REGRESJA: "Zoo Wrocław" zachowuje człon "zoo"', () => {
    expect(labelsOf('Zoo Wrocław sp. z o.o.').some(l => l.startsWith('zoo'))).toBe(true);
    expect(firstDistinctiveNameToken('Zoo Wrocław sp. z o.o.')).toBe('zoo');
  });

  test.each([
    ['Joan Elektronic sp. z o.o.', 'joanelektronic.pl'],
    ['Mw Auto sp. z o.o.', 'mwauto.pl'],
  ])('%s — poprawna domena nadal jest generowana', (name, expectedHost) => {
    expect(hostsOf(name)).toContain(expectedHost);
  });

  // Dwuliterowy człon marki ("Mw Auto") musi przeżyć — próg to >= 2 znaki,
  // nie >= 3 (inaczej zgubilibyśmy mwauto.pl, potwierdzoną domenę).
  test('REGRESJA: dwuliterowy człon marki nie jest odfiltrowany', () => {
    expect(labelsOf('Mw Auto sp. z o.o.')).toContain('mwauto');
  });

  test('nazwa złożona wyłącznie z formy prawnej i generyków nie daje kandydatów', () => {
    expect(guessFallbackDomains('Przedsiębiorstwo Usługowe sp. z o.o.', [])).toEqual([]);
  });
});
