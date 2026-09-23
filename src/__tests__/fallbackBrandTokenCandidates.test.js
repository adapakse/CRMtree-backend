'use strict';

// Krok 2 poprawy generatora kandydatów domen (23.09) — wariant "H".
//
// Generator próbował dotąd WYŁĄCZNIE form z dwóch pierwszych znaczących słów
// nazwy. Prawdziwa domena bywa krótszą marką niż nazwa prawna — przypadek
// źródłowy: "Airtificial Intelligent Robots Poland" ma stronę pod
// airtificial.com, a generator próbował tylko airtificial-intelligent.*.
//
// Kolejność (zmierzona na 203 firmach z POTWIERDZONĄ domeną z batcha
// workend_ola_9001-10000):
//   1. marka × .pl   2. formy dwusłowne × .pl
//   3. marka × .com.pl/.com   4. formy dwusłowne × .com.pl/.com
//
// Bilans: 104/203 → 119/203 przy limicie 6 kandydatów. Limit 8 dałby 123/203,
// ale wymagałby podniesienia budżetu czasowego — świadomie odrzucone.

const svc = require('../services/prospectEnrichmentService');
const { guessFallbackDomains } = svc;

const hostsOf = (name, exclude = []) =>
  guessFallbackDomains(name, exclude).map(u => u.replace(/^https?:\/\//, ''));

describe('krok 2 — token marki trafia do kandydatów', () => {
  // PRZYPADEK ŹRÓDŁOWY. airtificial.com istnieje (HTTP 200, 56 kB) i przed
  // zmianą nie był próbowany ani razu.
  test('REGRESJA Airtificial: sam token marki, i to we WSZYSTKICH trzech TLD', () => {
    const hosts = hostsOf('Airtificial Intelligent Robots Poland sp. z o.o.');
    expect(hosts).toContain('airtificial.pl');
    expect(hosts).toContain('airtificial.com.pl');
    expect(hosts).toContain('airtificial.com');
  });

  test.each([
    ['Zimnik sp. z o.o. Kopalnia Granitu', 'zimnik.pl'],
    ['Metabo Polska. sp. z o.o. Elektronarzędzia', 'metabo.com'],
    ['Arpol Systemy Alarmowe sp. z o.o.', 'arpol.pl'],
    ['Wojmar Automatyka Przemysłowa sp. z o.o.', 'wojmar.pl'],
  ])('%s → %s', (name, expectedHost) => {
    expect(hostsOf(name)).toContain(expectedHost);
  });

  // 53 nazwy w batchu mają markę w cudzysłowie; w 30 pierwszy znaczący człon
  // to sam opis działalności i marka była nieosiągalna.
  test('marka w cudzysłowie ma PIERWSZEŃSTWO przed opisem działalności', () => {
    const hosts = hostsOf('Fabryka Przetworów Rybnych "mieszko" sp. z o.o.');
    expect(hosts[0]).toBe('mieszko.pl');
    expect(hosts).toContain('mieszko.com.pl');
  });

  test('marka z cudzysłowu działa też gdy opis jest wielowyrazowy', () => {
    expect(hostsOf('Przedsiębiorstwo Budowy Dróg "bitum" sp. z o.o.')).toContain('bitum.pl');
  });
});

describe('krok 2 — granice zakresu', () => {
  // Krótki token zbyt łatwo trafia w cudzą domenę (mar.pl, hg.pl), a każdy
  // kandydat kosztuje request — stąd próg 4 znaków na POJEDYNCZY token.
  test('token krótszy niż 4 znaki nie jest dokładany osobno', () => {
    const hosts = hostsOf('Mw Auto sp. z o.o.');
    expect(hosts).not.toContain('mw.pl');
    expect(hosts).toContain('mwauto.pl');       // forma dwusłowna bez zmian
  });

  test('skrót w cudzysłowie krótszy niż 4 znaki jest pomijany', () => {
    expect(hostsOf('Biuro Rachunkowe "k&w" sp. z o.o.')).not.toContain('kw.pl');
  });

  test('nazwa jednoczłonowa nie generuje duplikatu marki', () => {
    const hosts = hostsOf('Telkabl sp. z o.o.');
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  test('limit kandydatów to 6 — nie więcej', () => {
    for (const name of ['Airtificial Intelligent Robots Poland sp. z o.o.',
      'Fabryka Przetworów Rybnych "mieszko" sp. z o.o.',
      'Zimnik sp. z o.o. Kopalnia Granitu']) {
      expect(hostsOf(name).length).toBeLessThanOrEqual(6);
    }
  });

  test('odrzucona domena nadal jest wykluczana', () => {
    expect(hostsOf('Airtificial Intelligent Robots Poland sp. z o.o.', ['https://airtificial.pl']))
      .not.toContain('airtificial.pl');
  });
});

describe('krok 2 — nie gubimy tego, co działało', () => {
  // Case z 21.08: poprawna domena to forma Z MYŚLNIKIEM, która przy formie
  // jako pętli ZEWNĘTRZNEJ nigdy nie docierała do dalszych TLD. Dlatego w
  // krokach 2 i 4 obie formy idą razem, a TLD jest pętlą zewnętrzną.
  test('REGRESJA Star-Dust: forma z myślnikiem nadal w kandydatach', () => {
    expect(hostsOf('Star - Dust sp. z o.o.')).toContain('star-dust.pl');
  });

  test.each([
    ['Joan Elektronic sp. z o.o.', 'joanelektronic.pl'],
    ['Mw Auto sp. z o.o.', 'mwauto.pl'],
    ['L-contact sp. z o.o.', 'l-contact.pl'],
  ])('%s → %s (potwierdzona domena) nadal generowana', (name, expectedHost) => {
    expect(hostsOf(name)).toContain(expectedHost);
  });

  // Świadomie zaakceptowana strata limitu 6: dwuczłonowe z myślnikiem na
  // .com.pl wypadają poza limit. Trzy takie przypadki na 203 firmy — bilans
  // i tak wynosi +15 netto. Test pilnuje, żeby to pozostało ŚWIADOMĄ decyzją,
  // a nie cichą regresją: forma jest generowana, tylko na .pl zamiast .com.pl.
  test('znana strata: hyphenated+.com.pl wypada poza limit, ale forma istnieje', () => {
    const hosts = hostsOf('Chiorino Świdnica sp. z o.o.');
    expect(hosts).not.toContain('chiorino-swidnica.com.pl');
    expect(hosts).toContain('chiorino-swidnica.pl');
  });
});
