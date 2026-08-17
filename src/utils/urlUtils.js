'use strict';

/**
 * Normalizuje adres URL strony WWW wpisany przez użytkownika (import CSV, reprocess, ręczne pole).
 *
 * Obsługuje warianty:
 *   https://www.firma.pl     → https://www.firma.pl
 *   http://www.firma.pl      → https://www.firma.pl
 *   htts://www.firma.pl      → https://www.firma.pl  (literówka w protokole)
 *   htps://www.firma.pl      → https://www.firma.pl  (literówka)
 *   htp://www.firma.pl       → https://www.firma.pl  (literówka)
 *   https://www.firma.pl/    → https://www.firma.pl  (trailing slash)
 *   https//www.firma.pl      → https://www.firma.pl  (brak :)
 *   https:/www.firma.pl      → https://www.firma.pl  (jeden slash)
 *   http: //www.firma.pl     → https://www.firma.pl  (spacja)
 *   https:www.firma.pl       → https://www.firma.pl  (brak slashy)
 *   www.firma.pl             → https://www.firma.pl
 *   firma.pl                 → https://firma.pl
 *   ""  / null / undefined   → null
 *
 * Strategia: wyciągnij czystą część domenową (+ opcjonalna ścieżka), dołącz https://.
 * Nie walidujemy czy domena istnieje — to zadanie scrappera.
 */
function normalizeWebsiteUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim();

  // Usuń cudzysłowy (CSV może zawierać "https://...")
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();

  if (!s) return null;

  // ── Krok 1: Wyciągnij część po protokole ───────────────────────────
  // Obsługa:
  //   cokolwiek://reszta  → bierz resztę po OSTATNIM '://'
  //   cokolwiek:reszta    → bierz resztę po ':'
  //   cokolwiek/reszta    → bierz resztę po znakach przed '/'
  //   protokół z spacją   → 'http: //www...' → znormalizuj

  // Usuń spacje wewnętrzne (rzadkie, ale zdarzają się: 'http: //...' lub 'https :// ...')
  // TYLKO w obrębie potencjalnego prefiksu — do pierwszej prawdziwej litery domeny
  // Heurystyka: jeśli pierwsze 12 znaków zawiera '://', usuń spacje w tym fragmencie
  if (/^.{1,12}\s+/.test(s) && s.includes('://')) {
    s = s.replace(/^([^\s.]{1,10})\s+/, '$1');
  }

  if (s.includes('://')) {
    // Weź wszystko po OSTATNIM '://' — eliminuje podwójne prefiksy: 'https://https://...'
    // i literówkowe: 'htts://...' → 'www...'
    const afterProtocol = s.substring(s.lastIndexOf('://') + 3).trim();
    if (afterProtocol && afterProtocol.includes('.')) {
      s = afterProtocol;
    } else {
      // Nic sensownego po '://' — próbuj alternatywne podejście poniżej
      s = raw.trim();
    }
  }

  // Krok 2: Jeśli nadal wygląda jak błędny prefix (bez '://'), usuń go
  // Wzorzec: ciąg liter a-z (2-8 znaków, żeby nie wyciąć 'www') + dowolna kombinacja [:/\s]
  // Ale TYLKO jeśli po usunięciu zostaje coś z kropką (domena)
  if (!s.includes('://')) {
    const afterStrip = s.replace(/^[a-z]{2,8}\s*[:\/\s]+/i, '');
    if (afterStrip && afterStrip.includes('.') && afterStrip !== s) {
      // Sprawdź że nie usunęliśmy samego 'www' — 'www.firma.pl' → 'firma.pl' (za dużo!)
      // Klucz: nie stripuj jeśli pierwsze słowo to 'www' lub 'ftp'
      if (!/^(www|ftp)\./i.test(s)) {
        s = afterStrip;
      }
    }
  }

  // Krok 3: Usuń leading slashes
  s = s.replace(/^\/+/, '').trim();

  // Krok 4: Usuń trailing slashes (zachowaj ścieżkę jeśli jest)
  s = s.replace(/\/+$/, '');

  // Krok 5: Sanity check — musi mieć kropkę (minimalna struktura domeny)
  if (!s || !s.includes('.')) return null;

  // Krok 6: Scal z https://
  return `https://${s}`;
}

/**
 * Normalizuje adres strony firmy na LinkedIn do formatu kanonicznego:
 *   https://www.linkedin.com/company/SLUG
 *
 * Obsługuje warianty wejściowe:
 *   https://www.linkedin.com/company/orbify/         → https://www.linkedin.com/company/orbify
 *   https://linkedin.com/company/orbify/about        → https://www.linkedin.com/company/orbify
 *   www.linkedin.com/company/orbify                  → https://www.linkedin.com/company/orbify
 *   linkedin.com/company/orbify                      → https://www.linkedin.com/company/orbify
 *   https://www.linkedin.com/in/johndoe              → null (profil osoby — nie firma)
 *   cokolwiek innego                                  → null
 *
 * Zwraca null gdy URL nie wskazuje na stronę firmy (/company/).
 */
function normalizeLinkedinUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return null;

  // Wyciągnij ścieżkę z dowolnego formatu URL
  let path = s;
  if (s.includes('://')) {
    path = s.substring(s.lastIndexOf('://') + 3);
  }
  // Usuń hostname (linkedin.com lub www.linkedin.com)
  path = path.replace(/^(www\.)?linkedin\.com/i, '');
  // Trailing slashes — usuń i podziel na segmenty
  path = path.replace(/\/+$/, '');

  // Wymagamy /company/SLUG — profil osoby (/in/) i inne odrzucamy
  const m = path.match(/^\/company\/([a-z0-9_-]+)/i);
  if (!m) return null;

  const slug = m[1].toLowerCase();
  if (!slug) return null;

  return `https://www.linkedin.com/company/${slug}`;
}

module.exports = { normalizeWebsiteUrl, normalizeLinkedinUrl };
