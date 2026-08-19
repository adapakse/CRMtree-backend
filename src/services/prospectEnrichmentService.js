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

// ── Sygnały ICP jako dane (decyzja 19.08.2026, artefakt "Sygnały Prospektów") ─
// Wagi: wysoka 10 pkt, średnia 5 pkt. Rozszerzone o 8 z 11 sygnałów artefaktu —
// sygnały 9-11 (rekrutacja/raportowanie/call center) wymagają portali z ofertami
// pracy (Pracuj.pl), nie są jeszcze podpięte, patrz pamięć projektu.
const ICP_SIGNALS = [
  { id: 'dzial_handlowy',        label: 'Dział handlowy',                                    tier: 'wysoka', points: 10, promptKey: 'field_sales_team' },
  { id: 'zlozony_proces_sprzedazy', label: 'Złożony proces sprzedaży / indywidualna wycena',  tier: 'wysoka', points: 10, promptKey: 'custom_quote_process' },
  { id: 'konsultacja_demo',      label: 'Konsultacja, demo lub analiza potrzeb',              tier: 'wysoka', points: 10, promptKey: 'consultation_demo_needs_analysis' },
  { id: 'opieka_nad_klientem',   label: 'Dedykowana opieka nad klientem B2B',                 tier: 'wysoka', points: 10, promptKey: 'dedicated_customer_care_b2b' },
  { id: 'przetargi',             label: 'Przetargi / dział ofertowania',                      tier: 'wysoka', points: 10, promptKey: 'tender_bidding_department' },
  { id: 'rozproszona_struktura', label: 'Rozproszona struktura sprzedaży / wiele oddziałów',  tier: 'srednia', points: 5,  promptKey: 'distributed_sales_structure' },
  { id: 'siec_partnerow',        label: 'Sieć partnerów / dealerów',                          tier: 'srednia', points: 5,  promptKey: 'partner_dealer_network' },
  {
    id: 'ecommerce_b2b', label: 'Sprzedaż e-commerce (B2B)', tier: 'srednia', points: 5, promptKey: 'ecommerce_b2b',
    // Liczy się TYLKO razem z "Dział handlowy" albo "Opieka nad klientem B2B" —
    // czysty samoobsługowy sklep bez ludzi po stronie sprzedaży sam w sobie
    // nie świadczy o potrzebie CRM.
    requiresAnyOf: ['dzial_handlowy', 'opieka_nad_klientem'],
  },
];
const ICP_MAX_RAW_SCORE = ICP_SIGNALS.reduce((sum, s) => sum + s.points, 0); // 65

// Bonusowe punkty (decyzja 19.08, potwierdzone na spotkaniu: 5 pkt za każdy) —
// wykrywane regexem po SUROWYM HTML strony głównej (script tagi), nie po
// oczyszczonym tekście — extractText() celowo usuwa <script>. Nie woła AI.
const ICP_BONUS_SIGNALS = [
  { id: 'whatsapp_business', label: 'WhatsApp Business (widget/link)', points: 5, pattern: /wa\.me\/|api\.whatsapp\.com|whatsapp[-_]?widget|wpwhatsapp|joinchat/i },
  { id: 'crm_sales_tool', label: 'CRM / narzędzie sprzedażowe wykryte na stronie', points: 5, pattern: /hs-scripts\.com|hs-analytics|hubspot|pipedrive|zoho(?:public|crm)?\.com|salesforce|widget\.intercom\.io|cdn\.livechatinc\.com|code\.tidio\.co|freshchat|js\.driftt\.com/i },
];

function calcIcpBonus(html) {
  const breakdown = [];
  let bonus = 0;
  for (const sig of ICP_BONUS_SIGNALS) {
    const hit = !!html && sig.pattern.test(html);
    if (hit) bonus += sig.points;
    breakdown.push({ id: sig.id, label: sig.label, points: sig.points, hit });
  }
  return { bonus, breakdown };
}

// Bramki (decyzja 19.08): "pass" na obu wymagany do kwalifikacji. "unknown"
// NIE dyskwalifikuje — trafia do ręcznego przeglądu, nie jest cicho wyrzucane.
function icpGateStatus(gates) {
  if (!gates) return 'needs_review';
  if (gates.b2b === 'fail' || gates.company_size === 'fail') return 'disqualified';
  if (gates.b2b === 'pass' && gates.company_size === 'pass') return 'qualified';
  return 'needs_review';
}

// Kalkuluje icp_score deterministycznie z sygnałów zwróconych przez AI —
// nie ufamy score'owi liczonemu przez sam model, tak jak poprzednio.
function calcIcpScore(signals) {
  const rawHits = {};
  for (const sig of ICP_SIGNALS) rawHits[sig.id] = !!signals?.[sig.promptKey];

  let raw = 0;
  const breakdown = [];
  for (const sig of ICP_SIGNALS) {
    let hit = rawHits[sig.id];
    let suppressed = false;
    if (hit && sig.requiresAnyOf && !sig.requiresAnyOf.some(depId => rawHits[depId])) {
      hit = false;
      suppressed = true;
    }
    if (hit) raw += sig.points;
    breakdown.push({ id: sig.id, label: sig.label, tier: sig.tier, points: sig.points, hit, suppressed });
  }
  return { raw, capped: Math.min(100, raw), maxPossible: ICP_MAX_RAW_SCORE, breakdown };
}

// Miękkie obniżenia priorytetu (decyzja 19.08) — NIE dyskwalifikują firmy.
// Tylko dwa z czterech ustalonych na spotkaniu (brak https, martwa strona) —
// tanie, wynikają z danych które i tak już mamy. Podmiot publiczny i świeże
// duże wdrożenie wymagałyby nowego sygnału ocenianego przez AI — pominięte
// świadomie na tym etapie.
function calcIcpDowngradeFlags(websiteUrl, websiteStatus) {
  const flags = [];
  if (websiteUrl && !/^https:\/\//i.test(websiteUrl)) {
    flags.push({ id: 'brak_https', label: 'Strona bez https' });
  }
  if (!websiteUrl || websiteStatus === 'blocked' || websiteStatus === 'failed' || websiteStatus === 'not_found') {
    flags.push({ id: 'martwa_strona', label: 'Nie znaleziono/nie udało się wczytać strony' });
  }
  return flags;
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
const SYSTEM_PROMPT = `Jesteś analitykiem oceniającym, czy firma B2B pasuje do profilu klienta systemu CRM
(CRMtree) — firmy z formalnym działem handlowym i złożonym, relacyjnym procesem sprzedaży,
nie sklepu samoobsługowego czy zakupu impulsowego.

═══════════════════════════════════════
ZASADA GŁÓWNA: każdy sygnał potrzebuje KONKRETNEGO DOWODU z treści poniżej — nie zgaduj
na podstawie samej branży czy wielkości firmy. Przy każdym sygnale rozróżniamy:
  • GŁÓWNY DOWÓD — wystarcza sam, żeby ustawić true.
  • DRUGORZĘDNE WSPARCIE — NIE wystarcza samo, potrzebuje głównego dowodu obok siebie,
    inaczej sygnał to false (np. sam brak cennika bez frazy CTA to za mało).
Jeśli dowodu brak: bramki → "unknown", sygnały → false. Nie zgaduj w żadną stronę.
═══════════════════════════════════════

BRAMKI (status: "pass" / "fail" / "unknown") — sprawdzane przed sygnałami, bez PASS na obu
firma się nie kwalifikuje niezależnie od liczby trafionych sygnałów:

b2b: sprzedaż firma → firma, nie do konsumenta.
  Główny dowód: wprost opisana obsługa firm/klientów biznesowych — "dla firm", "dla biznesu",
  "klienci biznesowi", "sprzedaż hurtowa", "oferta B2B".
  Drugorzędne wsparcie (nie wystarcza samo): NIP przy zamówieniu, brak cennika detalicznego
  — zwykły sklep D2C też wystawia faktury firmom.

company_size: minimum 15 pracowników. Użyj DANYCH HANDLOWYCH Z BAZY KLIENTA (zatrudnienie)
  jeśli podane — to twarde dane, nie zgaduj z treści strony. Jeśli brak takich danych,
  zwróć "unknown".

═══════════════════════════════════════
SYGNAŁY (true/false) — każdy z nich to niezależne dopasowanie strukturalne (FIT) do
profilu CRMtree, nie sygnał "dobrego momentu":

field_sales_team ("Dział handlowy"):
  Główny dowód: podstrona zespołu/kontaktu z konkretnymi handlowcami, lub wprost
  "dział handlowy"/formalna struktura organizacyjna sprzedaży.
  Drugorzędne wsparcie: sam adres sprzedaz@ — może być zwykłą skrzynką ogólną.

custom_quote_process ("Złożony proces sprzedaży / indywidualna wycena"):
  Relacyjny, projektowy lub negocjacyjny model, nie zakup impulsowy.
  Główny dowód: fraza CTA — "zapytaj o ofertę", "poproś o wycenę", "indywidualna oferta",
  "przygotujemy ofertę", "skontaktuj się z handlowcem".
  Drugorzędne wsparcie: sam brak jawnego cennika bez takiej frazy.

consultation_demo_needs_analysis ("Konsultacja, demo lub analiza potrzeb"):
  Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy
  z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach).
  Główny dowód: "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania".
  Jeśli to ten sam fragment tekstu co dowód dla custom_quote_process, oceń oba sygnały
  niezależnie, ale nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów.

distributed_sales_structure ("Rozproszona struktura sprzedaży / wiele oddziałów"):
  Zespół lub sieć sprzedaży fizycznie rozproszona terytorialnie.
  Główny dowód: konkretni przedstawiciele/oddziały z przypisanymi ludźmi.
  Drugorzędne wsparcie: jednostka lokalna w KRS bez przypisanych osób (może być zwykłym
  magazynem), wersja językowa strony (może być grzecznością wobec klienta zagranicznego).

ecommerce_b2b ("Sprzedaż e-commerce (B2B)"):
  Sklep/platforma zamówieniowa w domenie firmy z realną obsługą B2B, nie czysty
  samoobsługowy self-service bez ludzi po stronie sprzedaży.
  Główny dowód: sklep lub panel klienta B2B w domenie firmy.

dedicated_customer_care_b2b ("Dedykowana opieka nad klientem B2B"):
  Dedykowany zespół posprzedażowy, ew. przypisany opiekun.
  Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager",
  "Customer Success", "obsługa posprzedażowa", "odnowienia umów", "stała opieka nad klientem".
  Drugorzędne wsparcie: samo słowo "BOK" lub sama infolinia — może prowadzić do jednej
  osoby lub zwykłego wsparcia technicznego, nie relacyjnej opieki.

partner_dealer_network ("Sieć partnerów / dealerów"):
  Firma buduje lub rozwija sieć sprzedaży pośredniej.
  Główny dowód: "zostań partnerem", "sieć dealerska", "dla dystrybutorów", "strefa partnera"
  w domenie firmy.

tender_bidding_department ("Przetargi / dział ofertowania"):
  Firma SPRZEDAJE w przetargach — UWAGA, częsta pomyłka w drugą stronę:
  Dowód pozytywny (true): "realizujemy zamówienia publiczne", "oferta dla sektora
  publicznego", "doświadczenie w przetargach", "zrealizowane zamówienia",
  "specjalista ds. przetargów/ofertowania", referencje od instytucji publicznych.
  NIE liczy się, nawet jeśli słowo "przetarg" występuje (to firma KUPUJĄCA, zwróć false):
  "postępowania zakupowe", "zamówienia dla dostawców", "przetargi organizowane przez nas",
  "profil nabywcy".

═══════════════════════════════════════
Zwróć odpowiedź WYŁĄCZNIE jako JSON (bez markdown, bez \`\`\`):
{
  "gates": {
    "b2b": "pass|fail|unknown",
    "company_size": "pass|fail|unknown"
  },
  "icp_signals": {
    "field_sales_team": <true|false>,
    "custom_quote_process": <true|false>,
    "consultation_demo_needs_analysis": <true|false>,
    "distributed_sales_structure": <true|false>,
    "ecommerce_b2b": <true|false>,
    "dedicated_customer_care_b2b": <true|false>,
    "partner_dealer_network": <true|false>,
    "tender_bidding_department": <true|false>
  },
  "ai_summary": "<2-3 zdania po polsku: DLACZEGO ta firma pasuje lub nie pasuje do CRMtree, jakie konkretne cechy na to wskazują>",
  "signal_reasoning": {
    "field_sales_team": "<max 10 słów>",
    "custom_quote_process": "<max 10 słów>",
    "consultation_demo_needs_analysis": "<max 10 słów>",
    "distributed_sales_structure": "<max 10 słów>",
    "ecommerce_b2b": "<max 10 słów>",
    "dedicated_customer_care_b2b": "<max 10 słów>",
    "partner_dealer_network": "<max 10 słów>",
    "tender_bidding_department": "<max 10 słów>"
  },
  "key_contacts": [
    {"name": "<imię nazwisko>", "title": "<stanowisko>", "email": "<email lub null>", "phone": "<telefon lub null>"}
  ]
}

Dla key_contacts: wypełnij tylko pola których jesteś pewien. Puste pole → null. Max 8 osób.`;


function buildUserMessage(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
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

  // Ręcznie wklejony link do ofert pracy firmy (Pracuj.pl) — kontekst
  // wspierający sygnały wymagające dowodu z ofert (np. dział handlowy,
  // rekrutacja) tam, gdzie strona firmy sama tego nie pokazuje.
  const pracujSection = pracujText
    ? `\nOFERTY PRACY FIRMY (Pracuj.pl, link wklejony ręcznie):\n${pracujText.slice(0, 1500)}`
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

${websiteText ? `TREŚĆ ZE STRONY WWW:\n${websiteText}` : 'Strona WWW niedostępna — opieraj się na danych rejestrowych i handlowych.'}${fbSection}${linkedinSection}${pracujSection}${gusSection}`;
}

// Połączony prompt (dla endpointu inspekcji /prompt)
function buildPromptText(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
  return `${SYSTEM_PROMPT}\n\n${buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText)}`;
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

async function analyzeWithAi(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'prospect.ai_provider' AND tenant_id = $1`,
    [company.tenant_id]
  );
  const provider = rows[0]?.value || 'deepseek';

  const userMessage = buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText);
  const raw = provider === 'anthropic'
    ? await callAnthropic(userMessage)
    : await callDeepSeek(userMessage);

  logger.info('[Prospect] AI raw response', { provider, company: company.company_name, rawLength: raw.length, rawPreview: raw.slice(0, 500) });

  try {
    const parsed = JSON.parse(raw);
    logger.info('[Prospect] AI parse OK', { provider, company: company.company_name, signals: parsed.icp_signals, summary: parsed.ai_summary?.slice(0, 80) });
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
      logger.info('[Prospect] AI parse OK (regex fallback)', { provider, company: company.company_name, signals: parsed.icp_signals });
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

    // 2.6. Pracuj.pl — decyzja 19.08: automatyczne wyszukiwanie ofert po nazwie
    // firmy nie działa niezawodnie (Pracuj.pl nie ma filtra po pracodawcy w
    // publicznym wyszukiwaniu), więc user wkleja link ręcznie przy re-process —
    // tu tylko pobieramy treść tego już znanego, konkretnego URL-a. Tylko przy
    // ręcznym re-process (jak LinkedIn), nigdy w batchu.
    let pracujText = '';
    if (opts.processPracuj && company.pracuj_url) {
      let pracujStatus = 'not_found';
      try {
        const { html } = await fetchPage(company.pracuj_url);
        pracujText = html ? extractText(cheerio.load(html)) : '';
        pracujStatus = pracujText.trim().length > 50 ? 'ok' : 'not_found';
        enrichLog.pracuj = { url: company.pracuj_url, chars: pracujText.length, status: pracujStatus };
      } catch (pracujErr) {
        enrichLog.pracuj = { url: company.pracuj_url, status: 'not_found', error: pracujErr.message };
      }
      await db.query(
        `UPDATE prospect_companies SET pracuj_status = $2 WHERE id = $1`,
        [prospectId, pracujStatus]
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
    const { result: analysis, provider: usedProvider } = await analyzeWithAi(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText);

    // Oddziały: tylko z KRS (twarde dane) — nowy prompt ICP nie zwraca już
    // branches_found (to była część starego travel-scoringu).
    const branchesCount = krsData?.branchesCount ?? null;
    const branchesScope = krsData?.branchesScope ?? null;

    const scoreResult   = calcIcpScore(analysis?.icp_signals);
    const gateStatus    = icpGateStatus(analysis?.gates);
    const downgradeFlags = calcIcpDowngradeFlags(websiteUrl, websiteStatus);

    // Bonus (WhatsApp/CRM wykryty) potrzebuje SUROWEGO HTML strony głównej
    // (script tagi) — scrapeWebsite() zwraca już oczyszczony tekst, więc to
    // osobne, dodatkowe pobranie. Błąd tego kroku nie może wywalić enrichmentu.
    let bonusResult = { bonus: 0, breakdown: [] };
    if (websiteUrl) {
      try {
        const { html: homepageHtml } = await fetchPage(websiteUrl);
        bonusResult = calcIcpBonus(homepageHtml);
      } catch { /* bonus to dodatek, nie krytyczne jeśli się nie uda */ }
    }

    const totalScore = Math.min(100, scoreResult.raw + bonusResult.bonus);

    enrichLog.claude = {
      provider:     usedProvider,
      model:        usedProvider === 'anthropic' ? ANTHROPIC_MODEL : DEEPSEEK_MODEL,
      icp_raw:      scoreResult.raw,
      icp_bonus:    bonusResult.bonus,
      icp_total:    totalScore,
      gate_status:  gateStatus,
      signal_reasoning: analysis?.signal_reasoning || null,
    };

    // 5. Zapis do DB
    const aiContacts  = Array.isArray(analysis?.key_contacts) ? analysis.key_contacts : [];
    const merged      = mergeContacts(aiContacts, scrapedContacts.emails, scrapedContacts.phones);
    const keyContacts = merged.length > 0 ? merged : null;

    await db.query(
      `UPDATE prospect_companies SET
        company_name           = COALESCE(company_name, $2),
        krs_number              = COALESCE($3, krs_number),
        legal_form               = $4,
        registered_address       = $5,
        registration_date        = $6,
        branches_count           = $7,
        branches_scope           = $8,
        krs_website              = $9,
        website_url              = $10,
        icp_score                = $11,
        icp_signals               = $12,
        icp_gates                 = $13,
        icp_gate_status           = $14,
        icp_bonus_signals         = $15,
        icp_downgrade_flags       = $16,
        ai_summary                = $17,
        key_contacts              = $18,
        enrichment_log            = $19,
        fb_about                  = COALESCE($20, fb_about),
        fb_category               = COALESCE($21, fb_category),
        fb_fan_count              = COALESCE($22, fb_fan_count),
        linkedin_url              = COALESCE($23, linkedin_url),
        linkedin_status           = COALESCE($24, linkedin_status),
        website_status            = COALESCE($25, website_status),
        gus_regon                 = COALESCE($26, gus_regon),
        gus_pkd_main              = COALESCE($27, gus_pkd_main),
        enriched_at               = NOW(),
        enrichment_status         = 'done',
        enrichment_error          = NULL
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
        totalScore,
        JSON.stringify(scoreResult.breakdown),
        analysis?.gates ? JSON.stringify(analysis.gates) : null,
        gateStatus,
        JSON.stringify(bonusResult.breakdown),
        JSON.stringify(downgradeFlags),
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
