'use strict';

// Targeted test etapu 2 (23.09) — fallback dla MARTWEJ domeny z importu.
//
// Problem z audytu 47 firm bez `done`: gdy fast scan kończył się
// deterministicFailure (TLS/DNS/parking), enrichOne od razu ustawiał
// `no_website` i NIE próbował znaleźć innej domeny. Wszystkie 10 firm
// `no_website` miało `fallback: BRAK`, mimo że dla 3 z nich istniała żywa
// domena (artmed.pl, joanelektronic.pl, airtificial.com).
//
// Ten test pilnuje DWÓCH rzeczy naraz:
//   1. martwa domena uruchamia resolver (recall),
//   2. identity NIE jest osłabione — domena z fallbacku wchodzi tylko przy
//      verified:true, a konflikt tożsamości nadal blokuje (accuracy).

const svc = require('../services/prospectEnrichmentService');
const { guessFallbackDomains, checkDomainIdentity } = svc;

describe('etap 2 — generowanie kandydatów dla martwych domen', () => {
  // Realne przypadki z audytu: dla tych firm istnieje żywa domena, której
  // stary kod nigdy nie próbował, bo URL z importu był martwy.
  test.each([
    ['Artmed sp. z o.o.', 'artmed.pl'],
    ['Joan Elektronic sp. z o.o.', 'joanelektronic.pl'],
  ])('dla "%s" generuje kandydata zawierającego %s', (name, expectedHost) => {
    const candidates = guessFallbackDomains(name, ['http://www.rynekmedyczny.pl']);
    const hosts = candidates.map(u => u.replace(/^https?:\/\//, ''));
    expect(hosts).toContain(expectedHost);
  });

  test('wyklucza domenę już odrzuconą (nie próbuje ponownie tego samego hosta)', () => {
    const candidates = guessFallbackDomains('Artmed sp. z o.o.', ['https://artmed.pl']);
    const hosts = candidates.map(u => u.replace(/^https?:\/\//, ''));
    expect(hosts).not.toContain('artmed.pl');
  });

  test('dla nazwy złożonej z samych słów generycznych nie generuje nic', () => {
    expect(guessFallbackDomains('Przedsiębiorstwo Usługowe sp. z o.o.', [])).toEqual([]);
  });
});

describe('etap 2 — identity NIE jest osłabione', () => {
  const COMPANY = { company_name: 'Artmed sp. z o.o.', nip: '5252248481' };

  test('domena bez żadnego dowodu tożsamości pozostaje niezweryfikowana', () => {
    const res = checkDomainIdentity({
      nip: COMPANY.nip,
      text: 'Witamy na stronie. Oferujemy produkty i usługi dla firm.',
      title: 'Strona główna',
      company: COMPANY, krsData: null, gusData: null,
    });
    expect(res.verified).toBe(false);
  });

  test('zgodny NIP na stronie daje weryfikację (ścieżka pozytywna bez zmian)', () => {
    const res = checkDomainIdentity({
      nip: COMPANY.nip,
      text: 'Artmed sp. z o.o., NIP 5252248481, Warszawa.',
      title: 'Artmed',
      company: COMPANY, krsData: null, gusData: null,
    });
    expect(res.verified).toBe(true);
  });

  // KLUCZOWY WARUNEK ZADANIA: zwiększamy recall strony, ale nie kosztem
  // identity accuracy — twardy konflikt musi nadal blokować.
  test('REGRESJA: cudzy NIP na stronie NIE daje weryfikacji', () => {
    const res = checkDomainIdentity({
      nip: COMPANY.nip,
      text: 'Inna Firma sp. z o.o., NIP 9999999999, Kraków.',
      title: 'Inna Firma',
      company: COMPANY, krsData: null, gusData: null,
    });
    expect(res.verified).toBe(false);
  });
});

describe('etap 2 — kontrakt fallbacku w enrichOne', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'prospectEnrichmentService.js'), 'utf8');

  test('gałąź deterministicFailure wywołuje resolveDomainFallback', () => {
    const branch = SRC.slice(SRC.indexOf('if (fastScraped.deterministicFailure) {'));
    const head = branch.slice(0, branch.indexOf('} else if (identityCheck.verified'));
    expect(head).toMatch(/resolveDomainFallback\(\{/);
    expect(head).toMatch(/dead_domain_fallback/);
  });

  test('fallback NIE uruchamia się dla domeny zatwierdzonej ręcznie (trustedByHuman)', () => {
    const branch = SRC.slice(SRC.indexOf('if (fastScraped.deterministicFailure) {'));
    const head = branch.slice(0, branch.indexOf('} else if (identityCheck.verified'));
    expect(head).toMatch(/if \(!trustedByHuman\) \{[\s\S]*resolveDomainFallback/);
  });

  test('po udanym fallbacku rekord nie może zostać oznaczony jako no_website', () => {
    expect(SRC).toMatch(/const deadDomainReplaced = !!enrichLog\.website\?\.dead_domain_fallback\?\.found_url;/);
    expect(SRC).toMatch(/!trustedByHuman && !deadDomainReplaced\s*\n\s*&& isConfirmedDeadDomain/);
  });

  test('domena z fallbacku przechodzi pełny identity check (computeIdentityCheck)', () => {
    const branch = SRC.slice(SRC.indexOf('Dead imported domain — fallback found a verified alternate'));
    const head = branch.slice(0, 900);
    expect(head).toMatch(/identityCheck = computeIdentityCheck\(scraped\)/);
  });
});
