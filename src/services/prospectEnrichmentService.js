'use strict';
// ─────────────────────────────────────────────────────────────────
// services/prospectEnrichmentService.js
//
// Pipeline:
//   1. KRS API (ms.gov.pl) — dane rejestrowe, oddziały, URL strony
//   2. Strona WWW firmy    — scraping podstron, ekstrakcja tekstu
//   3. AI (DeepSeek lub Anthropic) — analiza kontekstowa → sygnały + score
//
// Env vars:
//   DEEPSEEK_API_KEY  — klucz API DeepSeek (provider: deepseek)
//   ANTHROPIC_API_KEY — klucz API Anthropic Claude (provider: anthropic)
//   SERPER_API_KEY    — opcjonalny (Google search, gdy KRS nie ma URL strony)
//
// Wybór providera: app_settings.key = 'prospect.ai_provider'
//   'deepseek'   → DeepSeek Chat (domyślny, tańszy)
//   'anthropic'  → Claude Haiku 4.5 (wyższa jakość)
// ─────────────────────────────────────────────────────────────────

const axios      = require('axios');
const cheerio    = require('cheerio');
const db         = require('../config/database');
const logger     = require('../utils/logger');
const gusRegon   = require('./gusRegonService');
const { normalizeWebsiteUrl, normalizeLinkedinUrl } = require('../utils/urlUtils');

const KRS_BASE        = 'https://api-krs.ms.gov.pl/api/krs';
const DEEPSEEK_API    = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL  = 'deepseek-chat';
const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Słowa kluczowe w URLach i anchor textach — wagi wg trafności dla naszych celów
const LINK_SCORES = [
  // Kontakty i zespół — najważniejsze dla person enrichmentu
  { pattern: /zespol|team|zarzad|management|ludzie|people|staff|pracownicy|dyrekcja|board|kierownictwo/i, score: 10 },
  { pattern: /kontakt|contact/i, score: 9 },
  // Handlowcy / przedstawiciele handlowi / opiekunowie regionalni — sygnał field_sales + key contacts
  // Przykład: /kontakt/handlowcy/, /przedstawiciele-regionalni/, /dzial-handlowy/
  { pattern: /handlowc[yi]|handlow[yi]c|dzial.handlow|siec.handlow|przedstawiciel|sprzedaz.regionalna|sales.rep|account.manager|opiekun.klienta|opiekun.region|regionaln[yi].opiek/i, score: 9 },
  // Serwis techniczny w terenie / serwisanci — sygnał field_service + key contacts
  { pattern: /serwisanc|serwis.techniczny|serwis.terenowy|ekipa.serwis|technicy.terenow/i, score: 8 },
  // Firma, opis działalności — "poznaj nas" też tutaj (Medicover, Luxmed)
  { pattern: /o.nas|o.firmie|about|historia|kim.jestesmy|who.we.are|przedstawiamy|poznaj/i, score: 8 },
  // Usługi — sygnał podróży
  { pattern: /uslugi|usługi|services|oferta|rozwiazania|solutions|produkty|products/i, score: 7 },
  // Oddziały i lokalizacje — klasyczne i healthcare-specific
  { pattern: /oddzialy|oddziały|lokalizacje|locations|biura|offices|gdzie.jestesmy|placowk|placówk|klinik|centra|przychodn|apteki|salon[yi]|punkt.obs/i, score: 9 },
  // Wyszukiwarki lokalizacji ("Znajdź placówkę", "Wyszukaj centrum") — silny sygnał wielu lokalizacji
  { pattern: /znajdz|wyszukaj/i, score: 7 },
  // Kariera — ogłoszenia o pracę
  { pattern: /kariera|praca|jobs|careers|rekrutacja|dolacz|join/i, score: 6 },
];

// ── Helpers ────────────────────────────────────────────────────────

function normalizeNip(nip) {
  return String(nip || '').replace(/\D/g, '');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// KRS zwraca daty w formacie DD.MM.YYYY — konwertuje na ISO YYYY-MM-DD dla PostgreSQL
function parseKrsDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return dateStr;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// PKD → bonus — branże bezwzględnie o wysokim wskaźniku podróży
const GUS_PKD_ALWAYS = [
  { prefix: '79', bonus: 15 },  // biura podróży, organizatorzy wycieczek
  { prefix: '49', bonus: 10 },  // transport lądowy
  { prefix: '28', bonus: 8  },  // produkcja maszyn — serwis terenowy
  { prefix: '33', bonus: 8  },  // naprawa i instalacja maszyn
];

// PKD → bonus — tylko gdy firma ma > 1 oddział (sieci spółek tech/usługowych)
const GUS_PKD_WITH_BRANCHES = [
  { prefix: '62', bonus: 6 },  // spółki technologiczne (IT, programowanie)
  { prefix: '63', bonus: 5 },  // usługi informacyjne / tech
  { prefix: '70', bonus: 5 },  // doradztwo zarządcze — inne usługi
  { prefix: '71', bonus: 5 },  // architektura i inżynieria — inne usługi
  { prefix: '72', bonus: 4 },  // badania naukowe — inne usługi
  { prefix: '73', bonus: 4 },  // reklama i badania rynku — inne usługi
  { prefix: '74', bonus: 4 },  // inne usługi zawodowe
];

function calcGusBonus(pkdCodes, branchesCount) {
  if (!Array.isArray(pkdCodes) || !pkdCodes.length) return 0;
  let maxBonus = 0;
  for (const entry of pkdCodes) {
    const raw = typeof entry === 'string' ? entry : (entry.kod || '');
    const prefix = raw.replace(/\./g, '').slice(0, 2);
    const hit = GUS_PKD_ALWAYS.find(p => p.prefix === prefix);
    if (hit && hit.bonus > maxBonus) maxBonus = hit.bonus;
    if (branchesCount != null && branchesCount > 1) {
      const hit2 = GUS_PKD_WITH_BRANCHES.find(p => p.prefix === prefix);
      if (hit2 && hit2.bonus > maxBonus) maxBonus = hit2.bonus;
    }
  }
  return maxBonus;
}

// Kalkuluje travel_potential_score wg deterministycznej formuły z promptu.
// Nie ufamy score'owi zwróconemu przez AI — liczymy sami na podstawie sygnałów.
function calcTravelScore(signals, branchesCount, travelScope, hasWebsite, hasKrs, gusData) {
  const SIGNAL_KEYS = ['field_sales','branches','international','implementations','field_service','b2b_sales','travel_manager'];
  const activeCount = SIGNAL_KEYS.filter(k => signals?.[k] === true).length;

  const BASE = [15, 30, 40, 50, 60, 70, 80, 90];
  let score = BASE[activeCount] ?? 15;

  // Korekta za skalę oddziałów
  if (signals?.branches === true && branchesCount != null) {
    if (branchesCount >= 50)      score += 25;
    else if (branchesCount >= 10) score += 15;
    else if (branchesCount >= 2)  score += 8;
  }

  // Korekta za zasięg
  if (travelScope === 'global')   score += 10;
  else if (travelScope === 'eu')  score += 7;
  else if (travelScope === 'national') score += 5;

  // Korekta za branżę (GUS PKD) — tylko gdy AI znalazło < 3 sygnałów
  if (gusData?.pkdCodes) {
    const pkdBonus = calcGusBonus(gusData.pkdCodes, branchesCount);
    if (pkdBonus > 0 && activeCount < 3) {
      score += pkdBonus;
    }
  }

  // Korekta ujemna — brak danych
  if (!hasWebsite && !hasKrs) score -= 10;

  return Math.min(100, Math.max(5, score));
}

// ── 1. KRS API ─────────────────────────────────────────────────────

async function fetchKRS(nip, krsNumberHint) {
  const n = normalizeNip(nip);
  if (!n || n.length !== 10) return null;

  // Jeśli mamy numer KRS (z importu CSV), użyj działającego endpointu bezpośrednio
  // Próbuj rejestr=P (Przedsiębiorcy), potem rejestr=S (Stowarzyszenia/fundacje/spółdzielnie)
  const krsNumer = krsNumberHint || await findKrsNumberByNip(n);
  if (krsNumer) {
    for (const rejestr of ['P', 'S']) {
      const url = `${KRS_BASE}/OdpisAktualny/${krsNumer}?rejestr=${rejestr}&format=json`;
      try {
        const { data, status: httpStatus } = await axios.get(url, {
          timeout: 10_000,
          headers: { Accept: 'application/json', 'User-Agent': 'WorktripsPlatform/1.0' },
        });
        const result = parseKRS(data);
        if (result) {
          logger.info('[Prospect] KRS found', { nip: n, krsNumer, rejestr, source: krsNumberHint ? 'csv_import' : 'lookup' });
          return result;
        }
        // Odpowiedź przyszła (2xx) ale parseKRS nie rozpoznał struktury — loguj co przyszło
        const root = Array.isArray(data) ? data[0] : data;
        logger.warn('[Prospect] KRS response unparseable', {
          nip: n, krsNumer, rejestr, httpStatus,
          data_type: typeof data,
          is_array: Array.isArray(data),
          root_keys: Object.keys(root || {}),
          odpis_keys: root?.odpis ? Object.keys(root.odpis) : null,
          dane_keys:  root?.odpis?.dane  ? Object.keys(root.odpis.dane)  : null,
          dzial1_present: !!root?.odpis?.dane?.dzial1,
          raw_preview: JSON.stringify(data)?.slice(0, 300),
        });
      } catch (err) {
        const status = err.response?.status;
        const responsePreview = JSON.stringify(err.response?.data)?.slice(0, 200);
        if (status === 404) {
          logger.debug('[Prospect] KRS 404', { nip: n, krsNumer, rejestr });
          continue; // spróbuj kolejny rejestr
        }
        logger.warn('[Prospect] KRS fetch error', { nip: n, krsNumer, rejestr, status, error: err.message, responsePreview });
        break;
      }
    }
  }

  // Fallback: stary endpoint podmiot?nip= (zwraca 400 od 2026-07, zostawiamy na wypadek naprawy przez MS)
  for (const url of [
    `${KRS_BASE}/OdpisAktualny/podmiot?nip=${n}&rejestr=P&format=json`,
    `${KRS_BASE}/OdpisAktualny/podmiot?nip=${n}&format=json`,
  ]) {
    try {
      const { data } = await axios.get(url, {
        timeout: 10_000,
        headers: { Accept: 'application/json', 'User-Agent': 'WorktripsPlatform/1.0' },
      });
      const result = parseKRS(data);
      if (result) {
        logger.info('[Prospect] KRS found via legacy NIP endpoint', { nip: n });
        return result;
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) continue;
      if (status === 400) {
        logger.debug('[Prospect] KRS legacy NIP endpoint zwraca 400 (znany błąd MS)', { nip: n });
        break;
      }
      logger.warn('[Prospect] KRS legacy request error', { nip: n, status, error: err.message });
    }
  }

  logger.info('[Prospect] KRS not found for NIP', { nip: n });
  return null;
}

// Szuka numeru KRS dla podanego NIP.
//
// ZNANY PROBLEM (stan 2026-07):
//   api-krs.ms.gov.pl/OdpisAktualny/podmiot?nip=... zwraca 400 Bad Request dla każdego NIP.
//   Endpoint jest zepsuty po stronie Ministerstwa Sprawiedliwości.
//   Workaround: jeśli prospect ma pole krs_number uzupełnione ręcznie, fetchKRS użyje go bezpośrednio.
//   W przeciwnym razie wzbogacanie odbywa się bez danych KRS (tylko strona WWW + Claude).
//
// Aby ręcznie podać numer KRS: w tabeli prospect_companies dodaj kolumnę krs_number_override
// i uzupełnij go przy imporcie CSV — fetchKRS sprawdza to pole przed NIP-based lookup.
async function findKrsNumberByNip(nip) {
  // Placeholder — żadna z publicznych metod lookup NIP→KRS nie działa bez API key (GUS BIR wymaga SOAP+klucz)
  logger.debug('[Prospect] findKrsNumberByNip: brak działającego NIP→KRS lookup (patrz komentarz)', { nip });
  return null;
}

function parseKRS(data) {
  try {
    // KRS API może zwrócić pojedynczy obiekt LUB tablicę
    const root    = Array.isArray(data) ? data[0] : data;
    const odpis   = root?.odpis;
    const naglowek = odpis?.naglowekA;   // numerKRS i data rejestracji przeniesione do nagłówka
    const dane    = odpis?.dane;
    const dzial1  = dane?.dzial1;        // nowa struktura — wszystko zagnieżdżone w dzial1

    if (!dzial1 && !dane) {
      logger.debug('[Prospect] KRS parse — brak dane/dzial1', {
        is_array: Array.isArray(data),
        root_keys: Object.keys(root || {}),
        odpis_keys: odpis ? Object.keys(odpis) : null,
      });
      return null;
    }

    // ── Nowa struktura API (od ~2025) ────────────────────────────────
    if (dzial1) {
      const danePodmiotu  = dzial1.danePodmiotu  || {};
      const siedzibaIAdres = dzial1.siedzibaIAdres || {};
      const adres         = siedzibaIAdres.adres  || {};

      const legalForm = danePodmiotu.formaPrawna || null;

      const registeredAddress = [adres.ulica, adres.nrDomu, adres.miejscowosc, adres.kodPocztowy]
        .filter(Boolean).join(', ') || null;

      // numerKRS i data rejestracji przeniesione do naglowekA
      const krsNumber       = naglowek?.numerKRS || null;
      const registrationDate = naglowek?.dataRejestracjiWKRS || null;

      // URL strony WWW przeniesiony do siedzibaIAdres
      const krsWebsite = siedzibaIAdres.adresStronyInternetowej || null;

      // Oddziały: jednostkiTerenoweOddzialy (zmieniona nazwa z oddzialySpolki/jednostkiTerenowe)
      const branchList = Array.isArray(dzial1.jednostkiTerenoweOddzialy)
        ? dzial1.jednostkiTerenoweOddzialy
        : [];
      const branchesCount = branchList.length;
      const hasEU = branchList.some(b =>
        b?.siedziba?.kraj && b.siedziba.kraj.toLowerCase() !== 'polska'
      );
      const branchesScope = branchesCount > 0 && hasEU ? 'eu' : 'pl';

      const companyName = danePodmiotu.nazwa || danePodmiotu.nazwaSkrocona || null;

      return { krsNumber, legalForm, registeredAddress, registrationDate, krsWebsite, branchesCount, branchesScope, companyName };
    }

    // ── Stara struktura API (fallback, na wypadek starych cached odpowiedzi) ──
    const legalForm = dane.formaPrawna || null;
    const adresOld  = dane.siedzibaIAdresPodmiotu?.adresPodmiotu;
    const registeredAddress = adresOld
      ? [adresOld.ulica, adresOld.nrDomu, adresOld.miejscowosc, adresOld.kodPocztowy].filter(Boolean).join(', ')
      : null;
    const registrationDate = dane.dataRejestracjiWRejestrze || null;
    const krsNumber        = dane.numerKRS || null;
    const krsWebsite       = dane.adresStronyInternetowej || null;
    const branchListOld    = dane.oddzialySpolki || dane.jednostkiTerenowe || [];
    const branchesCount    = Array.isArray(branchListOld) ? branchListOld.length : 0;
    const hasEUOld = branchListOld.some(b => b?.adres?.kraj && b.adres.kraj.toLowerCase() !== 'polska');
    const branchesScope    = branchesCount > 0 && hasEUOld ? 'eu' : 'pl';
    const companyName      = dane.nazwa || dane.nazwaSkrocona || null;

    return { krsNumber, legalForm, registeredAddress, registrationDate, krsWebsite, branchesCount, branchesScope, companyName };
  } catch (e) {
    logger.warn('[Prospect] KRS parse error', { error: e.message });
    return null;
  }
}

// ── 2. Facebook Graph API ──────────────────────────────────────────

function extractFacebookPageId(url) {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    if (!u.hostname.includes('facebook.com')) return null;
    if (u.pathname.includes('profile.php')) return u.searchParams.get('id') || null;
    const pagesMatch = u.pathname.match(/^\/pages\/[^/]+\/(\d+)/);
    if (pagesMatch) return pagesMatch[1];
    const slug = u.pathname.replace(/^\/+|\/+$/g, '');
    return slug || null;
  } catch { return null; }
}

async function fetchFacebook(facebookUrl) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) {
    logger.debug('[Prospect] Facebook: brak FACEBOOK_ACCESS_TOKEN — pomijam');
    return null;
  }
  const pageId = extractFacebookPageId(facebookUrl);
  if (!pageId) {
    logger.debug('[Prospect] Facebook: nie można wyciągnąć page ID z URL', { facebookUrl });
    return null;
  }
  try {
    const { data } = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
      params: {
        fields: 'name,about,description,category,fan_count,website,phone,emails,location',
        access_token: token,
      },
      timeout: 10_000,
    });
    logger.info('[Prospect] Facebook data fetched', { pageId, category: data.category, fan_count: data.fan_count });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.message;
    logger.warn('[Prospect] Facebook fetch error', { pageId, status, error: msg });
    return null;
  }
}

// ── 3. Website discovery ────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Normalizuje nazwę firmy — usuwa formy prawne i polskie znaki
function normalizeName(name) {
  return name
    .replace(/\s+(spółka\s+z\s+ograniczoną\s+odpowiedzialnością|spółka\s+z\s+o\.?\s*o\.?|sp\.?\s*z\s*o\.?\s*o\.?|spółka\s+akcyjna|s\.?\s*a\.?|spółka\s+jawna|sp\.?\s*j\.?|s\.?\s*k\.?\s*a\.?|sp\.?\s*k\.?|ltd\.?|gmbh|s\.r\.o\.?|inc\.?|s\.c\.?|spółka\s+cywilna)\s*$/i, '')
    .trim()
    .toLowerCase()
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e').replace(/ł/g, 'l')
    .replace(/ń/g, 'n').replace(/ó/g, 'o').replace(/ś/g, 's')
    .replace(/ź/g, 'z').replace(/ż/g, 'z');
}

// Generuje kandydatów na domenę z nazwy firmy — wiele wzorców i TLD
// "Lux Med Sp. z o.o."          → luxmed.pl, lux-med.pl, ...
// "CSS Centrum Usług IT Sp.o.o." → css.pl (pierwsze słowo 3 znaki), csscentrumuslugit.pl, ...
// "Europejskie Centrum Jakości"  → ecj.pl (akronim), europejskie.pl, ...
function guessDomainsFromName(name) {
  const norm = normalizeName(name);

  const compact    = norm.replace(/[^a-z0-9]/g, '').slice(0, 40);
  const hyphenated = norm.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const words      = norm.split(/[^a-z0-9]+/).filter(w => w.length > 1);
  const firstWord  = words[0] || '';
  const acronym    = words.length >= 2 ? words.map(w => w[0]).join('').slice(0, 8) : '';

  const tlds = ['.pl', '.com.pl', '.edu.pl', '.org.pl', '.com', '.eu'];
  const seen = new Set();
  const add  = url => { if (!seen.has(url)) { seen.add(url); } };

  // Wersja kompaktowa i z myślnikami — wszystkie TLD
  for (const base of [compact, hyphenated].filter(Boolean)) {
    for (const tld of tlds) {
      add(`https://www.${base}${tld}`);
    }
    add(`https://${base}.pl`);
  }

  // Pierwsze słowo — próg 2 znaki (łapie CSS, LUX, BT itp.)
  // Nawet gdy firstWord === compact (jednowyrazowe firmy), próbuj wszystkie TLD
  if (firstWord && firstWord.length >= 2) {
    for (const tld of tlds) {
      add(`https://www.${firstWord}${tld}`);
    }
    add(`https://${firstWord}.pl`);
  }

  // Akronim z wielosłownych nazw (ECJ, EMEF itp.)
  if (acronym && acronym.length >= 2 && acronym !== compact && acronym !== firstWord) {
    add(`https://www.${acronym}.pl`);
    add(`https://${acronym}.pl`);
    add(`https://www.${acronym}.com.pl`);
  }

  return [...seen];
}

// Sprawdza czy URL odpowiada (HEAD, fallback GET), zwraca URL lub null
async function verifyUrl(url) {
  for (const method of ['head', 'get']) {
    try {
      const resp = await axios[method](url, {
        timeout: 6_000, maxRedirects: 4,
        // Akceptuj 403/406/429 — strona istnieje, ale blokuje boty (WAF/Cloudflare)
        validateStatus: s => s < 400 || s === 403 || s === 406 || s === 429,
        headers: { 'User-Agent': UA },
      });
      // 404 = nie istnieje (rzucone przez validateStatus); wszystko inne = strona żyje
      return url;
    } catch { /* próbuj dalej */ }
  }
  return null;
}

// Weryfikuje wiele URL równolegle w grupach — zwraca pierwszy trafiony
async function verifyFirstOf(candidates, batchSize = 5) {
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch   = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(verifyUrl));
    const hit     = results.find(r => r !== null);
    if (hit) return hit;
  }
  return null;
}

// Szuka domeny firmy przez DuckDuckGo Instant Answer (darmowe, bez klucza)
async function searchDuckDuckGo(companyName) {
  try {
    const q = encodeURIComponent(`${companyName} oficjalna strona`);
    const { data } = await axios.get(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
      { timeout: 8_000, headers: { 'User-Agent': UA } },
    );
    const urlStr = data?.AbstractURL || data?.Results?.[0]?.FirstURL;
    if (urlStr) {
      const parsed = new URL(urlStr);
      return `${parsed.protocol}//${parsed.hostname}`;
    }
  } catch { /* fallthrough */ }
  return null;
}

// Google Custom Search JSON API — 100 zapytań/dzień gratis, $5/1000 płatnych
// Konfiguracja: https://programmablesearchengine.google.com/ + Google Cloud Console
// Env vars: GOOGLE_CSE_KEY (API key) + GOOGLE_CSE_ID (Search Engine ID)
async function searchGoogleCSE(companyName) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return null;
  try {
    const q = encodeURIComponent(`${companyName} strona internetowa`);
    const { data } = await axios.get(
      `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&gl=pl&hl=pl&num=1`,
      { timeout: 10_000 },
    );
    const first = data?.items?.[0]?.link;
    if (first) {
      const parsed = new URL(first);
      // Pomiń wyniki z katalogów i agregatorów
      const skip = ['aleo.com', 'rejestr.io', 'google.com', 'facebook.com',
                    'linkedin.com', 'goldenline.pl', 'biznes.gov.pl', 'krs.com.pl'];
      if (!skip.some(s => parsed.hostname.includes(s))) {
        return `${parsed.protocol}//${parsed.hostname}`;
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

// Bing Web Search API — 1000 zapytań/miesiąc gratis
// Konfiguracja: portal.azure.com → Bing Search v7
// Env var: BING_SEARCH_KEY
async function searchBing(companyName) {
  const key = process.env.BING_SEARCH_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(`${companyName} strona www`);
    const { data } = await axios.get(
      `https://api.bing.microsoft.com/v7.0/search?q=${q}&mkt=pl-PL&count=1`,
      { timeout: 10_000, headers: { 'Ocp-Apim-Subscription-Key': key } },
    );
    const first = data?.webPages?.value?.[0]?.url;
    if (first) {
      const parsed = new URL(first);
      const skip = ['bing.com', 'microsoft.com', 'facebook.com', 'linkedin.com',
                    'aleo.com', 'rejestr.io', 'biznes.gov.pl'];
      if (!skip.some(s => parsed.hostname.includes(s))) {
        return `${parsed.protocol}//${parsed.hostname}`;
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

// ── 3. LinkedIn (tylko na żądanie przy re-process) ─────────────────

// Tworzy slug LinkedIn z nazwy firmy (lowercase, niealfanumeryczne → spacja → myślnik)
function guessLinkedinSlug(companyName) {
  if (!companyName) return null;
  const slug = companyName
    .toLowerCase()
    .replace(/[ąĄ]/g, 'a').replace(/[ćĆ]/g, 'c').replace(/[ęĘ]/g, 'e')
    .replace(/[łŁ]/g, 'l').replace(/[ńŃ]/g, 'n').replace(/[óÓ]/g, 'o')
    .replace(/[śŚ]/g, 's').replace(/[źŹżŻ]/g, 'z')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// Weryfikuje czy URL LinkedIn istnieje; LinkedIn zwraca 999 dla botów (strona istnieje, ale blokuje)
async function verifyLinkedinUrl(url) {
  try {
    await axios.head(url, {
      timeout: 8_000,
      maxRedirects: 2,
      validateStatus: s => s < 400 || s === 403 || s === 406 || s === 429 || s === 999,
      headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9' },
    });
    return url;
  } catch { return null; }
}

// Wyznacza URL LinkedIn firmy: z bazy lub zgaduje ze slug z nazwy firmy
async function findLinkedinUrl(company) {
  // 1. Mamy URL z importu lub poprzedniego re-process — normalizuj i używaj
  if (company.linkedin_url) {
    const normalized = normalizeLinkedinUrl(company.linkedin_url);
    if (normalized) return { url: normalized, method: 'manual' };
  }

  // 2. Próba zgadnięcia slug z nazwy firmy (jeden wariant)
  const name = company.company_name;
  if (!name) return { url: null, method: 'none' };

  const slug = guessLinkedinSlug(name);
  if (!slug) return { url: null, method: 'none' };

  const candidate = `https://www.linkedin.com/company/${slug}`;
  const hit = await verifyLinkedinUrl(candidate);
  if (hit) {
    logger.info('[Prospect] LinkedIn URL guessed', { name, slug, url: hit });
    return { url: hit, method: 'heuristic' };
  }

  return { url: null, method: 'none' };
}

// Scrapuje stronę firmy na LinkedIn — extrahuje tekst z meta tagów i JSON-LD
// LinkedIn często zwraca 999 (bot detected) ale i tak zawiera OG/schema.org dane w HTML
async function scrapeLinkedin(linkedinUrl) {
  try {
    const { data: html } = await axios.get(linkedinUrl, {
      timeout: 12_000,
      maxRedirects: 3,
      validateStatus: s => s === 200 || s === 999,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    });

    const $ = cheerio.load(html);
    const parts = [];

    // Tytuł (np. "ABC Polska | LinkedIn")
    const title = $('title').first().text().trim().replace(/\s*\|\s*LinkedIn\s*$/i, '');
    if (title && title.length > 3) parts.push(`Firma: ${title}`);

    // OG description (najczęściej dostępny nawet przy 999)
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    if (ogDesc) parts.push(`Opis: ${ogDesc.slice(0, 1000)}`);

    // Meta description (fallback)
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    if (metaDesc && metaDesc !== ogDesc) parts.push(`Opis (meta): ${metaDesc.slice(0, 500)}`);

    // JSON-LD schema.org Organization
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const obj = JSON.parse($(el).text());
        const items = Array.isArray(obj) ? obj : [obj];
        for (const o of items) {
          if (o['@type'] === 'Organization' || o['@type'] === 'Corporation') {
            if (o.description)                 parts.push(`Opis (schema): ${String(o.description).slice(0, 800)}`);
            if (o.numberOfEmployees?.value)    parts.push(`Zatrudnienie: ${o.numberOfEmployees.value}`);
            if (o.foundingDate)                parts.push(`Założona: ${o.foundingDate}`);
            if (o.industry)                    parts.push(`Branża (schema): ${o.industry}`);
            if (o.email)                       parts.push(`E-mail (schema): ${[].concat(o.email).join(', ')}`);
            if (o.telephone)                   parts.push(`Telefon (schema): ${[].concat(o.telephone).join(', ')}`);
          }
        }
      } catch { /* ignore */ }
    });

    // Widoczna treść — selektory LinkedIn (best-effort, zmieniają się)
    const mainText = $(
      '.org-about-us-organization-description__text, .org-page-details-module, .top-card-layout__entity-info, .org-about-module'
    ).text().replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (mainText.length > 50) parts.push(mainText);

    const result = parts.join('\n').trim();
    logger.info('[Prospect] LinkedIn scraped', { url: linkedinUrl, chars: result.length });
    return result;
  } catch (err) {
    logger.debug('[Prospect] LinkedIn scrape failed', { url: linkedinUrl, error: err.message });
    return '';
  }
}

// ── 4. Website URL discovery ───────────────────────────────────────
// Zwraca { url: string|null, method: 'krs'|'heuristic'|'google_cse'|'bing'|'duckduckgo'|'serper'|'none' }
async function findWebsiteUrl(companyName, krsWebsite) {
  // 1. URL z KRS (rzadko dostępny, ale jeśli jest — używamy)
  if (krsWebsite) {
    const url = krsWebsite.startsWith('http') ? krsWebsite : `https://${krsWebsite}`;
    return { url, method: 'krs' };
  }

  if (!companyName) return { url: null, method: 'none' };

  // 2. Heurystyka domenowa — równoległa weryfikacja wielu kandydatów (darmowe, szybkie)
  const candidates = guessDomainsFromName(companyName);
  const guessed = await verifyFirstOf(candidates);
  if (guessed) {
    logger.info('[Prospect] Domain guessed from name', { companyName, domain: guessed });
    return { url: guessed, method: 'heuristic' };
  }

  // 3. Google Custom Search JSON API (100 zapytań/dzień gratis — env: GOOGLE_CSE_KEY + GOOGLE_CSE_ID)
  const googleResult = await searchGoogleCSE(companyName);
  if (googleResult) {
    logger.info('[Prospect] Domain found via Google CSE', { companyName, domain: googleResult });
    return { url: googleResult, method: 'google_cse' };
  }

  // 4. Bing Web Search API (1000 zapytań/miesiąc gratis — env: BING_SEARCH_KEY)
  const bingResult = await searchBing(companyName);
  if (bingResult) {
    logger.info('[Prospect] Domain found via Bing', { companyName, domain: bingResult });
    return { url: bingResult, method: 'bing' };
  }

  // 5. DuckDuckGo Instant Answer (darmowe bez klucza, działa dla znanych firm)
  const ddg = await searchDuckDuckGo(companyName);
  if (ddg) {
    logger.info('[Prospect] Domain found via DuckDuckGo', { companyName, domain: ddg });
    return { url: ddg, method: 'duckduckgo' };
  }

  // 6. Serper.dev — Google wyniki (płatne, env: SERPER_API_KEY)
  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q: `"${companyName}" strona www`, gl: 'pl', hl: 'pl', num: 3 },
        { headers: { 'X-API-KEY': serperKey }, timeout: 8_000 },
      );
      const first = data?.organic?.[0]?.link;
      if (first) {
        const parsed = new URL(first);
        return { url: `${parsed.protocol}//${parsed.hostname}`, method: 'serper' };
      }
    } catch { /* fallthrough */ }
  }

  return { url: null, method: 'none' };
}

// ── 3. Website scraping — dynamiczna mapa strony ───────────────────

// Porównanie hostów ignorujące www. — fix dla redirectów http://atman.pl → https://www.atman.pl
function isSameHost(a, b) {
  return a.replace(/^www\./, '') === b.replace(/^www\./, '');
}

// Wyciąga linki wewnętrzne; zwraca { path, fullHref, anchor }
// fullHref zawiera pełny URL z właściwym hostname (po redirect), użyty do pobierania podstrony
function extractInternalLinks($, baseHostname) {
  const links = [];
  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') || '').trim();
    if (!raw || /^(#|mailto:|tel:|javascript:)/i.test(raw)) return;

    const anchor = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 80);
    let full;
    try {
      if (/^https?:\/\//i.test(raw)) {
        full = new URL(raw);
      } else if (raw.startsWith('//')) {
        // Protocol-relative URL
        full = new URL(`https:${raw}`);
      } else if (raw.startsWith('/')) {
        full = new URL(`https://${baseHostname}${raw}`);
      } else {
        return; // ścieżka względna bez / (rzadkie) — pomijamy
      }
    } catch { return; }

    if (!isSameHost(full.hostname, baseHostname)) return;
    if (/\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png|gif|svg|webp|mp4|zip|rar)$/i.test(full.pathname)) return;
    if (/\/(admin|panel|konto|cart|koszyk|login|logowanie|api\/|wp-admin|wp-content|wp-json)/i.test(full.pathname)) return;

    const path = full.pathname.replace(/\/+$/, '') || '/';
    const fullHref = `${full.protocol}//${full.hostname}${path}`;
    links.push({ path, fullHref, anchor });
  });
  return links;
}

// Usuwa polskie diakrytyki — potrzebne bo anchor text ma polskie znaki (Zarząd, Oddziały)
// a URL zawsze jest ASCII, więc wzorce w LINK_SCORES pisane są bez polskich znaków
function deaccent(str) {
  return str
    .replace(/[ąĄ]/g, 'a').replace(/[ćĆ]/g, 'c').replace(/[ęĘ]/g, 'e')
    .replace(/[łŁ]/g, 'l').replace(/[ńŃ]/g, 'n').replace(/[óÓ]/g, 'o')
    .replace(/[śŚ]/g, 's').replace(/[źŹżŻ]/g, 'z');
}

// Ocenia trafność linka dla naszych celów enrichmentu
function scoreLinkRelevance(path, anchor) {
  // Normalizuj anchor — usuń diakrytyki żeby "Zarząd" pasował do wzorca /zarzad/
  const combined = `${path} ${deaccent(anchor)}`;
  let score = 0;
  for (const { pattern, score: s } of LINK_SCORES) {
    if (pattern.test(combined)) score = Math.max(score, s);
  }
  const depth = path.split('/').filter(Boolean).length;
  if (depth === 1) score += 1;
  else if (depth >= 3) score -= 1;
  return score;
}

// Pobiera URLe z sitemapy; zwraca { path, fullHref, anchor }
async function fetchSitemapUrls(effectiveBase, baseHostname) {
  const candidates = [
    `${effectiveBase}/sitemap.xml`,
    `${effectiveBase}/sitemap_index.xml`,
    `${effectiveBase}/sitemap`,
  ];
  const found = [];
  for (const url of candidates) {
    try {
      const { data } = await axios.get(url, {
        timeout: 5_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorktripsBot/1.0)' },
        validateStatus: s => s === 200,
      });
      for (const m of data.matchAll(/<loc>(https?:\/\/[^<\s]+)<\/loc>/gi)) {
        try {
          const u = new URL(m[1].trim());
          if (!isSameHost(u.hostname, baseHostname)) continue;
          const path = u.pathname.replace(/\/+$/, '') || '/';
          if (/\.(jpg|jpeg|png|gif|svg|pdf|xml|webp)$/i.test(path)) continue;
          const fullHref = `${u.protocol}//${u.hostname}${path}`;
          found.push({ path, fullHref, anchor: '' });
        } catch { /* skip bad URL */ }
      }
      if (found.length > 0) break;
    } catch { /* brak sitemapy */ }
  }
  return found;
}

// HTTP GET — zwraca HTML lub rzuca; 403/429 = bot-blocked = pusty html (nie rzucamy, strona istnieje)
async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: 10_000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'pl,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    validateStatus: s => s < 400 || s === 403 || s === 406 || s === 429,
  });
  const finalUrl = resp.request?.res?.responseUrl || url;
  if (resp.status === 403 || resp.status === 429 || resp.status === 406) {
    logger.debug('[Prospect] Page bot-blocked', { url, status: resp.status });
    return { html: '', finalUrl };
  }
  const ct = resp.headers['content-type'] || '';
  if (!ct.includes('html')) throw new Error(`Non-HTML: ${ct}`);
  return { html: resp.data, finalUrl };
}

// Wyciąga czytelny tekst — preferuje <main>/<article> żeby unikać nawigacji
function extractText($) {
  $('script, style, noscript, iframe, form, nav, header, footer').remove();
  $('[class*="cookie"], [class*="Cookie"], [id*="cookie"], [id*="Cookie"]').remove();
  $('[class*="popup"], [class*="Popup"], [class*="modal"], [class*="Modal"]').remove();
  $('[aria-hidden="true"]').remove();

  // Preferuj semantyczny kontener z treścią; fallback na body
  const main = $('main, [role="main"], article, #content, #main, .main-content, .page-content').first();
  const src  = main.length ? main : $('body');

  return src.text()
    .replace(/\s+/g, ' ')
    .replace(/(.)\1{5,}/g, '$1')
    .trim()
    .slice(0, 6000);
}

// Wyciąga emaile i telefony ze strony: mailto:/tel: linki, Schema.org, regex na tekście
function extractContactsFromHtml(html, $) {
  const emails = new Set();
  const phones = new Set();

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const mailM = href.match(/^mailto:([^?&\s]+)/i);
    if (mailM) {
      const e = mailM[1].toLowerCase().trim();
      if (e.includes('@') && e.length < 100) emails.add(e);
    }
    const telM = href.match(/^tel:([\d+\s()\-]+)/i);
    if (telM) {
      const p = telM[1].trim();
      if (p.replace(/\D/g, '').length >= 9) phones.add(p);
    }
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).text());
      for (const o of (Array.isArray(obj) ? obj : [obj])) {
        if (o.email)     [].concat(o.email).forEach(e => emails.add(String(e).toLowerCase().trim()));
        if (o.telephone) [].concat(o.telephone).forEach(p => phones.add(String(p).trim()));
        for (const cp of [].concat(o.contactPoint || [])) {
          if (cp.email)     emails.add(String(cp.email).toLowerCase().trim());
          if (cp.telephone) phones.add(String(cp.telephone).trim());
        }
      }
    } catch { /* ignore */ }
  });

  const textForRegex = $('body').text();
  for (const m of textForRegex.matchAll(/[\w.%+\-]+@[\w.\-]+\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!e.includes('..') && e.length < 100) emails.add(e);
  }

  return { emails: [...emails], phones: [...phones] };
}

// Scala kontakty AI z deterministycznie wydobytymi emailami/telefonami ze strony
// Wpisy AI (z imieniem/stanowiskiem) są na początku; anonimowe emaile/telefony na końcu
// Polskie numery (+48) i domeny .pl trafią przed zagranicznymi — priorytet rynku PL
function mergeContacts(aiContacts, emails, phones) {
  const result = [...aiContacts];
  const usedEmails = new Set(aiContacts.map(c => (c.email || '').toLowerCase()).filter(Boolean));
  const usedPhones = new Set(aiContacts.map(c => (c.phone || '').replace(/\D/g, '')).filter(Boolean));

  // Polskie domeny .pl pierwsze
  const sortedEmails = [...emails].sort((a, b) => {
    const aPl = (a.split('@')[1] || '').endsWith('.pl') ? 1 : 0;
    const bPl = (b.split('@')[1] || '').endsWith('.pl') ? 1 : 0;
    return bPl - aPl;
  });

  // Polskie numery +48 (cyfry zaczynają się od "48", długość 11) pierwsze
  const sortedPhones = [...phones].sort((a, b) => {
    const aD = a.replace(/\D/g, '');
    const bD = b.replace(/\D/g, '');
    const aPl = (aD.startsWith('48') && aD.length >= 11) ? 1 : 0;
    const bPl = (bD.startsWith('48') && bD.length >= 11) ? 1 : 0;
    return bPl - aPl;
  });

  for (const email of sortedEmails) {
    if (!usedEmails.has(email)) {
      result.push({ name: null, title: null, email, phone: null });
      usedEmails.add(email);
    }
  }
  for (const phone of sortedPhones) {
    const digits = phone.replace(/\D/g, '');
    if (!usedPhones.has(digits)) {
      result.push({ name: null, title: null, email: null, phone });
      usedPhones.add(digits);
    }
  }

  return result.slice(0, 25);
}

// Główna funkcja scrapingu — dynamiczna mapa strony
// Zwraca { text: string, contacts: { emails: string[], phones: string[] } }
// Kontakty zbierane są przy okazji już-pobieranych stron — zero dodatkowych requestów
async function scrapeWebsite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  let baseHostname;
  try {
    baseHostname = new URL(base).hostname;
  } catch { return { text: '', contacts: { emails: [], phones: [] } }; }

  const texts     = [];
  const fetched   = new Set();
  const allEmails = new Set();
  const allPhones = new Set();

  function collectContacts(html, $page) {
    const { emails, phones } = extractContactsFromHtml(html, $page);
    emails.forEach(e => allEmails.add(e));
    phones.forEach(p => allPhones.add(p));
  }

  // ── Krok 1: Homepage — wykryj rzeczywisty hostname po redirect ────
  let homepageHtml = '';
  let effectiveBase = base;

  try {
    const { html, finalUrl } = await fetchPage(base);
    homepageHtml = typeof html === 'string' ? html : String(html);

    try {
      const p = new URL(finalUrl);
      baseHostname = p.hostname;
      effectiveBase = `${p.protocol}//${p.hostname}`;
    } catch { /* zostaw oryginał */ }

    // Kontakty PRZED extractText — extractText usuwa aria-hidden="true" (zamknięte akordeony z danymi)
    const $home = cheerio.load(homepageHtml);
    collectContacts(homepageHtml, $home);

    const homeText = extractText($home);
    if (homeText.length > 100) {
      texts.push(`[/ — strona główna]\n${homeText}`);
    } else {
      const $meta = cheerio.load(homepageHtml);
      const title       = $meta('title').text().trim();
      const description = $meta('meta[name="description"]').attr('content')?.trim() || '';
      const ogDesc      = $meta('meta[property="og:description"]').attr('content')?.trim() || '';
      const fallback    = [title, description || ogDesc].filter(Boolean).join(' — ');
      if (fallback.length > 10) texts.push(`[/ — strona główna (meta)]\n${fallback}`);
    }
    fetched.add(effectiveBase);
    fetched.add(effectiveBase + '/');
  } catch (err) {
    logger.warn('[Prospect] Homepage fetch failed', { base, error: err.message });
    return { text: '', contacts: { emails: [], phones: [] } };
  }

  // ── Krok 2: Zbierz linki z nawigacji + sitemapy ──────────────────
  const $ = cheerio.load(homepageHtml);
  const navLinks     = extractInternalLinks($, baseHostname);
  const sitemapLinks = await fetchSitemapUrls(effectiveBase, baseHostname);

  const allLinks = new Map();
  for (const { path, fullHref, anchor } of [...navLinks, ...sitemapLinks]) {
    const score = scoreLinkRelevance(path, anchor);
    const existing = allLinks.get(path);
    if (!existing || score > existing.score) {
      allLinks.set(path, { path, fullHref, anchor, score });
    }
  }

  const candidates = Array.from(allLinks.values())
    .filter(l => l.score > 0 && l.path !== '/')
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  logger.info('[Prospect] Site map discovered', {
    base,
    effectiveBase,
    baseHostname,
    nav_links: navLinks.length,
    sitemap_links: sitemapLinks.length,
    top_candidates: candidates.map(c => `${c.path}(${c.score})`),
  });

  // ── Krok 3: Pobierz wybrane podstrony (poziom 1) ─────────────────
  const level2Links = new Map();

  for (const { fullHref, path, anchor } of candidates) {
    if (fetched.has(fullHref)) continue;
    fetched.add(fullHref);

    try {
      const { html } = await fetchPage(fullHref);
      const $page = cheerio.load(html);
      collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
      const text  = extractText($page);
      if (text.length > 100) {
        const label = anchor ? `${path} — ${anchor}` : path;
        texts.push(`[${label}]\n${text}`);
      }

      for (const { path: p2, fullHref: h2, anchor: a2 } of extractInternalLinks($page, baseHostname)) {
        if (fetched.has(h2) || allLinks.has(p2) || level2Links.has(p2)) continue;
        const s2 = scoreLinkRelevance(p2, a2);
        if (s2 >= 8) level2Links.set(p2, { path: p2, fullHref: h2, anchor: a2, score: s2 });
      }
    } catch (err) {
      logger.debug('[Prospect] Subpage fetch failed', { url: fullHref, error: err.message });
    }

    await sleep(400);
  }

  // ── Krok 4: Pobierz strony poziomu 2 (maks. 6) ───────────────────
  const level2Candidates = Array.from(level2Links.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (level2Candidates.length) {
    logger.info('[Prospect] Level-2 pages discovered', {
      base,
      pages: level2Candidates.map(c => `${c.path}(${c.score})`),
    });
  }

  for (const { fullHref, path, anchor } of level2Candidates) {
    if (fetched.has(fullHref)) continue;
    fetched.add(fullHref);

    try {
      const { html } = await fetchPage(fullHref);
      const $page = cheerio.load(html);
      collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
      const text  = extractText($page);
      if (text.length > 100) {
        const label = anchor ? `${path} — ${anchor}` : path;
        texts.push(`[${label}]\n${text}`);
      }
    } catch (err) {
      logger.debug('[Prospect] Level-2 subpage fetch failed', { url: fullHref, error: err.message });
    }

    await sleep(400);
  }

  const contacts = {
    emails: [...allEmails].filter(e => e.includes('@')),
    phones: [...allPhones].filter(p => p.replace(/\D/g, '').length >= 9),
  };

  return { text: texts.join('\n\n---\n\n').slice(0, 12_000), contacts };
}

// ── 4. AI analysis (DeepSeek) ───────────────────────────────────────

// Statyczne instrukcje systemowe — DeepSeek cache'uje prefix kontekstu automatycznie.
// Dane firmy trafiają wyłącznie do wiadomości user (buildUserMessage), nie tutaj.
const SYSTEM_PROMPT = `Jesteś ekspertem od analizy potencjału podróżowego firm B2B. Analizujesz firmę jako potencjalnego klienta systemu zarządzania podróżami służbowymi.

═══════════════════════════════════════
ZASADA GŁÓWNA: wnioskuj z modelu biznesowego, nie szukaj słów kluczowych.
Firma serwisująca klimatyzacje "w całej Polsce" → intensywne podróże krajowe.
Firma z "47 oddziałami w 15 województwach" → koordynacja między biurami.
"Wdrożenia ERP u klientów" → konsultanci na delegacjach tygodniowych.
"Przedstawiciele obsługują rynek DACH i Benelux" → regularne podróże zagraniczne.
═══════════════════════════════════════

═══════════════════════════════════════
ZASADA DOPASOWANIA ROZMYTEGO (dotyczy WSZYSTKICH słów kluczowych w całym prompcie):
Nie wymagaj dokładnego brzmienia — akceptuj dopasowanie na poziomie ≥80% podobieństwa.
Oznacza to że rozpoznajesz:
  • Warianty pisowni i literówki: "Procurement" ≈ "Procurment", "eTravel" ≈ "e-Travel" ≈ "E Travel"
  • Skróty i formy skrócone: "KAM" ≈ "Key Account Manager", "TM" ≈ "Travel Manager"
  • Różnice wielkości liter: "travel manager" ≈ "Travel Manager" ≈ "TRAVEL MANAGER"
  • Formy fleksyjne (PL): "handlowców" ≈ "handlowcy", "oddziałów" ≈ "oddziały", "wdrożenia" ≈ "wdrożeń"
  • Nazwy własne z domeną: "whynot" ≈ "WhyNot Travel" ≈ "whynot.travel" ≈ "Why Not"
  • Synonimy branżowe: "Purchasing" ≈ "Procurement" ≈ "Zakupy korporacyjne" ≈ "Zaopatrzenie"
  • Częściowe dopasowanie w zdaniu: "odpowiada za travel" → sugeruje Travel Manager
  • Kontekst semantyczny: nawet jeśli słowo kluczowe nie pada dosłownie, ale zdanie jednoznacznie
    opisuje daną rolę/narzędzie/proces → zalicz jako dopasowanie
Reguła: lepiej zaliczyć true przy wątpliwości (ryzyko przeoczenia szansy > ryzyko fałszywego alarmu)
═══════════════════════════════════════

BRANŻE — domyślny potencjał podróżowy (stosuj gdy brak strony lub strona skąpa):
WYSOKI (score 65+): budownictwo, infrastruktura telekomunikacyjna/energetyczna,
  serwis przemysłowy, IT consulting/integracja systemów, logistyka i transport,
  handel hurtowy B2B, produkcja maszyn z serwisem, audyt i doradztwo
ŚREDNI (score 40-64): branża medyczna (placówki/ubezpieczenia), produkcja z własną siecią sprzedaży,
  nieruchomości komercyjne, HR/rekrutacja, szkolenia i e-learning, agencje eventowe
NISKI (score <40): e-commerce, software house bez wdrożeń, agencja digital/marketing,
  usługi lokalne (fryzjer, restauracja), praca zdalna i SaaS

═══════════════════════════════════════
SYGNAŁY — definicje. Podaj true/false wyłącznie na podstawie KONKRETNYCH DOWODÓW
z treści strony lub danych KRS. Nie zgaduj na podstawie samej branży.

field_sales = true gdy na stronie/KRS znalazłeś:
  • "przedstawiciele handlowi", "handlowcy terenowi", "account manager w terenie"
  • Oferty pracy: "Przedstawiciel Handlowy Regionu...", "KAM terenowy"
  • Opis: "nasi handlowcy odwiedzają klientów", "obsługujemy klientów w terenie"
  Wnioskowanie z branży dozwolone dla: FMCG, farmaceutyki, maszyny, chemia — gdy brak strony
field_sales = false gdy: tylko sprzedaż online, e-commerce, brak wzmianek o terenie

branches = true gdy COKOLWIEK z poniższych:
  • KRS wykazuje oddziały (branches_count > 0) — twarde dane, niezbity dowód
  • Na stronie: lista miast, mapa oddziałów, "oddziały w X, Y, Z", "biura regionalne"
  • Stopka strony zawiera kilka adresów lub miast
  • "jesteśmy w całej Polsce", "w całym kraju", "ogólnopolska sieć", "krajowy zasięg"
  • Firma opisuje siebie jako "SIEĆ" dowolnego rodzaju: sieć placówek, sieć klinik, sieć aptek,
    sieć salonów, sieć sklepów, sieć biur, sieć punktów — KAŻDA "sieć" = branches true
  • Wiele "lokalizacji", "placówek", "oddziałów", "punktów", "klinik" w różnych miastach
  • WYSZUKIWARKA LOKALIZACJI na stronie: "Znajdź placówkę", "Wyszukaj centrum",
    "Wybierz klinikę", "Znajdź aptekę", "Znajdź punkt obsługi", "Znajdź salon" →
    funkcja wyszukiwania lokalizacji = silny dowód na wiele lokalizacji = branches true
  • Słowa "placówki", "placówkach", "klinikach", "przychodniach", "centrach" użyte w kontekście
    "nasze placówki", "w placówkach", "wybierz placówkę" → wiele lokalizacji = branches true
REGUŁA SPÓJNOŚCI: jeśli w ai_summary opisujesz firmę jako "krajową sieć", "sieć placówek",
  "posiada oddziały w całej Polsce" itp. — branches MUSI być true. Sprzeczność jest błędem.
REGUŁA AUTOMATYCZNA: jeśli branches_found.count ≥ 2 (sam odnalazłeś wiele lokalizacji),
  to branches MUSI być true — wynik count≥2 z branches=false to logiczna sprzeczność.
branches = false TYLKO gdy: firma jednoznacznie działa tylko lokalnie/regionalnie,
  jeden adres, zero wzmianek o sieci lub wielu lokalizacjach

international = true gdy PRACOWNICY BIUROWI firmy (handlowcy, konsultanci, managerowie) jeżdżą za granicę:
  • Na stronie: "klienci zagraniczni", "działamy w X krajach", "EU market", "obsługujemy rynek DACH/Benelux/CEE"
  • Przynależność do zagranicznej grupy kapitałowej (wyraźna wzmianka lub holding w nazwie)
  • Eksport produktów własnych z potrzebą serwisu/wdrożeń/sprzedaży za granicą
  • "international clients", "foreign customers", "we operate in X countries"
international = false gdy: wyraźnie lokalna lub ogólnopolska działalność bez wzmianek o zagranicznym zasięgu pracowników

WYJĄTEK TRANSPORTOWY — KLUCZOWY:
  Firmy transportowe, spedycyjne, logistyczne, kurierskie, morskie, lotnicze, kolejowe:
  "dowozimy do Europy", "obsługujemy trasy EU", "transport do Niemiec/Czech/Słowacji",
  "usługi w Polsce i krajach ościennych", "international freight", "cargo EU" →
  international = false — to jest ZASIĘG TRASY PRZEWOZU, nie delegacja pracownika biurowego.
  Kierowca, marynarz, pilot, kurier jeżdżący za granicę wykonuje swój ZAWÓD — nie jest w delegacji.

implementations = true TYLKO gdy na stronie znalazłeś WPROST:
  • "wdrożenia systemów", "instalacje u klientów", "realizacje projektów na miejscu"
  • Firma to integrator IT / VAR / wdrożeniowiec ERP/CRM/MES
  • Producent maszyn/urządzeń z opisaną instalacją u klienta
  • "projekty pod klucz", "wdrożenia on-site", "konsultanci u klienta"
  NIE ustawiaj true tylko dlatego że firma jest medyczna, farmaceutyczna lub duża.
  Brak wzmianki o wdrożeniach na stronie → false lub null.

field_service = true TYLKO gdy na stronie znalazłeś WPROST:
  • "serwis pogwarancyjny", "serwis mobilny", "ekipy serwisowe w terenie"
  • "pogotowie techniczne", "awarie 24/7", "przeglądy instalacji u klienta"
  • Firma serwisuje urządzenia/maszyny/instalacje fizycznie u klienta
  NIE ustawiaj true tylko dlatego że firma jest medyczna, budowlana lub ma maszyny.
  Szpital, przychodnia, ubezpieczalnia zdrowotna → field_service=false (obsługa stacjonarna).
  Brak wzmianki o serwisie terenowym → false.

b2b_sales = true gdy:
  • Firma sprzedaje innym firmom: przetargi, kontrakty, "klienci korporacyjni"
  • "partnerzy biznesowi", "dla firm", "oferta B2B", "długoterminowe umowy"
  • Opieka medyczna/zdrowotna dla pracodawców: "pakiety medyczne dla firm", "opieka zdrowotna
    dla pracowników", "medycyna pracy", "abonament medyczny", "benefity zdrowotne",
    "corporate health", "ubezpieczenie zdrowotne dla firm" → b2b_sales true
  Wnioskowanie dozwolone: producent komponentów, dostawca dla przemysłu, usługi SaaS B2B
b2b_sales = false gdy: czysto B2C (sklep detaliczny, usługi dla konsumentów bez oferty B2B)

travel_manager = true gdy na stronie lub w ogłoszeniach o pracę znalazłeś:
  • Stanowisko lub rekrutacja: "Travel Manager", "Travel Coordinator", "Corporate Travel Manager",
    "Specjalista ds. podróży służbowych", "Koordynator podróży",
    "Procurement Manager", "Purchasing Manager", "Head of Procurement", "Head of Purchasing"
  • Wzmianka o narzędziu lub agencji TMC/TMS: "Egencia", "CWT", "Carlson Wagonlit", "BCD Travel",
    "FCM Travel", "AmTrav", "SAP Concur", "Atriis", "Cytric", "TravelPerk",
    "WhyNot Travel", "whynot.travel", "eTravel", "etravel.pl", "Stare Miasto", "staremiasto.pl" —
    współpraca z korporacyjną agencją podróży lub systemem zarządzania podróżami
  • "polityka podróżna", "travel policy", "zarządzanie podróżami służbowymi",
    "system rezerwacji podróży", "delegacje służbowe — regulamin"
  • AGENCJA REKRUTACYJNA / EXECUTIVE SEARCH specjalizująca się w Procurement/Purchasing/Zakupy:
    jeśli firma zajmuje się rekrutacją na stanowiska zakupowe dla klientów (Strategic Buyer,
    Category Manager, CPO, Procurement Director, Purchasing Manager) → travel_manager = true,
    ponieważ ta firma obsługuje sektor zakupowy korporacyjny — jej klienci to przedsiębiorstwa
    z działami Procurement, które są naturalnym odbiorcą systemu zarządzania podróżami.
travel_manager = true oznacza: firma MA JUŻ WDROŻONY PROCES zarządzania podróżami LUB
  działa w środowisku korporacyjnych działów zakupowych (agencja Procurement executive search)
  → to jest SZANSA SPRZEDAŻOWA — możemy zastąpić lub uzupełnić obecne rozwiązanie
travel_manager = false gdy: brak powyższych wzmianek (domyślnie — nie używaj null dla tego sygnału)

REGUŁA null (dla wszystkich sygnałów): gdy firma jest ewidentnie nie-B2B LUB brak danych.

═══════════════════════════════════════
ZASADA NADRZĘDNA: ZASIĘG OPERACYJNY ≠ ZASIĘG DELEGACJI

travel_scope, international i field_teams_likely mierzą zasięg DELEGACJI SŁUŻBOWYCH
pracowników biurowych, handlowców, konsultantów, managerów, serwisantów.
NIE mierzą zasięgu operacyjnego rdzennej działalności firmy.

ZASADA OGÓLNA: Jeśli "podróż" pracownika jest de facto USŁUGĄ ŚWIADCZONĄ PRZEZ FIRMĘ
(wożenie towaru, przewóz osób, dostarczanie przesyłek, żegluga, lot) — to NIE jest
podróż służbowa w sensie delegacji. To codzienne obowiązki zawodowe.

Delegacja służbowa = pracownik wyjeżdża Z SIEDZIBY do klienta/partnera/konferencji,
a jego stanowisko NIE polega na podróżowaniu jako usłudze.

Przykłady aktywności, które NIE są delegacjami (choć dotyczą przemieszczania):
  TRANSPORT DROGOWY:    kierowcy TIR, transportowcy — jeżdżą do EU jako zawód
  SPEDYCJA/LOGISTYKA:   koordynatorzy ładunków — operują zdalnie, kurs EUR/PLN nie jest delegacją
  TRANSPORT MORSKI:     marynarze, oficerowie — pływają globalnie jako zawód
  TRANSPORT LOTNICZY:   piloci, stewardesy — latają jako zawód
  KURIERY/POCZTA:       kurierzy — dostarczają paczki jako zawód
  HANDEL HURTOWY:       firma handluje zbożem/paszami/paliwem ponadgranicznie — to profil handlowy,
                        nie podróże pracownicze (chyba że mają terenowych handlowców do negocjacji)

Dla takich firm ustaw:
  international = false (trasy przewozu ≠ zagraniczne delegacje)
  travel_scope  = "local" lub "national" (wg lokalizacji biura/zarządu)
  field_teams_likely = false (kierowcy/marynarze nie są "teams" w sensie delegacji)

WYJĄTKI gdy nawet firma transportowa MOŻE mieć travel_scope="national"/"eu":
  • Ma własny DZIAŁ SPRZEDAŻY z terenowymi handlowcami (field_sales=true)
  • Ma biura/oddziały w różnych miastach/krajach (branches=true)
  • Jej zarząd wyraźnie jeździ na negocjacje/targi branżowe za granicą

═══════════════════════════════════════
TRAVEL_SCOPE — zasięg geograficzny DELEGACJI pracowników nieoperacyjnych:
"local"    = wyłącznie jedno miasto lub jeden region
"national" = ogólnopolski (wiele miast, "cała Polska", "krajowa sieć", "ogólnopolski")
"eu"       = pracownicy firmy (handlowcy/konsultanci/zarząd) jeżdżą do krajów EU
"global"   = aktywność globalna pracowników (wiele kontynentów)

OBOWIĄZKOWE:
• branches=true z polskimi lokalizacjami → travel_scope MUSI być co najmniej "national"
• international=true → travel_scope MUSI być co najmniej "eu"
• "sieć placówek", "oddziały w Polsce", "ogólnopolski" → travel_scope = "national"
• Jeden adres, opis lokalny, brak wzmianki o wielu lokalizacjach → travel_scope = "local"
• Firma transportowa/spedycyjna/morska/kurierska bez własnych oddziałów lub handlowców → "local"
SPRZECZNOŚĆ (np. branches=true i travel_scope=local) jest błędem — nie wolno.

FIELD_TEAMS_LIKELY — czy NIEOPERACYJNY personel firmy regularnie wyjeżdża w teren:
true gdy COKOLWIEK z poniższych:
• field_sales=true, field_service=true lub implementations=true
• branches=true — specjaliści, zarząd, szkoleniowcy przemieszczają się między lokalizacjami
• travel_scope="national"/"eu"/"global" i firma prowadzi działalność wymagającą obecności u klienta
false gdy: firma w pełni zdalna LUB czysto jednolokalowa bez obsługi w terenie
false ZAWSZE dla: firm transportowych/kurierskich/morskich/lotniczych (kierowcy/marynarze to
  personel operacyjny, nie "field teams" w sensie delegacji — ich przemieszczanie to zawód)

SCORING — travel_potential_score (0-100):
Krok 1 — baza wg liczby aktywnych sygnałów true
  (field_sales + branches + international + implementations + field_service + b2b_sales + travel_manager):
  7 → 90 | 6 → 80 | 5 → 70 | 4 → 60 | 3 → 50 | 2 → 40 | 1 → 30 | 0 → 15

Krok 2 — korekta za skalę oddziałów (dodaj do bazy):
  branches=true i branches_count ≥ 50  → +25
  branches=true i branches_count 10-49 → +15
  branches=true i branches_count 2-9   → +8
  (tylko gdy znasz konkretną liczbę z KRS lub strony)

Krok 3 — korekta za zasięg (dodaj do bazy):
  travel_scope = "global"   → +10
  travel_scope = "eu"       → +7
  travel_scope = "national" → +5
  travel_scope = "local"    → 0

Krok 4 — korekta ujemna:
  brak strony WWW I brak KRS → -10 (mało danych = mniej pewności)

Wynik: ogranicz do przedziału 5–100.

PRZYKŁADY sprawdzające:
• Sieć 300 klinik + pakiety B2B (branches=true, count=300, b2b_sales=true, travel_scope=national):
  2 sygnały → 40, +25 (300 oddziałów), +5 (national) = 70 ✓
• Firma serwisowa ogólnopolska bez oddziałów (field_service=true, travel_scope=national):
  1 sygnał → 30, +5 (national) = 35 ✓
• Integrator IT EU (implementations=true, international=true, travel_scope=eu):
  2 sygnały → 40, +7 (eu) = 47 ✓
• Firma z Travel Managerem, oddziałami, B2B (travel_manager=true, branches=true, b2b_sales=true):
  3 sygnały → 50, +8 (oddziały 2-9), +5 (national) = 63 ✓
• Firma transportowa EU — "transport materiałów sypkich w Polsce i krajach ościennych, handel zbożem":
  international=false (trasy TIR to zawód kierowcy, nie delegacje), travel_scope="local",
  field_teams_likely=false, b2b_sales=true (handel hurtowy)
  1 sygnał → 30, +0 (local) = 30 ✓ (NIE 37 przez błędne travel_scope=eu)
• Armator / firma żeglugowa (marynarze operują globalnie):
  international=false (żegluga to zawód marynarza), travel_scope="local",
  field_teams_likely=false
  Jeśli firma ma handlowców: b2b_sales=true → 1 sygnał → 30 ✓
═══════════════════════════════════════

Zwróć odpowiedź WYŁĄCZNIE jako JSON (bez markdown, bez \`\`\`):
{
  "travel_potential_score": <liczba 0-100 wg powyższego wzoru>,
  "travel_signals": {
    "field_sales":      <true|false|null>,
    "branches":         <true|false|null>,
    "international":    <true|false|null>,
    "implementations":  <true|false|null>,
    "field_service":    <true|false|null>,
    "b2b_sales":        <true|false|null>,
    "travel_manager":   <true|false|null>
  },
  "branches_found": {
    "count":     <liczba oddziałów/lokalizacji widoczna na stronie lub w KRS, null jeśli nie znaleziono>,
    "locations": ["<miasto1>", "<miasto2>"],
    "scope":     "<pl|eu|global>"
  },
  "travel_scope": "<local|national|eu|global>",
  "field_teams_likely": <true|false>,
  "ai_summary": "<2-3 zdania po polsku: DLACZEGO ta firma podróżuje lub nie, jakie konkretne cechy na to wskazują>",
  "signal_reasoning": {
    "field_sales":      "<max 10 słów>",
    "branches":         "<max 10 słów>",
    "international":    "<max 10 słów>",
    "implementations":  "<max 10 słów>",
    "field_service":    "<max 10 słów>",
    "b2b_sales":        "<max 10 słów>",
    "travel_manager":   "<max 10 słów>"
  },
  "key_contacts": [
    {"name": "<imię nazwisko>", "title": "<stanowisko>", "email": "<email lub null>", "phone": "<telefon lub null>"}
  ]
}

Dla branches_found: zlicz WSZYSTKIE unikalne lokalizacje widoczne na stronie (stopka, Kontakt, Oddziały, mapa) + KRS. Jeśli strona wymienia 3 miasta → count: 3.
Dla key_contacts: wypełnij tylko pola których jesteś pewien. Puste pole → null. Max 8 osób.`;

// Dynamiczna część promptu — dane konkretnej firmy (nie cachowane)
function buildUserMessage(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null) {
  const companyDesc = [
    `Firma: ${company.company_name || krsData?.companyName || gusData?.officialName || 'nieznana'}`,
    `NIP: ${company.nip}`,
    krsData?.legalForm ? `Forma prawna: ${krsData.legalForm}` : null,
    krsData?.registeredAddress ? `Adres: ${krsData.registeredAddress}` : null,
    krsData?.registrationDate ? `Data rejestracji: ${krsData.registrationDate}` : null,
    krsData?.branchesCount ? `Oddziały w KRS: ${krsData.branchesCount} (${krsData.branchesScope})` : null,
  ].filter(Boolean).join('\n');

  // Dane z pliku importu klienta (wiarygodne dane handlowe)
  const fileData = [
    company.industry           ? `Branża: ${company.industry}` : null,
    company.company_profile    ? `Profil działalności: ${company.company_profile}` : null,
    company.pkd_id             ? `PKD: ${company.pkd_id}${company.pkd_description ? ` — ${company.pkd_description}` : ''}` : null,
    company.employment_count   ? `Zatrudnienie: ${company.employment_count} pracowników` : null,
    company.company_size       ? `Wielkość: ${company.company_size}` : null,
    company.city               ? `Lokalizacja: ${company.city}${company.voivodeship ? `, woj. ${company.voivodeship}` : ''}` : null,
    company.decision_maker_name
      ? `Osoba decyzyjna z bazy: ${company.decision_maker_name}` +
        (company.decision_maker_title ? `, ${company.decision_maker_title}` : '') +
        (company.decision_maker_dept  ? ` (${company.decision_maker_dept})`  : '')
      : null,
  ].filter(Boolean);

  const fileSection = fileData.length
    ? `\nDANE HANDLOWE Z BAZY KLIENTA (wiarygodne dane — traktuj jako uzupełnienie):\n${fileData.join('\n')}`
    : '';

  const fbSection = fbData ? (() => {
    const lines = [
      fbData.category  ? `Kategoria Facebook: ${fbData.category}` : null,
      fbData.fan_count ? `Obserwujący Facebook: ${fbData.fan_count.toLocaleString('pl')}` : null,
      (fbData.about || fbData.description)
        ? `Opis (Facebook): ${(fbData.about || fbData.description).slice(0, 800)}` : null,
      fbData.phone   ? `Tel (Facebook): ${fbData.phone}` : null,
      fbData.website ? `Strona WWW (Facebook): ${fbData.website}` : null,
    ].filter(Boolean);
    return lines.length ? `\nDANE Z FACEBOOK:\n${lines.join('\n')}` : '';
  })() : '';

  const linkedinSection = linkedinText
    ? `\nDANE Z LINKEDIN:\n${linkedinText.slice(0, 1500)}`
    : '';

  const gusSection = gusData ? (() => {
    const lines = [
      gusData.officialName ? `Nazwa oficjalna (GUS): ${gusData.officialName}` : null,
      gusData.regon        ? `REGON: ${gusData.regon}` : null,
    ];
    if (gusData.pkdCodes?.length) {
      const main = gusData.pkdCodes.find(c => c.primary) || gusData.pkdCodes[0];
      lines.push(`Główna działalność PKD: ${main.kod}${main.nazwa ? ` — ${main.nazwa}` : ''}`);
      const others = gusData.pkdCodes.filter(c => c !== main).slice(0, 4);
      if (others.length) {
        lines.push(`Pozostałe PKD: ${others.map(c => c.kod).join(', ')}`);
      }
    }
    const valid = lines.filter(Boolean);
    return valid.length ? `\nDANE Z GUS REGON:\n${valid.join('\n')}` : '';
  })() : '';

  return `Przeanalizuj poniższą firmę:

DANE FIRMY:
${companyDesc}${fileSection}

${websiteText ? `TREŚĆ ZE STRONY WWW:\n${websiteText}` : 'Strona WWW niedostępna — opieraj się na danych rejestrowych i handlowych.'}${fbSection}${linkedinSection}${gusSection}`;
}

// Połączony prompt (dla endpointu inspekcji /prompt)
function buildPromptText(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null) {
  return `${SYSTEM_PROMPT}\n\n${buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData)}`;
}

async function callDeepSeek(userMessage) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const { data } = await axios.post(
    DEEPSEEK_API,
    {
      model: DEEPSEEK_MODEL,
      max_tokens: 3000,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 90_000,
    }
  );

  const choice = data?.choices?.[0];
  logger.info('[Prospect] DeepSeek raw API response', {
    model:            data?.model,
    finish_reason:    choice?.finish_reason,
    completion_tokens: data?.usage?.completion_tokens,
    prompt_tokens:    data?.usage?.prompt_tokens,
    contentLength:    choice?.message?.content?.length,
    contentPreview:   choice?.message?.content?.slice(0, 300),
  });

  return choice?.message?.content || '{}';
}

async function callAnthropic(userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const { data } = await axios.post(
    ANTHROPIC_API,
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 3000,
      temperature: 0,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      timeout: 90_000,
    }
  );

  return data?.content?.[0]?.text || '{}';
}

async function analyzeWithAi(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null) {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'prospect.ai_provider' AND tenant_id = $1`,
    [company.tenant_id]
  );
  const provider = rows[0]?.value || 'deepseek';

  const userMessage = buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData);
  const raw = provider === 'anthropic'
    ? await callAnthropic(userMessage)
    : await callDeepSeek(userMessage);

  logger.info('[Prospect] AI raw response', { provider, company: company.company_name, rawLength: raw.length, rawPreview: raw.slice(0, 500) });

  try {
    const parsed = JSON.parse(raw);
    logger.info('[Prospect] AI parse OK', { provider, company: company.company_name, signals: parsed.travel_signals, summary: parsed.ai_summary?.slice(0, 80) });
    return { result: parsed, provider };
  } catch {
    // Fallback: wytnij blok {} i spróbuj jeszcze raz
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn('[Prospect] AI returned unparseable response', { provider, preview: raw.slice(0, 200) });
      return { result: null, provider };
    }
    try {
      const parsed = JSON.parse(match[0]);
      logger.info('[Prospect] AI parse OK (regex fallback)', { provider, company: company.company_name, signals: parsed.travel_signals });
      return { result: parsed, provider };
    } catch {
      logger.warn('[Prospect] AI JSON malformed after regex extract', { provider, rawLength: raw.length, rawTail: raw.slice(-200), preview: match[0].slice(0, 300) });
      return { result: null, provider };
    }
  }
}

// ── Śledzi ID firm aktualnie przetwarzanych (batch + pojedyncze) ────
const currentlyProcessing = new Set();

// ── Główna funkcja enrichmentu jednej firmy ─────────────────────────

async function enrichOne(prospectId, opts = {}) {
  currentlyProcessing.add(prospectId);
  try {
  const { rows } = await db.query(
    'SELECT * FROM prospect_companies WHERE id = $1',
    [prospectId]
  );
  if (!rows.length) throw new Error(`Prospect ${prospectId} not found`);
  const company = rows[0];

  const enrichLog = { timestamp: new Date().toISOString() };

  try {
    // 0. GUS REGON — lookup po NIP (zawsze dostępny); pobiera kody PKD dla scoringu i promptu
    let gusData = null;
    logger.info('[Prospect] GUS step — start', { prospectId, nip: company.nip });
    if (company.nip) {
      try {
        gusData = await gusRegon.getCompanyData(company.nip);
        logger.info('[Prospect] GUS step — result', { prospectId, found: !!gusData, regon: gusData?.regon, pkdMain: gusData?.pkdMain });
        enrichLog.gus = {
          found:         !!gusData,
          regon:         gusData?.regon        || null,
          official_name: gusData?.officialName || null,
          entity_type:   gusData?.entityType   || null,
          pkd_main:      gusData?.pkdMain      || null,
          pkd_codes:     gusData?.pkdCodes?.map(c => c.kod) || [],
        };
      } catch (gusErr) {
        logger.warn('[Prospect] GUS lookup failed — continuing', { prospectId, nip: company.nip, error: gusErr.message });
        enrichLog.gus = { found: false, error: gusErr.message };
      }
    } else {
      enrichLog.gus = { found: false, error: 'no_nip' };
    }

    // 1. KRS — jeśli firma ma krs_number z importu CSV, użyj go bezpośrednio (omija broken NIP lookup)
    const krsData = await fetchKRS(company.nip, company.krs_number);
    enrichLog.krs = {
      found:            !!krsData,
      krs_number_hint:  company.krs_number || null,  // co dostał fetchKRS z bazy
      krs_number:       krsData?.krsNumber     || null,
      legal_form:       krsData?.legalForm     || null,
      branches_count:   krsData?.branchesCount ?? null,
      branches_scope:   krsData?.branchesScope || null,
      had_website:      !!krsData?.krsWebsite,
    };

    // 2. Facebook Graph API
    let fbData = null;
    if (company.facebook_url) {
      fbData = await fetchFacebook(company.facebook_url);
      enrichLog.facebook = {
        found:     !!fbData,
        category:  fbData?.category  || null,
        fan_count: fbData?.fan_count ?? null,
      };
    }

    // 2.5. LinkedIn — tylko gdy user wybrał tę opcję przy re-process (nigdy w batchu)
    let linkedinText = '';
    let resolvedLinkedinUrl = company.linkedin_url || null;
    let linkedinStatus = null;

    if (opts.processLinkedin) {
      const linkedinFound = await findLinkedinUrl(company);
      if (linkedinFound.url) {
        resolvedLinkedinUrl = linkedinFound.url;
        linkedinText = await scrapeLinkedin(resolvedLinkedinUrl);
        linkedinStatus = linkedinText.trim().length > 50 ? 'ok' : 'blocked';
        enrichLog.linkedin = {
          url:    resolvedLinkedinUrl,
          method: linkedinFound.method,
          chars:  linkedinText.length,
          status: linkedinStatus,
        };
      } else {
        linkedinStatus = 'not_found';
        enrichLog.linkedin = { url: null, method: 'none', status: 'not_found' };
      }
      // Zawsze zapisz URL i status gdy user jawnie zażądał przetworzenia LinkedIn
      await db.query(
        `UPDATE prospect_companies SET
           linkedin_url    = COALESCE($2, linkedin_url),
           linkedin_status = $3
         WHERE id = $1`,
        [prospectId, resolvedLinkedinUrl, linkedinStatus]
      );
    }

    // 3. Website URL — jeśli ustawiony ręcznie (przez użytkownika), pomiń odkrywanie
    // Normalizuj URL tutaj jako safety-net (dane ze starych importów mogą być nieznormalizowane)
    let websiteUrl, websiteMethod;
    if (company.website_url) {
      websiteUrl   = normalizeWebsiteUrl(company.website_url) || company.website_url;
      websiteMethod = 'manual';
      enrichLog.website = { url: websiteUrl, method: websiteMethod };
    } else {
      const found  = await findWebsiteUrl(
        company.company_name || krsData?.companyName,
        krsData?.krsWebsite
      );
      websiteUrl   = found.url;
      websiteMethod = found.method;
      enrichLog.website = { url: websiteUrl, method: websiteMethod };
    }

    // Wymaganie #2: bez URL strony WWW nie ma sensu kontynuować — chyba że mamy dane z LinkedIn
    let websiteStatus = null;

    if (opts.skipWebsite) {
      // URL się nie zmienił — pomijamy wyszukiwanie URL (DDG/Google/Bing), ale scraping i tak ruszy poniżej
      websiteUrl   = company.website_url ? (normalizeWebsiteUrl(company.website_url) || company.website_url) : null;
      websiteMethod = 'skip_url_resolution';
      enrichLog.website = { url: websiteUrl, method: 'skip_url_resolution' };
    } else {
      if (!websiteUrl) websiteStatus = 'not_found';

      if (!websiteUrl) {
        if (!linkedinText.trim()) {
          await db.query(
            `UPDATE prospect_companies SET
               enrichment_status = 'no_website',
               website_status    = 'not_found',
               enriched_at       = NOW(),
               enrichment_log    = $2
             WHERE id = $1`,
            [prospectId, JSON.stringify(enrichLog)]
          );
          logger.info('[Prospect] No website found — stopping enrichment', { prospectId });
          return { status: 'no_website', prospectId };
        }
        logger.info('[Prospect] No website but LinkedIn data available — continuing enrichment', { prospectId });
      }
    }

    // 3. Scraping — zawsze scrapuj gdy URL dostępny; skipWebsite pomija tylko wyszukiwanie URL
    let websiteText = '';
    let scrapedContacts = { emails: [], phones: [] };
    if (websiteUrl) {
      const scraped = await scrapeWebsite(websiteUrl);
      websiteText     = scraped.text;       // string — wszystkie sprawdzenia .trim()/.length niżej bez zmian
      scrapedContacts = scraped.contacts;
      enrichLog.website.chars_extracted = websiteText.length;
      enrichLog.website.pages_count = (websiteText.match(/^\[/gm) || []).length || 1;

      // Jeśli scraping nie zwrócił żadnej treści (timeout, 403, parking page itp.)
      // → kontynuuj z pustym tekstem jeśli mamy dane KRS lub LinkedIn
      // → zatrzymaj tylko gdy nie ma żadnych danych do analizy
      if (!websiteText.trim()) {
        // 'blocked' gdy URL znaleziony ale scraping zablokowany (Cloudflare/WAF); 'failed' gdy brak odpowiedzi
        websiteStatus = websiteUrl ? 'blocked' : 'failed';
        enrichLog.website.scrape_failed = true;
        if (!linkedinText.trim() && !krsData) {
          await db.query(
            `UPDATE prospect_companies SET
               enrichment_status = 'no_website',
               website_url       = COALESCE($3, website_url),
               website_status    = $4,
               enriched_at       = NOW(),
               enrichment_log    = $2
             WHERE id = $1`,
            [prospectId, JSON.stringify(enrichLog), websiteUrl, websiteStatus]
          );
          logger.info('[Prospect] Website scrape returned no content — stopping', { prospectId, websiteUrl });
          return { status: 'no_website', prospectId };
        }
        logger.info('[Prospect] Website scrape failed — continuing with KRS/LinkedIn data', { prospectId, websiteUrl, hasKrs: !!krsData, hasLinkedin: !!linkedinText.trim() });
      } else {
        websiteStatus = 'ok';
      }
    }

    // 4. AI analysis
    const { result: analysis, provider: usedProvider } = await analyzeWithAi(company, krsData, websiteText, fbData, linkedinText, gusData);

    // Oddziały: KRS ma priorytet (twarde dane), fallback = AI z analizy strony WWW
    const branchesCount = krsData?.branchesCount
      ?? (analysis?.branches_found?.count > 0 ? analysis.branches_found.count : null);
    const branchesScope = krsData?.branchesScope
      ?? analysis?.branches_found?.scope
      ?? null;

    const computedScore = calcTravelScore(analysis?.travel_signals, branchesCount, analysis?.travel_scope, !!websiteUrl, !!krsData, gusData);
    enrichLog.claude = {
      provider:         usedProvider,
      model:            usedProvider === 'anthropic' ? ANTHROPIC_MODEL : DEEPSEEK_MODEL,
      score:            computedScore,
      score_ai_raw:     analysis?.travel_potential_score ?? null,
      signal_reasoning: analysis?.signal_reasoning || null,
      branches_found:   analysis?.branches_found || null,
      branches_source:  krsData?.branchesCount != null ? 'krs' : (branchesCount ? 'web' : 'none'),
    };

    // 5. Zapis do DB
    const aiContacts  = Array.isArray(analysis?.key_contacts) ? analysis.key_contacts : [];
    const merged      = mergeContacts(aiContacts, scrapedContacts.emails, scrapedContacts.phones);
    const keyContacts = merged.length > 0 ? merged : null;

    await db.query(
      `UPDATE prospect_companies SET
        company_name           = COALESCE(company_name, $2),
        krs_number             = COALESCE($3, krs_number),
        legal_form             = $4,
        registered_address     = $5,
        registration_date      = $6,
        branches_count         = $7,
        branches_scope         = $8,
        krs_website            = $9,
        website_url            = $10,
        travel_potential_score = $11,
        travel_signals         = $12,
        travel_scope           = $13,
        field_teams_likely     = $14,
        ai_summary             = $15,
        key_contacts           = $16,
        enrichment_log         = $17,
        fb_about               = COALESCE($18, fb_about),
        fb_category            = COALESCE($19, fb_category),
        fb_fan_count           = COALESCE($20, fb_fan_count),
        linkedin_url           = COALESCE($21, linkedin_url),
        linkedin_status        = COALESCE($22, linkedin_status),
        website_status         = COALESCE($23, website_status),
        gus_regon              = COALESCE($24, gus_regon),
        gus_pkd_main           = COALESCE($25, gus_pkd_main),
        enriched_at            = NOW(),
        enrichment_status      = 'done',
        enrichment_error       = NULL
      WHERE id = $1`,
      [
        prospectId,
        krsData?.companyName || null,
        krsData?.krsNumber || null,
        krsData?.legalForm || null,
        krsData?.registeredAddress || null,
        parseKrsDate(krsData?.registrationDate) || null,
        branchesCount,
        branchesScope,
        krsData?.krsWebsite || null,
        websiteUrl || null,
        computedScore,
        analysis?.travel_signals ? JSON.stringify(analysis.travel_signals) : null,
        analysis?.travel_scope || null,
        analysis?.field_teams_likely ?? null,
        analysis?.ai_summary || null,
        keyContacts ? JSON.stringify(keyContacts) : null,
        JSON.stringify(enrichLog),
        fbData?.about || fbData?.description || null,
        fbData?.category || null,
        fbData?.fan_count ?? null,
        resolvedLinkedinUrl || null,
        linkedinStatus,
        websiteStatus,
        gusData?.regon || null,
        gusData?.pkdMain || null,
      ]
    );

    return { status: 'done', prospectId };
  } catch (err) {
    await db.query(
      `UPDATE prospect_companies SET
        enrichment_status = 'error',
        enrichment_error  = $2,
        enriched_at       = NOW()
      WHERE id = $1`,
      [prospectId, err.message?.slice(0, 500)]
    );
    const apiError = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : null;
    logger.warn('[Prospect] Enrichment error', { prospectId, error: err.message, apiError });
    return { status: 'error', prospectId, error: err.message };
  }
  } finally {
    currentlyProcessing.delete(prospectId);
  }
}

// ── Batch enrichment ────────────────────────────────────────────────

const BATCH_CONCURRENCY = 10;

// Stan batcha jest per-tenant (Map) — CRMtree jest multi-tenant, więc batch
// jednego klienta nie może blokować ani mieszać postępu z innym klientem.
// `currentlyProcessing` (globalny Set id) zostaje jako wewnętrzny guard przed
// podwójnym przetwarzaniem tego samego rekordu — id są globalnie unikalne.
const tenantBatches = new Map();

function getTenantBatchState(tenantId) {
  if (!tenantBatches.has(tenantId)) {
    tenantBatches.set(tenantId, {
      running: false,
      progress: { total: 0, done: 0, errors: 0, running: false },
      ownProcessing: new Set(),
    });
  }
  return tenantBatches.get(tenantId);
}

async function runBatch(tenantId, { onlyPending = true } = {}) {
  const state = getTenantBatchState(tenantId);
  if (state.running) return { alreadyRunning: true };
  state.running = true;

  try {
    const where = onlyPending
      ? `WHERE tenant_id = $1 AND enrichment_status IN ('pending', 'error')`
      : `WHERE tenant_id = $1 AND enrichment_status != 'done'`;

    const { rows } = await db.query(
      `SELECT id FROM prospect_companies ${where} ORDER BY imported_at ASC`,
      [tenantId]
    );

    const ids = rows.map(r => r.id);
    state.progress = { total: ids.length, done: 0, errors: 0, running: true };

    // Pula BATCH_CONCURRENCY równoległych workerów ciągnących z kolejki
    let idx = 0;
    const worker = async () => {
      while (idx < ids.length) {
        const id = ids[idx++];
        state.ownProcessing.add(id);
        try {
          const result = await enrichOne(id);
          if (result?.status === 'done') state.progress.done++;
          else state.progress.errors++;
        } catch (err) {
          logger.warn('[Prospect] enrichOne threw in batch', { id, error: err.message });
          state.progress.errors++;
          try {
            await db.query(
              `UPDATE prospect_companies SET enrichment_status='error', enrichment_error=$2 WHERE id=$1 AND tenant_id=$3`,
              [id, String(err.message).slice(0, 500), tenantId]
            );
          } catch { /* ignore */ }
        } finally {
          state.ownProcessing.delete(id);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, () => worker())
    );
  } finally {
    state.running = false;
    state.progress.running = false;
  }

  return state.progress;
}

// Wzbogaca jedną firmę w tle — może działać równolegle (max BATCH_CONCURRENCY jednocześnie)
// opts.processLinkedin = true → scrapuj LinkedIn (tylko dla ręcznego re-process, nigdy w batchu)
async function reEnrichOne(tenantId, prospectId, opts = {}) {
  if (currentlyProcessing.has(prospectId)) return; // już w toku

  const state = getTenantBatchState(tenantId);
  state.ownProcessing.add(prospectId);

  if (!state.running) {
    if (!state.progress.running) {
      state.progress = { total: 1, done: 0, errors: 0, running: true };
    } else {
      state.progress.total++;
    }
  }

  enrichOne(prospectId, opts)
    .then(result => {
      state.ownProcessing.delete(prospectId);
      if (!state.running) {
        if (result?.status === 'done') state.progress.done++;
        else state.progress.errors++;
        if (state.ownProcessing.size === 0) state.progress.running = false;
      }
    })
    .catch(err => {
      state.ownProcessing.delete(prospectId);
      logger.warn('[Prospect] reEnrichOne failed', { id: prospectId, error: err.message });
      if (!state.running) {
        state.progress.errors++;
        if (state.ownProcessing.size === 0) state.progress.running = false;
      }
    });
}

function getBatchProgress(tenantId) {
  const state = getTenantBatchState(tenantId);
  return {
    ...state.progress,
    running: state.running || state.ownProcessing.size > 0,
    processing_ids: [...state.ownProcessing],
  };
}

module.exports = { enrichOne, reEnrichOne, runBatch, getBatchProgress, buildPromptText };
