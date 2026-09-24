'use strict';

// Domknięcie pokrycia testami (20.09, przed commitem) dla dwóch funkcji
// zaakceptowanych funkcjonalnie, ale bez testu jednostkowego:
//   - isBotChallengePage() — wykrywanie stron-wyzwań anty-bot (case dachcentrum.pl,
//     18.09), żeby tytuł "Proszę czekać…" nie szedł do AI jako treść firmy;
//   - buildLinkAudit() — ETAP 4, pełna ścieżka KAŻDEGO odkrytego linku przez lejek
//     selekcji (score → wybrany? → pobrany? → włączony do tekstu dla AI?).
// Żadna logika produkcyjna nie jest tu zmieniana — obie funkcje są czyste i
// testowalne bez sieci.

const svc = require('../services/prospectEnrichmentService');

describe('isBotChallengePage', () => {
  test('prawdziwa strona-wyzwanie (tytuł "Proszę czekać…" + JS auto-reload) -> true', () => {
    const html = `<html><head><title>Proszę czekać...</title></head><body>
      <script>setTimeout(function() { window.location.reload(); }, 4000);</script>
    </body></html>`;
    expect(svc.isBotChallengePage(html)).toBe(true);
  });

  test('wariant angielski ("Just a moment...") z tym samym skryptem -> true', () => {
    const html = `<html><head><title>Just a moment...</title></head><body>
      <script>setTimeout(function() { window.location.reload(); }, 4000);</script>
    </body></html>`;
    expect(svc.isBotChallengePage(html)).toBe(true);
  });

  test('normalna strona firmowa (zwykły tytuł, zwykły JS) -> false', () => {
    const html = `<html><head><title>Firma XYZ sp. z o.o. — strona główna</title></head><body>
      <script>console.log('analytics loaded');</script>
      <p>Witamy na naszej stronie. Oferujemy usługi B2B.</p>
    </body></html>`;
    expect(svc.isBotChallengePage(html)).toBe(false);
  });

  test('zwykły JS z setTimeout+reload, ale BEZ tytułu-wyzwania -> false (sam reload nie wystarcza)', () => {
    // Np. legalny auto-refresh sesji/koszyka — nie jest to bot-challenge.
    const html = `<html><head><title>Panel klienta — odświeżanie sesji</title></head><body>
      <script>setTimeout(function() { window.location.reload(); }, 300000);</script>
      <p>Twoja sesja zostanie odświeżona automatycznie.</p>
    </body></html>`;
    expect(svc.isBotChallengePage(html)).toBe(false);
  });

  test('tytuł "Proszę czekać" bez skryptu auto-reload -> false (samo hasło w tytule nie wystarcza)', () => {
    const html = `<html><head><title>Proszę czekać — ładowanie wyników</title></head><body>
      <p>Trwa wyszukiwanie ofert.</p>
    </body></html>`;
    expect(svc.isBotChallengePage(html)).toBe(false);
  });

  test('brak HTML -> false', () => {
    expect(svc.isBotChallengePage('')).toBe(false);
    expect(svc.isBotChallengePage(null)).toBe(false);
  });
});

describe('buildLinkAudit — klasyfikacja losu KAŻDEGO odkrytego linku w lejku selekcji', () => {
  function makeState() {
    const allLinks = new Map([
      ['/spam', { path: '/spam', anchor: '', score: 0 }],
      ['/niewybrany', { path: '/niewybrany', anchor: '', score: 5 }],
      ['/blad-pobierania', { path: '/blad-pobierania', anchor: '', score: 8 }],
      ['/wyzwanie', { path: '/wyzwanie', anchor: '', score: 8 }],
      ['/budzet-kategorii', { path: '/budzet-kategorii', anchor: '', score: 9 }],
      ['/limit-globalny', { path: '/limit-globalny', anchor: '', score: 9 }],
      ['/wlaczony', { path: '/wlaczony', anchor: '', score: 10 }],
    ]);
    const level1SelectedPaths = new Set(['/blad-pobierania', '/wyzwanie', '/budzet-kategorii', '/limit-globalny', '/wlaczony']);
    const fetchedPages = [
      { path: '/budzet-kategorii', anchor: '', score: 9, text: 'x'.repeat(50), label: 'x', category: 'oferta' },
      { path: '/limit-globalny', anchor: '', score: 9, text: 'x'.repeat(50), label: 'x', category: 'o_nas_zespol' },
      { path: '/wlaczony', anchor: '', score: 10, text: 'y'.repeat(500), label: 'y', category: 'kontakt_oddzialy' },
    ];
    const diagnostics = [
      { path: '/blad-pobierania', reason: 'fetch_error', extracted_length: 0 },
      { path: '/wyzwanie', reason: 'bot_challenge_suspected', extracted_length: 0 },
    ];
    return { allLinks, level2Links: new Map(), level1SelectedPaths, level2SelectedPaths: new Set(), fetchedPages, diagnostics };
  }

  function makeOutcomes() {
    return new Map([
      ['/budzet-kategorii', { included_chars: 0, reason: 'category_budget_exhausted' }],
      ['/limit-globalny', { included_chars: 0, reason: 'global_12k_truncation' }],
      ['/wlaczony', { included_chars: 500, reason: 'included' }],
    ]);
  }

  function stageOf(audit, path) {
    return audit.find(a => a.path === path)?.stage;
  }

  test('LINK_SCORE_TOO_LOW — link ze score<=0, odfiltrowany przed rankingiem', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    expect(stageOf(audit, '/spam')).toBe('LINK_SCORE_TOO_LOW');
  });

  test('PAGE_NOT_SELECTED — score>0, ale poza top-N obu poziomów', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    expect(stageOf(audit, '/niewybrany')).toBe('PAGE_NOT_SELECTED');
  });

  test('FETCH_FAILED — wybrany, ale pobieranie zwróciło błąd', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    expect(stageOf(audit, '/blad-pobierania')).toBe('FETCH_FAILED');
  });

  test('BOT_CHALLENGE — wybrany, ale diagnostyka oznaczyła stronę jako wyzwanie anty-bot', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    expect(stageOf(audit, '/wyzwanie')).toBe('BOT_CHALLENGE');
  });

  test('CATEGORY_BUDGET_EXHAUSTED — pobrany, ale własna kategoria już wyczerpała rezerwację', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    const entry = audit.find(a => a.path === '/budzet-kategorii');
    expect(entry.stage).toBe('CATEGORY_BUDGET_EXHAUSTED');
    expect(entry.included_chars).toBe(0);
  });

  test('GLOBAL_12K_TRUNCATION — pobrany, kategoria miała miejsce, ale globalny limit się skończył', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    const entry = audit.find(a => a.path === '/limit-globalny');
    expect(entry.stage).toBe('GLOBAL_12K_TRUNCATION');
    expect(entry.included_chars).toBe(0);
  });

  test('EVIDENCE_REACHED_AI — pobrany i faktycznie włączony do tekstu wysłanego do AI', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    const entry = audit.find(a => a.path === '/wlaczony');
    expect(entry.stage).toBe('EVIDENCE_REACHED_AI');
    expect(entry.included_chars).toBe(500);
    expect(entry.category).toBe('kontakt_oddzialy');
  });

  test('audit jest posortowany malejąco po score', () => {
    const audit = svc.buildLinkAudit(makeState(), makeOutcomes());
    const scores = audit.map(a => a.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
