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
  // Dodane po audycie menu na 100 firmach (19.08) — "partnerzy" to bezpośredni
  // dowód sygnału ICP "Sieć partnerów / dealerów", dziś w ogóle nierozpoznawany.
  { pattern: /partner[zy]|dealer|dystrybutor|distributor/i, score: 8 },
  // "realizacje"/"referencje" — dowody projektowe, wspierają sygnały przetargów
  // i złożonej sprzedaży (case studies, referencje od klientów/instytucji).
  { pattern: /realizacj|referencj|case.stud/i, score: 6 },
  // Sklep/e-commerce B2B i zapytania ofertowe (RFQ) — dodane po korektach
  // 20.08 (Wagner-service "Sklep internetowy" i Kigema "zapytanie ofertowe"
  // nigdy nie trafiały do kandydatów, bo nie było dla nich żadnego wzorca).
  { pattern: /sklep|shop|e-?commerce|portal.?b2b|konto.?klient|koszyk|checkout|zapytani\w*.?ofert|request.?for.?quot|\brfq\b/i, score: 8 },
  // Strony opisujące szczegółowy proces obsługi/certyfikacji/akredytacji —
  // dotąd nierozpoznawane żadnym wzorcem (case: Inova — "Certyfikacja
  // wyrobów", opis wstępnej rozmowy o wymaganiach/dokumentacji/opłatach,
  // score=0 → link filtrowany PRZED dotarciem do budżetu treści, mimo że
  // był na homepage z anchorem "Biuro Certyfikacji Wyrobów").
  { pattern: /certyfikacj|akredytacj|procedura|zasady.wsp[oó]lpracy|jak.to.dziala|jak.dzia[lł]a|krok.po.kroku/i, score: 8 },
];

// ── Helpers ────────────────────────────────────────────────────────

function normalizeNip(nip) {
  return String(nip || '').replace(/\D/g, '');
}

// Szuka 10 cyfr NIP-u faktycznie występujących razem w tekście (dopuszczając
// typowe separatory: spacja/myślnik/kropka), np. "766-000-65-67". NIE sklejamy
// wszystkich cyfr strony w jeden ciąg do wyszukania podciągu — na dużej stronie
// (dużo telefonów/cen/dat) to dawało fałszywe trafienia w testach.
function nipFoundInText(nip, text) {
  const normalizedNip = normalizeNip(nip);
  if (normalizedNip.length !== 10 || !text) return false;
  const nipPattern = normalizedNip.split('').join('[\\s.-]?');
  return new RegExp(nipPattern).test(text);
}

// KRS/REGON to gołe ciągi cyfr — bez etykiety w pobliżu łatwo o fałszywe
// trafienie (numer telefonu, kod produktu, rok+coś). Wymagamy słowa
// "KRS"/"REGON" w promieniu ~30 znaków PRZED znalezionym numerem (decyzja
// 20.08, twardsza weryfikacja po regresji KZN/Wagner-service).
function krsFoundInText(krsNumber, text) {
  const digits = String(krsNumber || '').replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 6 || !text) return false; // KRS ma 10 cyfr, ale wiodące zera bywają pomijane w treści
  const pattern = digits.split('').join('[\\s.-]?');
  return new RegExp(`krs[^\\d]{0,30}0*${pattern}`, 'i').test(text);
}

function regonFoundInText(regon, text) {
  const digits = String(regon || '').replace(/\D/g, '');
  if ((digits.length !== 9 && digits.length !== 14) || !text) return false;
  const pattern = digits.split('').join('[\\s.-]?');
  return new RegExp(`regon[^\\d]{0,30}${pattern}`, 'i').test(text);
}

// ── Weryfikacja tożsamości domeny — drugi poziom, gdy NIP/KRS/REGON nie ──
// występują w tekście (decyzja 20.08, po odkryciu że 7/13 sprawdzonych
// POPRAWNYCH domen w ogóle nie publikuje NIP-u na stronie marketingowej —
// samo rozszerzenie nipFoundInText nie wystarczało). Wymagamy DWÓCH
// niezależnych sygnałów: dopasowania nazwy w title/h1 ORAZ dokładnego
// elementu adresu (ulica lub kod pocztowy) **pochodzącego z danych
// rejestrowych KRS**, znalezionego w treści strony. Samo miasto NIE
// wystarcza (decyzja 20.08, druga tura twardnienia — KZN→kolejowe.edu.pl i
// Wagner-service→wagnerservice.pl obie leżą w tym samym mieście co
// prawdziwa firma i przechodziły samym dopasowaniem nazwa+miasto). Sama
// nazwa też NIE wystarcza — zagraniczna firma o tej samej nazwie (Mirol
// S.A., Argentyna) przeszłaby samym dopasowaniem nazwy. Zagraniczny adres
// w bloku kontaktowym to dowód NEGATYWNY, dyskwalifikujący nawet przy
// trafionej nazwie.
const FOREIGN_COUNTRY_HINTS = /\b(argentina|buenos aires|c[oó]rdoba|deutschland|germany|gmbh|stra[sß]e|osterreich|austria|schweiz|switzerland|united states|\busa\b|united kingdom|france|espa[nñ]a|italia|italy)\b/i;

// Wyciąga kod pocztowy i nazwę ulicy z KRS-owego registeredAddress
// (`[ulica, nrDomu, miejscowosc, kodPocztowy].join(', ')` — patrz fetchKRS).
// To jest jedyne dopuszczalne źródło "prawdy" dla adresu z KRS — NIE
// zgadujemy adresu z danych CSV/importu, tylko z oficjalnego rejestru.
function extractAddressGroundTruth(registeredAddress) {
  if (!registeredAddress) return { postcode: null, street: null };
  const postcodeMatch = registeredAddress.match(/\b\d{2}-\d{3}\b/);
  const firstPart = registeredAddress.split(',')[0].trim();
  // "ul./al./pl." to szum przy dopasowaniu tekstowym — zostaw samą nazwę.
  const street = firstPart.replace(/^(ul\.|al\.|pl\.|ulica|aleja|plac)\s*/i, '').trim();
  return {
    postcode: postcodeMatch ? postcodeMatch[0] : null,
    street: street.length >= 4 ? street : null,
  };
}

// Drugie, niezależne źródło twardego adresu rejestrowego: GUS REGON BIR1.1
// (decyzja 20.08, druga tura hardeningu). W praktyce jedyne REALNIE
// działające źródło — KRS API (ms.gov.pl) używane przez fetchKRS() jest
// obecnie niedostępne dla lookupu po samym NIP (findKrsNumberByNip to
// świadomy no-op, legacy endpoint zwraca 400, patrz komentarz przy
// findKrsNumberByNip) i zwraca dane tylko gdy prospect ma ręcznie/z CSV
// podany krs_number. Bez tej zmiany identitySecondarySignal nigdy by nie
// znalazł adresu dla firm bez krs_number w bazie — a to była większość
// sprawdzanych rekordów (Berlinerluft, B2 Studio, KZN, Wagner-service...).
function extractGusAddressGroundTruth(gusData) {
  if (!gusData) return { postcode: null, street: null };
  const postcode = gusData.postcode && /^\d{2}-\d{3}$/.test(gusData.postcode) ? gusData.postcode : null;
  const street = gusData.street && gusData.street.length >= 4 ? gusData.street : null;
  return { postcode, street };
}

// Blok kontaktowy/stopka — jedyne miejsce, gdzie zagraniczny adres liczy się
// jako dowód NEGATYWNY (decyzja 20.08, po regresji Berlinerluft: polska
// spółka-córka wspominająca w treści niemiecką spółkę-matkę GmbH była błędnie
// blokowana, bo poprzednia wersja skanowała CAŁY tekst pod kątem
// FOREIGN_COUNTRY_HINTS — samo wystąpienie "GmbH" w opisie grupy kapitałowej
// wystarczało do odrzucenia poprawnej domeny). Ograniczamy skan do fragmentu
// wokół danych kontaktowych tej firmy (adres/siedziba/kontakt), nie całej strony.
function extractContactBlockText(text) {
  if (!text) return '';
  const markers = /(kontakt|siedziba|adres|nasz adres|dane (?:firmy|rejestrowe)|dane kontaktowe)/gi;
  const blocks = [];
  let m;
  while ((m = markers.exec(text))) {
    blocks.push(text.slice(m.index, m.index + 300));
  }
  return blocks.join(' ');
}

// Dopasowuje najbardziej charakterystyczne (pierwsze) słowo nazwy firmy do
// title/h1 strony — ten sam wzorzec "pierwsze słowo = człon marki" co
// guessDomainsFromName() używa do zgadywania domen.
function nameTokensMatch(companyName, titleText) {
  if (!companyName || !titleText) return false;
  const norm  = normalizeName(companyName);
  const words = norm.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!words.length) return false;
  const firstWord  = words[0];
  const titleNorm  = normalizeName(titleText);
  return titleNorm.includes(firstWord);
}

// Drugi, niezależny od nazwy sygnał tożsamości — TYLKO dane z oficjalnego
// rejestru KRS (ulica/kod pocztowy z registeredAddress), nigdy samo miasto
// (decyzja 20.08, druga tura: miasto samo w sobie nie odróżnia prawdziwej
// firmy od innej instytucji w tym samym mieście — patrz KZN/Wagner-service).
function identitySecondarySignal(text, { krsData, gusData }) {
  if (!text) return { positive: false, negative: false };
  const fromKrs = extractAddressGroundTruth(krsData?.registeredAddress);
  const fromGus = extractGusAddressGroundTruth(gusData);
  const postcode = fromKrs.postcode || fromGus.postcode;
  const street   = fromKrs.street   || fromGus.street;
  const postcodeHit = !!postcode && text.includes(postcode);
  const streetHit   = !!street &&
    new RegExp(`\\b${street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  // Zagraniczny adres liczy się jako negatywny TYLKO gdy pojawia się w bloku
  // kontaktowym/adresowym tej firmy — nie gdy strona po prostu WSPOMINA
  // zagraniczną spółkę-matkę/grupę kapitałową w treści opisowej (regresja
  // Berlinerluft 20.08: polska spółka-córka opisująca niemiecki koncern-matkę
  // była błędnie odrzucana).
  const foreignHit = FOREIGN_COUNTRY_HINTS.test(extractContactBlockText(text));
  // Obcy adres NIE liczy się jako konflikt, jeśli w tym samym tekście jest
  // TAKŻE własny, lokalny adres firmy (postcode LUB street z KRS/GUS) —
  // typowy przypadek: polska spółka-córka wymienia obok siebie swój adres
  // ORAZ adres zagranicznej centrali/oddziału (case: Cartonplast Polska →
  // cartonplast.com, stopka z niemiecką centralą Cartonplast Group GmbH obok
  // poprawnego polskiego adresu). Gdy lokalnego adresu brak, obcy trop nadal
  // sam wystarcza do odrzucenia (case: Mirol sp. z o.o.→mirol.com/Argentyna,
  // IMW Inżynieria Maszyn Wałcz→deckert.de — tam nie ma żadnego lokalnego
  // dopasowania obok obcego, więc weto zostaje).
  const negative = foreignHit && !(postcodeHit || streetHit);
  return { positive: !!(postcodeHit || streetHit), negative, postcodeHit, streetHit, foreignHit };
}

// Decyduje czy domena (zgadnięta/wyszukana LUB ręcznie podana z CSV, gdy
// wywołana z tego kontekstu) faktycznie należy do analizowanej firmy.
//
// Mocny dowód (wystarcza sam): NIP, KRS lub REGON znalezione w treści strony.
// Słaby dowód (wymaga OBU): nazwa w title/h1 ORAZ dokładny element adresu
// (ulica/kod pocztowy) z danych rejestrowych KRS lub GUS. Samo miasto nie wystarcza.
function checkDomainIdentity({ nip, text, title, company, krsData, gusData }) {
  const nipMatch   = nipFoundInText(nip, text);
  const krsMatch   = krsFoundInText(krsData?.krsNumber, text);
  const regonMatch = regonFoundInText(gusData?.regon, text);
  const nameHit    = nameTokensMatch(company.company_name, title);
  const secondary  = identitySecondarySignal(text, { krsData, gusData });

  // Diagnostyka (decyzja 20.08) — obliczana ZAWSZE, niezależnie od tego,
  // która gałąź niżej decyduje o wyniku, żeby enrichLog.website.identity_check
  // pokazywał pełny obraz (NIP/KRS/REGON/nazwa/adres/konflikt) nawet gdy
  // trafienie było na mocnym dowodzie (nip/krs/regon), gdzie wcześniej te pola
  // w ogóle się nie liczyły. Sama kolejność i progi weryfikacji niżej — bez zmian.
  const fromKrs = extractAddressGroundTruth(krsData?.registeredAddress);
  const fromGus = extractGusAddressGroundTruth(gusData);
  const evidence = {
    nip_checked:      normalizeNip(nip) || null,
    nip_match:        nipMatch,
    krs_checked:      krsData?.krsNumber || null,
    krs_match:        krsMatch,
    regon_checked:    gusData?.regon || null,
    regon_match:      regonMatch,
    company_name:     company.company_name || null,
    title_h1:         title || null,
    name_hit:         nameHit,
    address_postcode: fromKrs.postcode || fromGus.postcode || null,
    address_street:   fromKrs.street   || fromGus.street   || null,
    postcode_hit:     secondary.postcodeHit,
    street_hit:       secondary.streetHit,
    foreign_conflict: secondary.foreignHit,
  };

  if (nipMatch)   return { verified: true, reason: 'nip_match', evidence };
  if (krsMatch)   return { verified: true, reason: 'krs_match', evidence };
  if (regonMatch) return { verified: true, reason: 'regon_match', evidence };
  if (secondary.negative) return { verified: false, reason: 'foreign_address_conflict', nameHit, secondary, evidence };
  if (nameHit && secondary.positive) return { verified: true, reason: 'name_plus_registry_address', nameHit, secondary, evidence };
  return { verified: false, reason: 'insufficient_evidence', nameHit, secondary, evidence };
}

// Wykrywa strony-parkingi/domeny-na-sprzedaż — te zwracają HTTP 200 (więc nie
// łapie ich odrzucanie 404), ale treść nie ma nic wspólnego z firmą (case: IMW
// Inżynieria Maszyn Wałcz → imw.pl, giełda domen). Sprawdzane na surowym HTML
// strony głównej PRZED zaufaniem domenie.
// Rozszerzone 20.08 (druga tura) po tym jak imw.pl przeszedł niezauważony:
// przekierowuje na premium.pl (polska giełda domen), treść zawiera "oferta
// sprzedaży domeny"/"dzierżawa domeny", żadna z nich nie była wcześniej
// łapana. Dodane też ogólne "gie[lł]da domen" i "aftermarket" (częste u
// polskich pośredników sprzedaży domen).
const DOMAIN_PARKING_HINTS = /domain (?:is )?for sale|this domain is parked|buy this domain|domena (?:jest )?na sprzeda[zż]|kup t[eę] domen[eę]|domena wystawiona na sprzeda[zż]|ofert[ay] sprzeda[zż]y domen|dzier[zż]awa domen|gie[lł]da domen|park(?:owana|ing) domen|sedoparking|dan\.com|godaddy.{0,20}(?:auction|park)|bodis\.com|afternic|aftermarket/i;

// Znane hosty giełd/parkingów domen — sprawdzane na FINALNYM (po redirectach)
// hostname, niezależnie od treści (case: imw.pl → 301 → premium.pl/imw.pl,
// treść samej strony mogłaby się zmienić, host marketplace'u nie).
const KNOWN_DOMAIN_MARKETPLACE_HOSTS = /(^|\.)(sedo\.com|dan\.com|afternic\.com|bodis\.com|premium\.pl|aftermarket\.pl|domeny\.pl|oxydomains\.com|godaddy\.com)$/i;

function isDomainMarketplaceHost(hostname) {
  return !!hostname && KNOWN_DOMAIN_MARKETPLACE_HOSTS.test(hostname);
}

function isDomainParkingPage(html) {
  return !!html && DOMAIN_PARKING_HINTS.test(html.slice(0, 20_000));
}

// Błędy fetcha uznawane za DETERMINISTYCZNE — nie znikną przy ponownej próbie
// tego samego URL-a (błędny/niepasujący certyfikat TLS, błąd rozwiązywania
// DNS). Odróżnione od transientnych (timeout, throttling, 5xx), dla których
// retry ma sens (patrz fetchPageForCrawl). Używane w enrichOne: skan
// dwustopniowy nie eskaluje fast→full po takim błędzie, bo pełny crawl
// zawiódłby identycznie (case: 2026-08-20, peter-schmidt.com.pl — cert
// wystawiony dla home.pl, monipol.pl — strona-parking; oba eskalowały do
// pełnego crawlu mimo że wynik nie mógł się zmienić).
const DETERMINISTIC_FETCH_ERROR = /certificate|altnames|ERR_TLS|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF|SELF_SIGNED|ENOTFOUND|EAI_AGAIN/i;

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
function calcIcpDowngradeFlags(websiteUrl, websiteStatus, identityUnconfirmed = false) {
  const flags = [];
  if (websiteUrl && !/^https:\/\//i.test(websiteUrl)) {
    flags.push({ id: 'brak_https', label: 'Strona bez https' });
  }
  if (!websiteUrl || websiteStatus === 'blocked' || websiteStatus === 'failed' || websiteStatus === 'not_found') {
    flags.push({ id: 'martwa_strona', label: 'Nie znaleziono/nie udało się wczytać strony' });
  }
  if (identityUnconfirmed) {
    flags.push({ id: 'domena_niepotwierdzona', label: 'Nie potwierdzono, że to strona tej firmy (NIP/nazwa nie znalezione)' });
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

  // Legacy endpoint podmiot?nip= pomijany celowo (decyzja 20.08, przyspieszenie
  // enrichmentu) — zwraca 400 dla KAŻDEGO NIP-u od 2026-07 (patrz komentarz przy
  // findKrsNumberByNip), więc to zapytanie nigdy nie zwraca danych, tylko kosztuje
  // czas. Jeśli MS kiedyś naprawi endpoint, workaround pozostaje: ręcznie podany
  // krs_number w bazie (patrz pętla wyżej z krsNumer).
  logger.info('[Prospect] KRS not found for NIP (legacy endpoint skipped — known broken)', { nip: n });
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

// ── Fallback drugiej domeny — uruchamiany WYŁĄCZNIE po odrzuceniu pierwszej ──
// (decyzja 21.08, audyt 24 firm bez poprawnie znalezionej strony — patrz
// prospekty-29-firm-bez-strony-do-rewalidacji.md). Bez tego fallbacku resolver
// po odrzuceniu websiteUrl przez checkDomainIdentity nie miał żadnej drugiej
// próby — kolejny przebieg dawał dokładnie ten sam wynik (guessDomainsFromName/
// verifyFirstOf są deterministyczne: pierwszy odpowiadający kandydat zawsze ten
// sam). Dodatkowy problem guessDomainsFromName(): firstWord to surowe pierwsze
// słowo znormalizowanej nazwy, WŁĄCZNIE z opisowymi członami — dwie różne firmy
// zaczynające się od "Przedsiębiorstwo..." dostają identyczną (błędną)
// propozycję domeny (case: Fortech i Zetpri-Rembud w audycie 21.08, obie
// wylądowały na przedsiebiorstwo.com.pl). GENERIC_NAME_WORDS pomija te opisowe/
// prawne/spójnikowe człony, żeby zostały tylko znaczące słowa marki.
const GENERIC_NAME_WORDS = new Set([
  'przedsiebiorstwo', 'osrodek', 'rozlewnia', 'centrum', 'zaklad', 'zaklady',
  'grupa', 'biuro', 'instytut',
  'innowacyjno', 'wdrozeniowe', 'inzynieryjno', 'budowlane', 'badan', 'certyfikacji',
  'wod', 'mineralnych',
  // Człony częste w nazwach spółek-córek/grup kapitałowych — same w sobie nie
  // odróżniają marki (case: Ameri-pol Trading, Epam Systems (Poland))
  'trading', 'systems', 'polska', 'poland', 'holding', 'group', 'international',
  // Generyczne określenia typu działalności — nie są marką (case: Tenir Serwis)
  'serwis', 'service', 'uslugi',
  // Spójniki
  'i', 'z', 'w', 'na', 'do', 'dla', 'oraz', 'a',
]);

const FALLBACK_MAX_HOSTS       = 4;
const FALLBACK_CONCURRENCY     = 3;
const FALLBACK_TIME_BUDGET_MS  = 8_000;

// Do FALLBACK_MAX_HOSTS unikalnych hostów z DWÓCH znaczących słów nazwy (po
// odfiltrowaniu GENERIC_NAME_WORDS) — wersja bez myślnika i z myślnikiem, TLD
// .com.pl/.pl/.com. Jeden URL na host (bez oddzielnych wariantów www/http/
// https — verifyUrl (maxRedirects) i tak podąży za przekierowaniem na
// kanoniczny wariant). Pętla idzie TLD-najpierw z obiema formami na zmianę
// (nie forma-najpierw) — inaczej przy FALLBACK_MAX_HOSTS=4 wariant z
// myślnikiem nigdy nie dociera do dalszych TLD (case: Ostróda Yacht,
// Star-Dust — poprawna domena to hyphenated+.com.pl, obcięta przy formie
// jako zewnętrznej pętli). `excludeUrls` (zawsze zawiera już odrzucony URL)
// wycina kandydatów wskazujących na tę samą domenę rejestrowalną — nie ma
// sensu ponownie próbować URL-a, który identity-check już odrzucił.
function guessFallbackDomains(name, excludeUrls = []) {
  const norm  = normalizeName(name || '');
  const words = norm.split(/[^a-z0-9]+/).filter(Boolean).filter(w => !GENERIC_NAME_WORDS.has(w));
  if (!words.length) return [];

  const significant = words.slice(0, 2);
  const compact      = significant.join('');
  const hyphenated   = significant.join('-');
  const forms = [...new Set([compact, hyphenated])].filter(Boolean);

  const excludedHosts = new Set(
    excludeUrls.filter(Boolean).map(u => {
      try { return registrableDomain(new URL(u).hostname); } catch { return null; }
    }).filter(Boolean)
  );

  const tlds = ['.com.pl', '.pl', '.com'];
  const seenHosts = new Set();
  const candidates = [];
  for (const tld of tlds) {
    for (const form of forms) {
      const host = `${form}${tld}`;
      if (seenHosts.has(host) || excludedHosts.has(host)) continue;
      seenHosts.add(host);
      candidates.push(`https://${host}`);
      if (candidates.length >= FALLBACK_MAX_HOSTS) return candidates;
    }
  }
  return candidates;
}

// Weryfikuje jednego kandydata: HTTP odpowiada (verifyUrl) → scrapuje →
// checkDomainIdentity (bez żadnych zmian w tej funkcji — patrz komentarz w
// checkDomainIdentity powyżej). Samo odpowiadanie HTTP NIE wystarcza, to
// tylko wstępny filtr przed kosztownym scrapingiem. `scraped` (z crawlState)
// dołączony TYLKO gdy zweryfikowany — enrichOne go reużywa do
// continueCrawlToFull bez ponownego pobierania strony głównej; reszta
// kandydatów go nie potrzebuje (patrz resolveDomainFallback, gdzie jest
// wycinany przed zapisem do `attempts`, żeby nie rozdymać enrichment_log).
async function checkFallbackCandidate(url, { company, krsData, gusData }) {
  const verifiedUrl = await verifyUrl(url);
  if (!verifiedUrl) return { url, exists: false, verified: false };

  const scraped = await scrapeWebsiteFast(verifiedUrl);
  if (scraped.deterministicFailure) {
    return { url: verifiedUrl, exists: true, verified: false, reason: scraped.deterministicFailure.type };
  }
  const identity = scraped.identity || { title: '', h1: '' };
  const identityCheck = checkDomainIdentity({
    nip: company.nip,
    text: scraped.text,
    title: `${identity.title} ${identity.h1}`.trim(),
    company, krsData, gusData,
  });
  return {
    url: verifiedUrl, exists: true,
    verified: identityCheck.verified, reason: identityCheck.reason, evidence: identityCheck.evidence,
    scraped: identityCheck.verified ? scraped : undefined,
  };
}

// Próbuje kandydatów w grupach po FALLBACK_CONCURRENCY, zatrzymuje się na
// PIERWSZYM zweryfikowanym trafieniu. Cały resolve ma twardy limit
// FALLBACK_TIME_BUDGET_MS (Promise.race) — niezależnie od tego, ile trwają
// pojedyncze requesty/scrapy, wywołujący nie czeka dłużej niż budżet. Nie
// woła AI, nie zapisuje nic do bazy — zwraca tylko wynik do decyzji
// wywołującego.
async function resolveDomainFallback({ company, krsData, gusData, rejectedUrl }) {
  const candidates = guessFallbackDomains(company.company_name, [rejectedUrl]);

  const resolvePromise = (async () => {
    const attempts = [];
    for (let i = 0; i < candidates.length; i += FALLBACK_CONCURRENCY) {
      const batch = candidates.slice(i, i + FALLBACK_CONCURRENCY);
      const results = await Promise.all(
        batch.map(url => checkFallbackCandidate(url, { company, krsData, gusData }))
      );
      const hit = results.find(r => r.verified);
      attempts.push(...results.map(r => ({ url: r.url, exists: r.exists, verified: r.verified, reason: r.reason, evidence: r.evidence })));
      if (hit) return { url: hit.url, method: 'fallback_heuristic', attempts, scraped: hit.scraped };
    }
    return { url: null, method: 'none', attempts };
  })();

  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => resolve({ url: null, method: 'timeout', attempts: [] }), FALLBACK_TIME_BUDGET_MS);
  });

  return Promise.race([resolvePromise, timeoutPromise]);
}

// Sprawdza czy URL odpowiada (HEAD, fallback GET), zwraca URL lub null
async function verifyUrl(url) {
  for (const method of ['head', 'get']) {
    try {
      await axios[method](url, {
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

// Wyciąga "domenę rejestrowalną" — uproszczone (bez pełnej public suffix
// list), ale wystarczające dla polskich domen firmowych: ostatnie dwa człony,
// albo trzy dla popularnych złożonych TLD (.com.pl itp.).
const COMPOUND_TLDS = new Set(['com.pl', 'org.pl', 'net.pl', 'edu.pl', 'gov.pl', 'co.uk', 'com.de']);
function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length <= 2) return hostname.toLowerCase();
  const lastTwo = parts.slice(-2).join('.');
  if (COMPOUND_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

// Subdomeny komercyjnie istotne (portal B2B, sklep, konto klienta) — jedyne,
// które crawler ma prawo odwiedzić poza głównym hostem. Bez tego ograniczenia
// crawler łaziłby po całej organizacji (intranet, dokumentacja, itd. na innych
// subdomenach tej samej domeny rejestrowalnej). Case: Vents Group — "Portal
// B2B" żył na b2b.vents-group.pl i był całkowicie niewidoczny, bo
// isSameHost() odrzucał każdą subdomenę jako "obcy host" (20.08).
const RELEVANT_SUBDOMAIN_PATTERN = /^(b2b|shop|sklep|portal|konto|account|store|ecommerce|zamowienia|orders)\./i;

// candidateHostname jest dopuszczony gdy: to ten sam host (jak wcześniej),
// LUB to inna subdomena tej samej domeny rejestrowalnej ORAZ (prefiks
// subdomeny sugeruje coś komercyjnie istotnego, LUB anchor/path linku do niej
// wprost o tym mówi — np. "Portal B2B" linkujący na subdomenę bez oczywistego
// prefiksu w nazwie).
function isRelatedHost(candidateHostname, baseHostname, anchorAndPath = '') {
  const cand = candidateHostname.toLowerCase();
  const base = baseHostname.toLowerCase();
  if (isSameHost(cand, base)) return true;
  if (registrableDomain(cand) !== registrableDomain(base)) return false;
  if (RELEVANT_SUBDOMAIN_PATTERN.test(cand)) return true;
  return /sklep|shop|e-?commerce|portal.?b2b|konto.?klient|\bb2b\b/i.test(deaccent(anchorAndPath));
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

    const path = full.pathname.replace(/\/+$/, '') || '/';
    if (!isRelatedHost(full.hostname, baseHostname, `${path} ${anchor}`)) return;
    if (/\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png|gif|svg|webp|mp4|zip|rar)$/i.test(full.pathname)) return;
    if (/\/(admin|panel|konto|cart|koszyk|login|logowanie|api\/|wp-admin|wp-content|wp-json)/i.test(full.pathname)) return;

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

// Próg poniżej którego uznajemy oczyszczony tekst za "za krótki, żeby ufać
// wybranemu kontenerowi" — patrz extractText() niżej.
const TOO_SHORT_TEXT_THRESHOLD = 150;

function cleanText(str) {
  return str.replace(/\s+/g, ' ').replace(/(.)\1{5,}/g, '$1').trim();
}

// Wyciąga adres/nazwę firmy z JSON-LD (schema.org Organization/LocalBusiness),
// jeśli strona go ma — ostatni fallback, gdy zarówno główny kontener jak i
// całe body dają za mało tekstu (patrz extractText()).
function extractJsonLdText($) {
  const parts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const addr = item?.address;
        if (addr) {
          const addrStr = typeof addr === 'string'
            ? addr
            : [addr.streetAddress, addr.postalCode, addr.addressLocality].filter(Boolean).join(' ');
          if (addrStr) parts.push(addrStr);
        }
        if (item?.name) parts.push(String(item.name));
        if (item?.telephone) parts.push(String(item.telephone));
      }
    } catch { /* JSON-LD niepoprawny lub nie ten kształt — pomiń */ }
  });
  return parts.join(' ');
}

// Wyciąga czytelny tekst — preferuje <main>/<article> żeby unikać nawigacji,
// ale z bezpiecznym fallbackiem, gdy ten kontener okaże się prawie pusty
// (realny przypadek, 19.08: strony budowane na Elementor/page-builderach
// często mają <main> jako pustą powłokę, a prawdziwa treść leży POZA nim w
// DOM — wybranie "main" zamiast fallbacku na "body" ucinało wtedy stronę do
// kilkudziesięciu znaków, tracąc np. całą sekcję adresów oddziałów).
//
// Nie usuwamy już całych <form>/<header>/<footer> — tylko interaktywne pola
// formularzy (input/textarea/select/button) i iframe. Dane kontaktowe
// (adresy, miasta, telefony) często siedzą wewnątrz <form>-a strony Kontakt
// (sekcja z danymi obok pól) albo w <footer> — usuwanie tych tagów w całości
// razem z widocznym tekstem było zbyt agresywne.
function extractText($) {
  $('script, style, noscript, iframe, nav').remove();
  $('form input, form textarea, form select, form button, form label').remove();
  $('[class*="cookie"], [class*="Cookie"], [id*="cookie"], [id*="Cookie"]').remove();
  $('[class*="popup"], [class*="Popup"], [class*="modal"], [class*="Modal"]').remove();
  $('[aria-hidden="true"]').remove();

  const main = $('main, [role="main"], article, #content, #main, .main-content, .page-content').first();
  const mainText = main.length ? cleanText(main.text()) : '';

  if (mainText.length >= TOO_SHORT_TEXT_THRESHOLD) {
    return mainText.slice(0, 6000);
  }

  // Fallback 1: main za krótki (albo brak) — spróbuj całego body.
  const bodyText = cleanText($('body').text());
  if (bodyText.length >= TOO_SHORT_TEXT_THRESHOLD) {
    return bodyText.slice(0, 6000);
  }

  // Fallback 2: nawet body za krótkie — ostatnia deska ratunku, JSON-LD
  // (Organization/LocalBusiness ze schema.org, jeśli strona go ma).
  const jsonLdText = cleanText(extractJsonLdText($));
  const combined = [bodyText, jsonLdText].filter(Boolean).join(' ');
  return combined.slice(0, 6000);
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
    const telM = href.match(/^tel:([\d+\s()-]+)/i);
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
  for (const m of textForRegex.matchAll(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi)) {
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

// ── Niezawodność pobierania podstron (decyzja 19.08, po diagnozie ARPOL) ──
// Maks. CRAWL_CONCURRENCY podstron równocześnie (decyzja 20.08, przyspieszenie
// enrichmentu — poprzednio było w pełni sekwencyjne), każda z osobnym jitterem
// między próbami i retry+exponential backoff dla 403/429/5xx/timeoutów/
// podejrzanie krótkiej odpowiedzi. Retry per-URL zostaje bez zmian — to on,
// nie sama sekwencyjność, chronił przed throttlingiem w przypadku ARPOL
// (oferta pracy "klientów kluczowych" znikała w pełnym crawlu, prawdopodobny
// throttling po kilku żądaniach pod rząd, bez śladu w logach bez retry).
const SUSPICIOUSLY_SHORT_HTML = 500; // bajtów — poniżej zakładamy błąd/pustą stronę
const CRAWL_CONCURRENCY = 3;         // maks. równoległych pobrań podstron tej samej firmy
const FAST_LEVEL1_LIMIT = 4;         // tryb szybki (patrz enrichOne) — tylko najważniejsze podstrony
const FULL_LEVEL1_LIMIT = 12;        // tryb pełny — bez zmian względem poprzedniego zachowania

// Fallback wykrywania podstron (decyzja 20.08, case: Modro — nawigacja na
// stronie głównej dała 1 link na całą firmę, prawdopodobnie menu renderowane
// przez JS). Generyczna lista typowych ścieżek polskich/angielskich stron
// firmowych — bez odniesienia do konkretnej firmy — próbowana TYLKO gdy
// zwykła nawigacja+sitemapa dały poniżej MIN_DISCOVERED_LINKS realnych
// kandydatów, więc nie kosztuje nic na normalnie zlinkowanych stronach.
const MIN_DISCOVERED_LINKS = 3;
const COMMON_PATH_GUESSES = [
  '/kontakt', '/oferta', '/o-nas', '/o-firmie', '/uslugi', '/produkty', '/firma',
  '/contact', '/about', '/about-us', '/services', '/products', '/company',
];

// Pula workerów o ograniczonej równoległości — używana zarówno przy pobieraniu
// podstron jednej firmy (CRAWL_CONCURRENCY) jak i w runBatch (BATCH_CONCURRENCY).
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const runWorker = async () => {
    while (idx < items.length) {
      await worker(items[idx++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
}

async function sleepJittered(baseMs) {
  const jitter = baseMs * (0.5 + Math.random()); // 0.5x-1.5x baseMs
  return sleep(Math.round(jitter));
}

async function fetchPageForCrawl(url, { maxRetries = 2 } = {}) {
  let lastStatus = null;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleepJittered(500 * Math.pow(2, attempt - 1)); // 500ms, 1000ms, ...
    try {
      const resp = await axios.get(url, {
        timeout: 10_000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'pl,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        validateStatus: () => true, // sami decydujemy, co retry'ować
      });
      lastStatus = resp.status;
      const finalUrl = resp.request?.res?.responseUrl || url;

      // 404 = strona faktycznie nie istnieje pod tym URL-em — nie ma sensu
      // retry'ować (nie jest to throttling/błąd przejściowy jak 403/429/5xx),
      // i treść odpowiedzi (zwykle generyczna strona "nie znaleziono") NIGDY
      // nie może być traktowana jak prawdziwa treść podstrony. Case: Oqema —
      // 5 kandydatów zwracało HTTP 404 z identyczną, generyczną treścią,
      // która i tak trafiała do modelu jako rzekoma treść realnej podstrony.
      if (resp.status === 404) {
        return { html: '', finalUrl, status: 404, attempts: attempt + 1 };
      }

      if ([403, 429, 500, 502, 503, 504].includes(resp.status)) {
        if (attempt < maxRetries) {
          const retryAfter = resp.headers['retry-after'];
          const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? parseInt(retryAfter, 10) * 1000 : 0;
          if (retryAfterMs > 0) await sleep(retryAfterMs);
          continue;
        }
        return { html: '', finalUrl, status: resp.status, attempts: attempt + 1 };
      }

      const ct = resp.headers['content-type'] || '';
      if (!ct.includes('html')) {
        return { html: '', finalUrl, status: resp.status, attempts: attempt + 1 };
      }

      const html = resp.data;
      if (typeof html === 'string' && html.length < SUSPICIOUSLY_SHORT_HTML && attempt < maxRetries) {
        continue;
      }
      return { html, finalUrl, status: resp.status, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) {
        return { html: '', finalUrl: url, status: null, attempts: attempt + 1, error: err.message };
      }
    }
  }
  return { html: '', finalUrl: url, status: lastStatus, attempts: maxRetries + 1, error: lastError?.message };
}

// ── Kategorie treści + budżet znaków (decyzja 19.08) ─────────────────────
// Zamiast dokładać całe strony wg rankingu aż do wyczerpania limitu 12000
// znaków (przez co np. newsowa strona "spotkanie partnerów 2025" potrafiła
// wypchnąć /kontakt czy realną ofertę pracy) — rezerwujemy budżet per
// kategoria z góry, w kolejności priorytetu, zanim cokolwiek "nadwyżkowego"
// dostanie resztę miejsca.
// Kolejność listy = priorytet budżetu (decyzja 20.08, druga tura): "oferta"
// przesunięta przed "o_nas_zespol" (tam mieszka "historia") i "praca"
// (kariera) — realny przypadek Inova: strona /Oferta z opisem certyfikacji
// (dowód sygnału konsultacja/dobór rozwiązania) była w całości wycinana przez
// content_limit, bo kategorie "o_nas_zespol"/"praca" (przetwarzane wcześniej
// w starej kolejności) zdążyły wyczerpać budżet zanim "oferta" dostała swoją
// turę — mimo że miała własną rezerwację, globalny `used` już przekraczał
// pozostały budżet. "sklep_b2b" zostaje PRZED "oferta" (bez zmian względem
// poprzedniej kolejności) — to zachowuje wcześniejszą poprawkę 20.08
// (Wagner-service: sklep wypychany przez ogólną treść oferty).
const CONTENT_CATEGORIES = [
  { id: 'kontakt_oddzialy', reserved: 3000, pattern: /kontakt|contact|oddzia[lł]|placow|lokalizacj|biur[ao]|adres|gdzie.jestesmy/i },
  { id: 'sklep_b2b',        reserved: 1500, pattern: /sklep|shop|e-?commerce|portal.?b2b|konto.?klient|koszyk|checkout/i },
  { id: 'oferta',           reserved: 2000, pattern: /oferta|us[lł]ug|produkt|rozwiazani|solution|service|zapytani\w*.?ofert|request.?for.?quot|\brfq\b|certyfikacj|akredytacj|procedura|zasady.wsp[oó]lpracy/i },
  { id: 'o_nas_zespol',     reserved: 3000, pattern: /o[.-]?nas|o[.-]?firmie|about|zesp[oó][lł]|team|kim.jestesmy|historia/i },
  { id: 'praca',            reserved: 2500, pattern: /praca|kariera|jobs|career|rekrutacj|dolacz|join/i },
  { id: 'partnerzy',        reserved: 1500, pattern: /partner|dealer|dystrybutor|distributor/i },
];
const PER_PAGE_CHAR_CAP = 3000;

// Frazy związane z ocenianymi sygnałami ICP — strony/fragmenty, które je
// zawierają, są preferowane w obrębie tej samej kategorii (patrz
// selectWithinBudget()), zamiast polegać wyłącznie na randze linku.
const SIGNAL_KEYWORDS = /dzia[lł] handlow|dedykowan|opiekun|key account|klient\w* kluczow|indywidualn\w* wycen|zapytaj o ofert|um[oó]w demo|konsultacj|zosta[nń] partnerem|sie[cć] dealer|realizacj|referencj|przetarg|zam[oó]wien\w* publiczn|sklep|shop|e-?commerce|portal.?b2b|konto.?klient|koszyk|checkout|zapytani\w*.?ofert|request.?for.?quot|\brfq\b/i;

function categorizePage(path, anchor) {
  const hay = `${path} ${anchor || ''}`.toLowerCase();
  for (const cat of CONTENT_CATEGORIES) if (cat.pattern.test(hay)) return cat.id;
  return 'other';
}

// Rozdziela zebrane strony na budżet znaków: najpierw rezerwacja per
// kategoria (w kolejności priorytetu), potem reszta budżetu dla nadwyżki
// (np. newsy) wg rangi linku. Zwraca finalnie wybrane strony (przycięte do
// limitu) + zbiór ścieżek, które się zmieściły — reszta trafia do
// diagnostyki jako reason:'content_limit'.
function selectWithinBudget(pages, totalLimit) {
  const byCategory = new Map();
  for (const cat of CONTENT_CATEGORIES) byCategory.set(cat.id, []);
  byCategory.set('other', []);
  for (const p of pages) byCategory.get(p.category).push({ ...p, text: p.text.slice(0, PER_PAGE_CHAR_CAP) });

  for (const [, list] of byCategory) {
    list.sort((a, b) => {
      const aKw = SIGNAL_KEYWORDS.test(a.text) ? 1 : 0;
      const bKw = SIGNAL_KEYWORDS.test(b.text) ? 1 : 0;
      if (aKw !== bKw) return bKw - aKw;
      return b.score - a.score;
    });
  }

  const selected = [];
  const includedPaths = new Set();
  let used = 0;

  for (const cat of CONTENT_CATEGORIES) {
    let catUsed = 0;
    for (const p of byCategory.get(cat.id)) {
      if (catUsed >= cat.reserved || used >= totalLimit) break;
      const room = Math.min(p.text.length, cat.reserved - catUsed, totalLimit - used);
      if (room <= 0) break;
      selected.push({ ...p, text: p.text.slice(0, room) });
      includedPaths.add(p.path);
      catUsed += room;
      used += room;
    }
  }

  const leftovers = pages
    .filter(p => !includedPaths.has(p.path))
    .map(p => ({ ...p, text: p.text.slice(0, PER_PAGE_CHAR_CAP) }))
    .sort((a, b) => b.score - a.score);

  for (const p of leftovers) {
    if (used >= totalLimit) break;
    const room = Math.min(p.text.length, totalLimit - used);
    if (room <= 0) break;
    selected.push({ ...p, text: p.text.slice(0, room) });
    includedPaths.add(p.path);
    used += room;
  }

  return { selected, includedPaths, used };
}

// Główna funkcja scrapingu — dynamiczna mapa strony
// Zwraca { text: string, contacts: {...}, diagnostics: [...] }
// Kontakty zbierane są przy okazji już-pobieranych stron — zero dodatkowych requestów
// diagnostics: per-kandydat {url, attempt, http_status, raw_length, extracted_length, included, reason}
// — patrz decyzja 19.08: żadna strona nie może "znikać" bez śladu w logach.
// Rdzeń crawlowania, wspólny dla przebiegu "od zera" i dla kontynuacji
// (resume) z wcześniejszego etapu fast. Zwraca ALBO { terminal } — twardy
// wynik końcowy (błąd/parking/zły URL, patrz deterministicFailure) — ALBO
// { state } — surowy, niezbudżetowany stan crawla, który finalizeCrawl()
// zamienia na finalny { text, contacts, ... }, i który continueCrawlToFull()
// może przyjąć jako `resume`, żeby NIE pobierać ponownie stron już pobranych
// (dedup przez `fetched` Set działa identycznie dla resume jak dla świeżego
// przebiegu — patrz fetchLevel1Candidate/fetchLevel2Candidate niżej).
async function _crawlWebsite(baseUrl, { fast = false, resume = null } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  let baseHostname = resume?.baseHostname ?? null;
  if (!baseHostname) {
    try {
      baseHostname = new URL(base).hostname;
    } catch {
      return { terminal: { text: '', contacts: { emails: [], phones: [] }, diagnostics: [], identity: { title: '', h1: '' }, deterministicFailure: { type: 'invalid_url', reason: 'invalid_url' } } };
    }
  }

  const fetched      = resume?.fetched      ?? new Set();
  const allEmails     = resume?.allEmails     ?? new Set();
  const allPhones      = resume?.allPhones     ?? new Set();
  const diagnostics    = resume?.diagnostics   ?? [];
  const fetchedPages   = resume?.fetchedPages  ?? []; // { path, anchor, score, text, category, label }
  let identityTitle   = resume?.identityTitle  ?? '';
  let identityH1      = resume?.identityH1     ?? '';
  let homepageHtml    = resume?.homepageHtml   ?? '';
  let effectiveBase   = resume?.effectiveBase  ?? base;
  let homeSection     = resume?.homeSection    ?? '';

  function collectContacts(html, $page) {
    const { emails, phones } = extractContactsFromHtml(html, $page);
    emails.forEach(e => allEmails.add(e));
    phones.forEach(p => allPhones.add(p));
  }

  function logDiag(entry) {
    diagnostics.push(entry);
    logger.info('[Prospect] Candidate page result', entry);
  }

  // ── Krok 1: Homepage — pomijane przy kontynuacji (resume), mamy już dane
  // z etapu fast (homepageHtml/effectiveBase/homeSection/identity*/fetched). ─
  if (!resume) {
    // Homepage używa tego samego bezpiecznego fetcha co podstrony
    // (fetchPageForCrawl — retry+jitter, nigdy nie rzuca wyjątku) zamiast
    // jednorazowego fetchPage(), żeby przejściowe błędy (timeout, throttling)
    // dostały tę samą szansę na retry co reszta crawla (decyzja 20.08).
    const { html, finalUrl, status: homeStatus, error: homeError } = await fetchPageForCrawl(base);
    homepageHtml = typeof html === 'string' ? html : '';

    if (!homepageHtml) {
      // Błąd deterministyczny (TLS/DNS) — nie zniknie przy ponownej próbie
      // tego samego URL-a, patrz enrichOne (etap fast NIE kontynuuje crawla
      // na podstawie tej flagi).
      const deterministic = !!homeError && DETERMINISTIC_FETCH_ERROR.test(homeError);
      logger.warn('[Prospect] Homepage fetch failed', { base, error: homeError, status: homeStatus, deterministic });
      return {
        terminal: {
          text: '', contacts: { emails: [], phones: [] },
          diagnostics: [{ url: base, attempt: 1, http_status: homeStatus, raw_length: 0, extracted_length: 0, included: false, reason: homeStatus === 404 ? 'not_found' : 'fetch_error' }],
          identity: { title: '', h1: '' },
          deterministicFailure: deterministic ? { type: 'tls_dns', reason: homeError } : null,
        },
      };
    }

    // Host po redirectach sprawdzany NIEZALEŻNIE od treści (imw.pl → 301 →
    // premium.pl — giełda domen; treść marketplace'u mogłaby się zmienić,
    // sam fakt lądowania na znanym hoście giełdy domen nie).
    let finalHostname = null;
    try { finalHostname = new URL(finalUrl).hostname; } catch { /* zostaw null */ }

    if (isDomainParkingPage(homepageHtml) || isDomainMarketplaceHost(finalHostname)) {
      logger.info('[Prospect] Homepage looks like a domain-parking page — rejecting', { base, finalUrl, finalHostname });
      return {
        terminal: {
          text: '', contacts: { emails: [], phones: [] },
          diagnostics: [{ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: 0, included: false, reason: 'domain_parking' }],
          identity: { title: '', h1: '' },
          // Potwierdzony parking — kolejna próba zobaczyłaby tę samą stronę,
          // więc enrichOne nie kontynuuje crawla na podstawie tej flagi.
          deterministicFailure: { type: 'domain_parking', reason: 'domain_parking' },
        },
      };
    }

    try {
      const p = new URL(finalUrl);
      baseHostname = p.hostname;
      effectiveBase = `${p.protocol}//${p.hostname}`;
    } catch { /* zostaw oryginał */ }

    // Kontakty PRZED extractText — extractText usuwa aria-hidden="true" (zamknięte akordeony z danymi)
    const $home = cheerio.load(homepageHtml);
    collectContacts(homepageHtml, $home);

    // Tytuł/H1 strony głównej — wejście do weryfikacji tożsamości domeny
    // (checkDomainIdentity w enrichOne), niezależnie od tego czy homeText
    // okaże się wystarczająco długi.
    identityTitle = $home('title').first().text().trim();
    identityH1    = $home('h1').first().text().trim();

    const homeText = extractText($home);
    if (homeText.length > 100) {
      homeSection = `[/ — strona główna]\n${homeText}`;
      logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: true, reason: 'included' });
    } else {
      const $meta = cheerio.load(homepageHtml);
      const title       = $meta('title').text().trim();
      const description = $meta('meta[name="description"]').attr('content')?.trim() || '';
      const ogDesc      = $meta('meta[property="og:description"]').attr('content')?.trim() || '';
      const fallback    = [title, description || ogDesc].filter(Boolean).join(' — ');
      if (fallback.length > 10) {
        homeSection = `[/ — strona główna (meta)]\n${fallback}`;
        logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: true, reason: 'included_meta_fallback' });
      } else {
        logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: false, reason: 'too_short' });
      }
    }
    fetched.add(effectiveBase);
    fetched.add(effectiveBase + '/');
  }

  // ── Krok 2: Zbierz linki z nawigacji (+ sitemapy w trybie pełnym) ─
  // Tryb szybki (fast) pomija sitemapę — to 1-3 dodatkowe żądania HTTP, a
  // nawigacja sama w sobie już wskazuje najważniejsze podstrony (patrz
  // enrichOne — scrapeWebsiteFast/continueCrawlToFull).
  const $ = cheerio.load(homepageHtml);
  const navLinks     = extractInternalLinks($, baseHostname);
  const sitemapLinks = fast ? [] : await fetchSitemapUrls(effectiveBase, baseHostname);

  const allLinks = resume?.allLinks ?? new Map();
  for (const { path, fullHref, anchor } of [...navLinks, ...sitemapLinks]) {
    const score = scoreLinkRelevance(path, anchor);
    const existing = allLinks.get(path);
    if (!existing || score > existing.score) {
      allLinks.set(path, { path, fullHref, anchor, score });
    }
  }

  // Nawigacja (+ sitemapa) dała prawie nic — spróbuj typowych ścieżek podstron
  // zamiast poddawać się po jednym linku. Tylko przy pierwszym przebiegu
  // (nie przy kontynuacji z resume — jeśli fast już próbował i nie znalazł,
  // nie powtarzamy tych samych nieudanych prób).
  if (!resume) {
    const realCandidateCount = Array.from(allLinks.values()).filter(l => l.score > 0 && l.path !== '/').length;
    if (realCandidateCount < MIN_DISCOVERED_LINKS) {
      logger.info('[Prospect] Navigation yielded too few links — trying common path guesses', {
        base, effectiveBase, realCandidateCount,
      });
      async function tryPathGuess(path) {
        if (allLinks.has(path)) return;
        const hit = await verifyUrl(`${effectiveBase}${path}`);
        if (!hit) return;
        const score = scoreLinkRelevance(path, '');
        if (score > 0) allLinks.set(path, { path, fullHref: hit, anchor: '', score });
      }
      await runWithConcurrency(COMMON_PATH_GUESSES, CRAWL_CONCURRENCY, tryPathGuess);
    }
  }

  const level1Limit = fast ? FAST_LEVEL1_LIMIT : FULL_LEVEL1_LIMIT;
  const candidates = Array.from(allLinks.values())
    .filter(l => l.score > 0 && l.path !== '/')
    .sort((a, b) => b.score - a.score)
    .slice(0, level1Limit);

  logger.info('[Prospect] Site map discovered', {
    base,
    effectiveBase,
    baseHostname,
    nav_links: navLinks.length,
    sitemap_links: sitemapLinks.length,
    top_candidates: candidates.map(c => `${c.path}(${c.score})`),
  });

  // ── Krok 3: Pobierz wybrane podstrony (poziom 1), maks. CRAWL_CONCURRENCY
  // równocześnie — każda z osobnym retry+jitter (patrz fetchPageForCrawl).
  // Przy kontynuacji (resume) `fetched` już zawiera URL-e pobrane w fast —
  // fetchLevel1Candidate je pomija (reason: 'duplicate'), NIE pobiera ponownie. ─
  const level2Links = resume?.level2Links ?? new Map();

  async function fetchLevel1Candidate({ fullHref, path, anchor, score }) {
    if (fetched.has(fullHref)) {
      logDiag({ url: fullHref, attempt: 0, http_status: null, raw_length: 0, extracted_length: 0, included: false, reason: 'duplicate' });
      return;
    }
    fetched.add(fullHref);

    const { html, status, attempts, error } = await fetchPageForCrawl(fullHref);
    if (error || !html) {
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: 0, extracted_length: 0, included: false, reason: status === 404 ? 'not_found' : 'fetch_error' });
      await sleepJittered(400);
      return;
    }

    const $page = cheerio.load(html);
    collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
    const text  = extractText($page);
    if (text.length > 100) {
      const label = anchor ? `${path} — ${anchor}` : path;
      fetchedPages.push({ path, anchor, score, text, label, category: categorizePage(path, anchor) });
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: true, reason: 'included' });
    } else {
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: false, reason: 'too_short' });
    }

    // Tryb szybki nie rozwija się do poziomu 2 — pomiń zbieranie kandydatów.
    if (!fast) {
      for (const { path: p2, fullHref: h2, anchor: a2 } of extractInternalLinks($page, baseHostname)) {
        if (fetched.has(h2) || allLinks.has(p2) || level2Links.has(p2)) continue;
        const s2 = scoreLinkRelevance(p2, a2);
        if (s2 >= 8) level2Links.set(p2, { path: p2, fullHref: h2, anchor: a2, score: s2 });
      }
    }

    await sleepJittered(400);
  }

  await runWithConcurrency(candidates, CRAWL_CONCURRENCY, fetchLevel1Candidate);

  // ── Krok 4: Pobierz strony poziomu 2 (maks. 6) — pomijane w trybie ──
  // szybkim (patrz enrichOne — scrapeWebsiteFast/continueCrawlToFull).
  const level2Candidates = fast ? [] : Array.from(level2Links.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (level2Candidates.length) {
    logger.info('[Prospect] Level-2 pages discovered', {
      base,
      pages: level2Candidates.map(c => `${c.path}(${c.score})`),
    });
  }

  async function fetchLevel2Candidate({ fullHref, path, anchor, score }) {
    if (fetched.has(fullHref)) {
      logDiag({ url: fullHref, attempt: 0, http_status: null, raw_length: 0, extracted_length: 0, included: false, reason: 'duplicate' });
      return;
    }
    fetched.add(fullHref);

    const { html, status, attempts, error } = await fetchPageForCrawl(fullHref);
    if (error || !html) {
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: 0, extracted_length: 0, included: false, reason: 'fetch_error' });
      await sleepJittered(400);
      return;
    }

    const $page = cheerio.load(html);
    collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
    const text  = extractText($page);
    if (text.length > 100) {
      const label = anchor ? `${path} — ${anchor}` : path;
      fetchedPages.push({ path, anchor, score, text, label, category: categorizePage(path, anchor) });
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: true, reason: 'included' });
    } else {
      logDiag({ url: fullHref, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: false, reason: 'too_short' });
    }

    await sleepJittered(400);
  }

  await runWithConcurrency(level2Candidates, CRAWL_CONCURRENCY, fetchLevel2Candidate);

  return {
    state: {
      fetched, allEmails, allPhones, diagnostics, fetchedPages,
      identityTitle, identityH1, homepageHtml, effectiveBase, homeSection, baseHostname,
      allLinks, level2Links,
    },
  };
}

// ── Krok 5: Budżetowany wybór treści do limitu 12000 znaków ──────────
// Deduplikacja fragmentów (decyzja 20.08) — usuwa WYŁĄCZNIE dokładne,
// znormalizowane (trim + collapse spacji + lowercase) powtórki fragmentów
// zdań między podstronami tej samej firmy, PRZED wysłaniem do AI. Typowy
// przypadek: identyczna stopka z adresem/telefonem/copyright na każdej
// podstronie. Zachowywane jest PIERWSZE wystąpienie (w kolejności, w jakiej
// trafiają do promptu — homepage, potem wybrane podstrony wg rangi), usuwane
// są tylko KOLEJNE, dokładne powtórki. Fragmenty krótsze niż
// DEDUP_MIN_FRAGMENT_LEN nigdy nie są usuwane — to często generyczne, krótkie
// frazy (nie bloki boilerplate), a ich usunięcie byłoby zbyt agresywne.
// Działa na już oczyszczonym tekście z extractText() — NIE na surowym HTML,
// więc collectContacts()/extractContactsFromHtml() (wołane wcześniej, na
// surowym HTML każdej strony) tej deduplikacji w ogóle nie widzą.
const DEDUP_MIN_FRAGMENT_LEN = 20;

function normalizeFragmentKey(fragment) {
  return fragment.trim().replace(/\s+/g, ' ').toLowerCase();
}

function dedupeRepeatedFragments(sections) {
  const seen = new Set();
  let charsBefore = 0;
  const deduped = sections.map(text => {
    charsBefore += text.length;
    const fragments = text.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (const frag of fragments) {
      const key = normalizeFragmentKey(frag);
      if (key.length >= DEDUP_MIN_FRAGMENT_LEN) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      kept.push(frag);
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  });
  const charsAfter = deduped.reduce((sum, t) => sum + t.length, 0);
  return { sections: deduped, charsBefore, charsAfter };
}

function finalizeCrawl(state) {
  const { homeSection, fetchedPages, diagnostics, allEmails, allPhones, identityTitle, identityH1 } = state;
  const remainingBudget = Math.max(0, 12_000 - homeSection.length);
  const { selected, includedPaths } = selectWithinBudget(fetchedPages, remainingBudget);

  // Strony, które miały dobrą treść, ale nie zmieściły się w budżecie —
  // odnotuj to wprost w diagnostyce zamiast cichego pominięcia.
  for (const p of fetchedPages) {
    if (!includedPaths.has(p.path)) {
      const diag = diagnostics.find(d => d.url.includes(p.path) && d.reason === 'included');
      if (diag) diag.reason = 'content_limit', diag.included = false;
    }
  }

  const rawSections = [homeSection, ...selected.map(p => `[${p.label}]\n${p.text}`)].filter(Boolean);
  const { sections: finalTexts, charsBefore: dedupCharsBefore, charsAfter: dedupCharsAfter } = dedupeRepeatedFragments(rawSections);
  logger.info('[Prospect] Content dedup', {
    chars_before: dedupCharsBefore, chars_after: dedupCharsAfter, removed: dedupCharsBefore - dedupCharsAfter,
  });

  const contacts = {
    emails: [...allEmails].filter(e => e.includes('@')),
    phones: [...allPhones].filter(p => p.replace(/\D/g, '').length >= 9),
  };

  return {
    text: finalTexts.join('\n\n---\n\n'), contacts, diagnostics,
    identity: { title: identityTitle, h1: identityH1 }, deterministicFailure: null,
    dedup: { chars_before: dedupCharsBefore, chars_after: dedupCharsAfter },
  };
}

// Crawl "od zera" w jednym kroku (bez podziału na fast/pełny) — zachowany dla
// zgodności/eksportu; enrichOne od decyzji 20.08 (jedno wywołanie AI) używa
// zamiast tego pary scrapeWebsiteFast() + continueCrawlToFull() niżej.
async function scrapeWebsite(baseUrl, { fast = false } = {}) {
  const result = await _crawlWebsite(baseUrl, { fast });
  if (result.terminal) return result.terminal;
  return finalizeCrawl(result.state);
}

// Etap szybki (decyzja 20.08) — WYŁĄCZNIE weryfikacja domeny + wykrywanie
// trwałych błędów (TLS/DNS/parking). Nigdy nie woła AI — patrz enrichOne.
// Zwraca też surowy `crawlState`, żeby continueCrawlToFull() mógł dokończyć
// crawl bez ponownego pobierania stron już pobranych tutaj.
async function scrapeWebsiteFast(baseUrl) {
  const result = await _crawlWebsite(baseUrl, { fast: true });
  if (result.terminal) return { ...result.terminal, crawlState: null };
  return { ...finalizeCrawl(result.state), crawlState: result.state };
}

// Dokańcza crawl do pełnej głębokości (sitemapa + do 12 podstron poziomu 1 +
// poziom 2) na bazie stanu ze scrapeWebsiteFast(). Strony już pobrane w fast
// NIE są pobierane ponownie — dedup przez `fetched` Set w _crawlWebsite.
async function continueCrawlToFull(baseUrl, crawlState) {
  const result = await _crawlWebsite(baseUrl, { fast: false, resume: crawlState });
  if (result.terminal) return result.terminal; // nie powinno wystąpić przy kontynuacji — homepage już pobrany OK
  return finalizeCrawl(result.state);
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
  Główny dowód: jawna nazwa "dział handlowy"/formalna struktura organizacyjna
  sprzedaży, LUB podstrona zespołu/kontaktu z co najmniej 2-3 nazwanymi
  osobami pełniącymi role stricte handlowe (przedstawiciel handlowy,
  sprzedawca, account manager — nie zarząd).
  NIE wystarcza: jedna nazwana osoba na stanowisku dyrektorskim
  ("Dyrektor Handlowy", "Dyrektor ds. Handlowych") bez opisanego zespołu ani
  innych wymienionych handlowców — to może być jedna osoba w zarządzie,
  nie dowód na istnienie sformalizowanego działu.
  Drugorzędne wsparcie: sam adres sprzedaz@ — może być zwykłą skrzynką ogólną.

custom_quote_process ("Złożony proces sprzedaży / indywidualna wycena"):
  Relacyjny, projektowy lub negocjacyjny model, nie zakup impulsowy.
  Główny dowód: fraza CTA — "zapytaj o ofertę", "poproś o wycenę", "indywidualna oferta",
  "przygotujemy ofertę", "skontaktuj się z handlowcem".
  Drugorzędne wsparcie: sam brak jawnego cennika bez takiej frazy.

consultation_demo_needs_analysis ("Konsultacja, demo lub analiza potrzeb"):
  Sprzedaż wymaga rozmowy przed zakupem, nie samoobsługowego checkoutu — łapie też firmy
  z jawnym cennikiem, które mimo to sprzedają przez rozmowę (częste w SaaS/usługach).
  Główny dowód (dosłowna fraza LUB funkcjonalny odpowiednik — oba liczą się tak samo):
    - dosłowne: "umów demo", "zamów prezentację", "bezpłatna konsultacja", "dobór rozwiązania";
    - funkcjonalne: oferta personalizacji/dostosowania produktu do wymagań klienta ("custom",
      "dostosowane do indywidualnych potrzeb", "prace/projekty zlecone indywidualnie", karta
      personalizacji per klient);
    - przypisany doradca/opiekun/dyrektor regionalny opisany jako doradztwo PRZEDSPRZEDAŻOWE,
      projektowe lub techniczne PRZY DOBORZE ROZWIĄZANIA (np. "Doradcy Twojego projektu"),
      nawet bez słowa "konsultacja";
    - formularz zbierający szczegółowe parametry rozwiązania/zamówienia (RFQ, zapytanie
      ofertowe z polami technicznymi), nie sam formularz kontaktowy ogólnego typu;
    - sprzedaż oparta na indywidualnym projekcie technicznym/architektonicznym/inżynierskim,
      gdzie analiza wymagań klienta jest jawnie opisanym etapem procesu (nie samym typem
      działalności — patrz zastrzeżenie niżej).
  Drugorzędne wsparcie (nie wystarcza samo): ogólne hasło "indywidualne podejście do klienta"
  bez opisu konkretnego procesu, etapu lub osoby.
  NIE LICZY SIĘ (mimo słowa "doradca"/"konsultacja" w tekście):
    - doradca/opiekun ds. likwidacji szkód, ubezpieczeniowy, reklamacji lub gwarancji — to
      obsługa posprzedażowa/roszczeniowa, nie doradztwo przy wyborze zakupu;
    - serwisant, doradca serwisowy/techniczny wsparcia posprzedażowego, opiekun serwisu —
      to wsparcie techniczne dla już kupionego produktu, nie etap sprzedaży;
    - ogólny, poradnikowy tekst nieopisujący WŁASNEGO procesu tej firmy (np. blogowa porada
      "na co zwrócić uwagę kupując X" bez odniesienia do konkretnej usługi/osoby/etapu w tej
      firmie) — to nie jest dowód konsultacji sprzedażowej, tylko treść informacyjna;
    - sama produkcja/wykonanie "na wymiar" lub "według dokumentacji/wytycznych klienta" —
      to dowód dla custom_quote_process (indywidualna wycena), NIE automatycznie dla tego
      sygnału; liczy się TYLKO jeśli osobno opisany jest etap doradztwa/rozmowy o
      wymaganiach przed złożeniem zamówienia, nie sam fakt wykonania na zamówienie;
    - sam formularz kontaktowy ogólnego typu (imię, e-mail, wiadomość) — to nie jest dowód
      konsultacji/analizy potrzeb, nawet jeśli firma go używa jako jedynego kanału kontaktu.
  ZASTRZEŻENIE: nie ustawiaj true wyłącznie na podstawie branży/typu działalności ani z
  domysłu "każdy proces projektowy wymaga analizy potrzeb" — musi być konkretny tekstowy
  sygnał z listy powyżej, nie sama inferencja z rodzaju firmy.
  Jeśli to ten sam fragment tekstu co dowód dla custom_quote_process, oceń oba sygnały
  niezależnie, ale nie licz jednego zdania jako dwóch niezależnych, mocniejszych dowodów.

distributed_sales_structure ("Rozproszona struktura sprzedaży / wiele oddziałów"):
  Zespół lub sieć sprzedaży fizycznie rozproszona terytorialnie, WŁASNA (ta sama osoba
  prawna, nie osobne podmioty).
  Główny dowód: oficjalne oddziały, biura regionalne lub placówki firmy w kilku miastach —
  to WYSTARCZA samo w sobie, nawet bez podanych nazwisk osób przy adresach. Przypisani
  regionalni handlowcy/przedstawiciele zwiększają pewność, ale NIE są warunkiem koniecznym.
  NIE liczy się (to nie własne oddziały tej firmy): lokalizacje realizacji/projektów u
  klientów, siedziby klientów, adresy zewnętrznych partnerów/dealerów/niezależnych
  dystrybutorów (nawet zagranicznych, nawet z "recognized distributor" w opisie), ani
  spółki-siostry/spółki z tej samej grupy kapitałowej (to osobne podmioty prawne).

ecommerce_b2b ("Sprzedaż e-commerce (B2B)"):
  Sklep/platforma zamówieniowa w domenie firmy z realną obsługą B2B, nie czysty
  samoobsługowy self-service bez ludzi po stronie sprzedaży.
  Główny dowód: sklep lub panel klienta B2B w domenie firmy.

dedicated_customer_care_b2b ("Dedykowana opieka nad klientem B2B"):
  Dedykowany zespół posprzedażowy, ew. przypisany opiekun.
  Główny dowód: "dedykowany opiekun", "opiekun biznesowy", "Key Account Manager",
  "Customer Success", "obsługa posprzedażowa", "odnowienia umów", "stała opieka nad klientem".
  Stanowiska/oferty pracy "Specjalista ds. klientów kluczowych", "Key Account Manager",
  "opiekun klienta biznesowego" i ich jednoznaczne odpowiedniki to RÓWNIEŻ mocny dowód —
  ogłoszenie o pracę na taką rolę liczy się tak samo jak opis usługi na stronie.
  Drugorzędne wsparcie: samo słowo "BOK" lub sama infolinia — może prowadzić do jednej
  osoby lub zwykłego wsparcia technicznego, nie relacyjnej opieki.

partner_dealer_network ("Sieć partnerów / dealerów"):
  Firma buduje lub rozwija sieć sprzedaży pośredniej przez NIEZALEŻNE, osobne podmioty
  odsprzedające jej produkty (dealerzy, dystrybutorzy, franczyzobiorcy).
  Główny dowód: "zostań partnerem", "sieć dealerska", "dla dystrybutorów", "strefa partnera"
  w domenie firmy, LUB jawnie wymieniona lista niezależnych dystrybutorów/przedstawicieli
  na rynkach zagranicznych (np. podstrona "distribution"/"dystrybucja", formularz dla
  zagranicznych dystrybutorów rozpoczynających współpracę).
  NIE liczy się: linki do spółek-sióstr/spółek z tej samej grupy kapitałowej — to nie sieć
  odsprzedawców, tylko wewnętrzna struktura grupy — chyba że tekst wprost opisuje je jako
  dealerów/dystrybutorów tej firmy, nie jako powiązane firmy.

tender_bidding_department ("Przetargi / dział ofertowania"):
  Firma SPRZEDAJE w przetargach — UWAGA, częsta pomyłka w obie strony:
  Dowód pozytywny (true): jawny język udziału w postępowaniu przetargowym JAKO
  WYKONAWCA/OFERENT — "realizujemy zamówienia publiczne", "oferta dla sektora publicznego",
  "doświadczenie w przetargach", "specjalista ds. przetargów/ofertowania", "startujemy w
  przetargach", "oferty przetargowe", "wygraliśmy przetarg".
  NIE WYSTARCZA samo posiadanie klientów/zamawiających publicznych w portfolio realizacji
  (gmina, muzeum, biblioteka, urząd jako "Inwestor:" zrealizowanego projektu) — to dowód na
  OBSŁUGĘ sektora publicznego, nie na SPOSÓB pozyskania tego kontraktu. Bez jawnego słowa
  "przetarg"/"zamówienie publiczne"/"PZP" użytego w kontekście SPRZEDAŻY (nie samego faktu
  posiadania takiego klienta), zwróć false.
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
  const usage = {
    prompt_tokens:            data?.usage?.prompt_tokens ?? null,
    completion_tokens:        data?.usage?.completion_tokens ?? null,
    prompt_cache_hit_tokens:  data?.usage?.prompt_cache_hit_tokens ?? null,
    prompt_cache_miss_tokens: data?.usage?.prompt_cache_miss_tokens ?? null,
  };
  logger.info('[Prospect] DeepSeek raw API response', {
    model:            data?.model,
    finish_reason:    choice?.finish_reason,
    completion_tokens: usage.completion_tokens,
    prompt_tokens:    usage.prompt_tokens,
    prompt_cache_hit_tokens:  usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
    contentLength:    choice?.message?.content?.length,
    contentPreview:   choice?.message?.content?.slice(0, 300),
  });

  return { content: choice?.message?.content || '{}', model: data?.model || null, usage };
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

  // Anthropic nazywa te pola inaczej niż DeepSeek — mapujemy na te same nazwy
  // (prompt_cache_hit_tokens/prompt_cache_miss_tokens) dla spójnego logu/enrichLog
  // niezależnie od providera. cache_read = trafienie cache'u (hit), input_tokens
  // to tokeny faktycznie przetworzone poza trafionym cache'em (miss).
  const usage = {
    prompt_tokens:            data?.usage?.input_tokens ?? null,
    completion_tokens:        data?.usage?.output_tokens ?? null,
    prompt_cache_hit_tokens:  data?.usage?.cache_read_input_tokens ?? null,
    prompt_cache_miss_tokens: data?.usage?.input_tokens ?? null,
  };
  logger.info('[Prospect] Anthropic raw API response', {
    model: data?.model,
    stop_reason: data?.stop_reason,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
    contentLength: data?.content?.[0]?.text?.length,
  });

  return { content: data?.content?.[0]?.text || '{}', model: data?.model || null, usage };
}

async function analyzeWithAi(company, krsData, websiteText, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'prospect.ai_provider' AND tenant_id = $1`,
    [company.tenant_id]
  );
  const provider = rows[0]?.value || 'deepseek';

  const userMessage = buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText);
  const { content: raw, model: usedModel, usage } = provider === 'anthropic'
    ? await callAnthropic(userMessage)
    : await callDeepSeek(userMessage);

  logger.info('[Prospect] AI raw response', { provider, company: company.company_name, rawLength: raw.length, rawPreview: raw.slice(0, 500) });

  try {
    const parsed = JSON.parse(raw);
    logger.info('[Prospect] AI parse OK', { provider, company: company.company_name, signals: parsed.icp_signals, summary: parsed.ai_summary?.slice(0, 80) });
    return { result: parsed, provider, model: usedModel, usage };
  } catch {
    // Fallback: wytnij blok {} i spróbuj jeszcze raz
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn('[Prospect] AI returned unparseable response', { provider, preview: raw.slice(0, 200) });
      return { result: null, provider, model: usedModel, usage };
    }
    try {
      const parsed = JSON.parse(match[0]);
      logger.info('[Prospect] AI parse OK (regex fallback)', { provider, company: company.company_name, signals: parsed.icp_signals });
      return { result: parsed, provider, model: usedModel, usage };
    } catch {
      logger.warn('[Prospect] AI JSON malformed after regex extract', { provider, rawLength: raw.length, rawTail: raw.slice(-200), preview: match[0].slice(0, 300) });
      return { result: null, provider, model: usedModel, usage };
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

  // opts.dryRun / opts.trustedDomain — WYŁĄCZNIE do ręcznego testowania (patrz
  // reczne-sprawdzanie-enrichment-100.md), nigdy ustawiane przez route'y/batch.
  // trustedDomain: pomija TYLKO bramkę identity-check (dokładnie ten sam efekt
  // co istniejący website_source === 'manual_correction' — nie zmienia
  // checkDomainIdentity() ani żadnej reguły weryfikacji, tylko czy jej wynik
  // blokuje AI). dryRun: żaden UPDATE do bazy się nie wykonuje — wynik, który
  // normalnie trafiłby do bazy, wraca w polach zwracanego obiektu zamiast tego.
  const dryRun = opts.dryRun === true;
  async function persistUpdate(query, params) {
    if (dryRun) return { rows: [] };
    return db.query(query, params);
  }

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
      await persistUpdate(
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
      await persistUpdate(
        `UPDATE prospect_companies SET pracuj_status = $2 WHERE id = $1`,
        [prospectId, pracujStatus]
      );
    }

    // 3. Website URL — jeśli już mamy zapisany URL (z importu, ręcznej korekty
    // LUB poprzedniego przebiegu resolvera), użyj go bez ponownego szukania.
    // Normalizuj URL tutaj jako safety-net (dane ze starych importów mogą być nieznormalizowane).
    //
    // website_source (kolumna, migracja 0269, decyzja 20.08) — TRWAŁE pochodzenie
    // URL-a, NIGDY nie zmieniane przy samym ponownym użyciu istniejącego URL-a.
    // Poprzednio każdy rerun z już-ustawionym website_url etykietował go jako
    // 'manual' bez względu na prawdziwe pochodzenie — to nie problem samo w
    // sobie (URL się nie zmieniał), ale uniemożliwiało odróżnienie "prawdziwy
    // import CSV" (ufny) od "wynik resolvera z poprzedniego przebiegu"
    // (dalej wymaga weryfikacji tożsamości przy każdym użyciu).
    let websiteUrl, websiteMethod, websiteSource;
    if (company.website_url) {
      websiteUrl    = normalizeWebsiteUrl(company.website_url) || company.website_url;
      websiteMethod = 'manual';
      websiteSource = company.website_source || 'legacy_unknown'; // PRESERWUJ, nie nadpisuj
      enrichLog.website = { url: websiteUrl, method: websiteMethod, source: websiteSource };
    } else {
      const found  = await findWebsiteUrl(
        company.company_name || krsData?.companyName,
        krsData?.krsWebsite
      );
      websiteUrl    = found.url;
      websiteMethod = found.method;
      websiteSource = websiteUrl ? 'resolver' : null;
      enrichLog.website = { url: websiteUrl, method: websiteMethod, source: websiteSource };
    }

    // Wymaganie #2: bez URL strony WWW nie ma sensu kontynuować — chyba że mamy dane z LinkedIn
    let websiteStatus = null;

    if (opts.skipWebsite) {
      // URL się nie zmienił — pomijamy wyszukiwanie URL (DDG/Google/Bing), ale scraping i tak ruszy poniżej
      websiteUrl   = company.website_url ? (normalizeWebsiteUrl(company.website_url) || company.website_url) : null;
      websiteMethod = 'skip_url_resolution';
      websiteSource = company.website_source || 'legacy_unknown'; // PRESERWUJ
      enrichLog.website = { url: websiteUrl, method: 'skip_url_resolution', source: websiteSource };
    } else {
      if (!websiteUrl) websiteStatus = 'not_found';

      if (!websiteUrl) {
        if (!linkedinText.trim()) {
          await persistUpdate(
            `UPDATE prospect_companies SET
               enrichment_status = 'no_website',
               website_status    = 'not_found',
               icp_score          = NULL,
               icp_signals         = NULL,
               icp_gates            = NULL,
               icp_bonus_signals     = NULL,
               icp_gate_status        = 'needs_review',
               enriched_at             = NOW(),
               enrichment_log           = $2
             WHERE id = $1`,
            [prospectId, JSON.stringify(enrichLog)]
          );
          logger.info('[Prospect] No website found — stopping enrichment', { prospectId });
          return { status: 'no_website', prospectId, ...(dryRun ? { dryRun: true, enrichment_log: enrichLog } : {}) };
        }
        logger.info('[Prospect] No website but LinkedIn data available — continuing enrichment', { prospectId });
      }
    }

    // 3. Scraping — zawsze scrapuj gdy URL dostępny; skipWebsite pomija tylko wyszukiwanie URL
    //
    // Etap szybki (decyzja 20.08, przyspieszenie enrichmentu) służy WYŁĄCZNIE
    // do weryfikacji domeny i wykrywania trwałych błędów (TLS/DNS/parking) —
    // nigdy nie woła AI. Dopiero gdy domena jest potwierdzona (identity-check)
    // LUB zaufana (manual_correction/trustedDomain), crawl jest dokańczany do
    // pełnej głębokości (sitemapa + do 12 podstron poziomu 1 + poziom 2),
    // WYKORZYSTUJĄC strony już pobrane w fast (continueCrawlToFull — bez
    // ponownego ich pobierania, patrz dedup w _crawlWebsite), i dopiero na tej
    // pełnej treści wykonywane jest dokładnie JEDNO wywołanie DeepSeeka.
    let websiteText = '';
    let scrapedContacts = { emails: [], phones: [] };
    let scanStage = websiteUrl ? 'fast' : 'no_website_url';

    function computeIdentityCheck(scrapedResult) {
      // Weryfikacja tożsamości domeny (decyzja 20.08, po ARPOL/Mirol/IMW-Deckert)
      // — dla źródeł niepewnych z natury (zgadnięta domena/wynik wyszukiwarki)
      // ORAZ dla adresów podanych ręcznie/z CSV (te bywają błędne w danych
      // źródłowych — case: IMW Inżynieria Maszyn Wałcz → deckert.de, niemiecka
      // firma). NIP w tekście wystarcza sam. W jego braku: wymagane DWA
      // niezależne sygnały (nazwa w title/h1 + miasto/KRS/REGON) — samo
      // dopasowanie nazwy zawiodło już dwukrotnie (Ims R&d→ims.com,
      // Mirol sp. z o.o.→mirol.com/Argentyna, ta sama nazwa, inna firma).
      const identity = scrapedResult.identity || { title: '', h1: '' };
      return checkDomainIdentity({
        nip: company.nip,
        text: scrapedResult.text,
        title: `${identity.title} ${identity.h1}`.trim(),
        company, krsData, gusData,
      });
    }

    if (websiteUrl) {
      // websiteSource === 'manual_correction' — admin jawnie wpisał/poprawił
      // ten URL przez UI: to już jest ludzka weryfikacja, nie uruchamiamy
      // automatycznego checku tożsamości nad nim (decyzja 20.08).
      // opts.trustedDomain — wyłącznie testowe, identyczny efekt jak wyżej
      // (patrz komentarz przy dryRun na początku funkcji).
      const trustedByHuman = websiteSource === 'manual_correction' || opts.trustedDomain === true;

      const fastScraped = await scrapeWebsiteFast(websiteUrl);
      let scraped = fastScraped;
      let identityCheck = computeIdentityCheck(fastScraped);

      if (fastScraped.deterministicFailure) {
        // Błąd deterministyczny (TLS/DNS, potwierdzony parking domeny, zły
        // URL) — pełny crawl zobaczyłby dokładnie to samo, więc dokańczanie
        // crawla tylko kosztowałoby czas bez szans na inny wynik (decyzja
        // 20.08, patrz DETERMINISTIC_FETCH_ERROR / deterministicFailure).
        logger.info('[Prospect] Fast scan hit a deterministic failure — not completing crawl', {
          prospectId, websiteUrl, type: fastScraped.deterministicFailure.type, reason: fastScraped.deterministicFailure.reason,
        });
        scanStage = fastScraped.deterministicFailure.type === 'domain_parking'
          ? 'fast_domain_parking'
          : 'fast_deterministic_fetch_error';
      } else if (identityCheck.verified || trustedByHuman) {
        // Domena potwierdzona (lub zaufana) — dokończ crawl do pełnej
        // głębokości, ponownie wykorzystując strony już pobrane w fast.
        logger.info('[Prospect] Domain confirmed — completing full crawl', {
          prospectId, websiteUrl, reason: identityCheck.reason, trustedByHuman,
        });
        scraped = await continueCrawlToFull(websiteUrl, fastScraped.crawlState);
        // Tożsamość przeliczona na pełnej treści — czysto diagnostyczne
        // (evidence w logu bogatsze), decyzja o kontynuacji już zapadła wyżej;
        // może jednak wykryć konflikt (np. zagraniczny adres) niewidoczny w
        // wąskiej treści fast — sprawdzenie niżej (`!identityCheck.verified`)
        // wciąż na to reaguje.
        identityCheck = computeIdentityCheck(scraped);
        scanStage = 'full';
      } else {
        // Domena niepotwierdzona i nie zaufana — JEDNA próba fallbacku (patrz
        // resolveDomainFallback, przetestowany 21.08 na 20 ręcznie
        // potwierdzonych domenach + 8 kontrolach) zanim rekord pójdzie do
        // needs_review. Nigdy dla manual_correction/trustedDomain — trustedByHuman
        // już wyklucza tę gałąź, więc ręcznie wpisany URL nigdy nie jest
        // nadpisywany. Fallback ma własny twardy limit czasu i liczby
        // kandydatów — tu wołany co najwyżej raz na przebieg enrichOne.
        const fallbackResult = await resolveDomainFallback({ company, krsData, gusData, rejectedUrl: websiteUrl });
        enrichLog.website.fallback = {
          attempted:        true,
          candidates_tried: fallbackResult.attempts.length,
          found_url:        fallbackResult.url,
          method:           fallbackResult.method,
        };
        if (fallbackResult.url) {
          logger.info('[Prospect] Fallback found a verified alternate domain — completing full crawl', {
            prospectId, rejectedUrl: websiteUrl, foundUrl: fallbackResult.url,
          });
          websiteUrl    = fallbackResult.url;
          // 'resolver', nie 'fallback_heuristic' — website_source ma CHECK
          // constraint (migracja 0269) ograniczony do 4 wartości; metoda na
          // poziomie szczegółu (fallback_heuristic) i tak jest już zapisana w
          // enrichLog.website.fallback.method, kolumna nie musi jej powielać.
          websiteSource = 'resolver';
          scraped       = await continueCrawlToFull(websiteUrl, fallbackResult.scraped.crawlState);
          identityCheck = computeIdentityCheck(scraped);
          scanStage     = 'full';
          // enrichLog.website.url/source zostały ustawione PRZED tym blokiem
          // (na oryginalnym, odrzuconym URL-u) — bez tej podmiany log
          // mylnie pokazywałby stary URL mimo że reszta enrichmentu (i finalny
          // website_url w DB) dotyczy już domeny znalezionej przez fallback.
          enrichLog.website.url    = websiteUrl;
          enrichLog.website.source = websiteSource;
        }
        // else: fallback nic nie znalazł — zostajemy przy wyniku fast
        // oryginalnego URL-a (scanStage='fast'), identityCheck wciąż
        // niepotwierdzony — patrz gałąź needs_review niżej.
      }

      websiteText     = scraped.text;       // string — wszystkie sprawdzenia .trim()/.length niżej bez zmian
      scrapedContacts = scraped.contacts;
      enrichLog.website.chars_extracted = websiteText.length;
      enrichLog.website.pages_count = (websiteText.match(/^\[/gm) || []).length || 1;
      // Deduplikacja fragmentów (decyzja 20.08) — liczba znaków przed/po
      // usunięciu dokładnych powtórek między podstronami; chars_after === ta
      // sama liczba co chars_extracted (dedup już wliczony do websiteText).
      if (scraped.dedup) enrichLog.website.dedup = scraped.dedup;
      // Diagnostyka per-kandydat (decyzja 19.08) — żadna strona nie znika bez
      // śladu: url, próby, status HTTP, długości przed/po, czy weszła do
      // finalnej treści, i dokładny powód jeśli nie.
      enrichLog.website.candidates = scraped.diagnostics || [];
      // Szczegóły identity-check (decyzja 20.08) — NIP/KRS/REGON sprawdzone i
      // trafione, nazwa firmy vs title/h1, adres z KRS/GUS i czy trafił w
      // tekście, oraz czy wykryto konflikt zagranicznego adresu.
      enrichLog.website.identity_check = {
        verified: identityCheck.verified,
        reason:   identityCheck.reason,
        evidence: identityCheck.evidence || null,
      };
      // Zapisane od razu (nie dopiero po AI) — inaczej wczesne return'y niżej
      // (identity-check-fail, brak treści) nigdy nie zapisywały scan_stage,
      // mimo że skan już się odbył (decyzja 20.08, znaleziona luka w logach).
      enrichLog.website.scan_stage = scanStage;

      if (!trustedByHuman && websiteText.trim() && !identityCheck.verified) {
        // Domena nie przeszła weryfikacji tożsamości — niezależnie od źródła
        // (csv_import/legacy_unknown/resolver — decyzja 20.08, po regresji
        // KZN/Wagner-service/Dach Centrum: poprzednio tylko 'manual' szedł tu,
        // a domeny z resolvera po nieudanym checku po cichu leciały dalej z
        // pustym tekstem do AI, co dawało 0/needs_review z zerowych sygnałów
        // zamiast jawnego "niepotwierdzona domena"). NIE wysyłamy treści do
        // modelu — mogłaby dotyczyć zupełnie innej firmy. Rekord idzie do
        // needs_review z flagą do ręcznej korekty adresu, a stare icp_score/
        // icp_signals są jawnie czyszczone, żeby nie zostawić w bazie
        // nieaktualnego "qualified" obok nieaktualnej domeny.
        logger.info('[Prospect] Domain failed identity check — flagging for manual review, skipping AI', { prospectId, websiteUrl, websiteSource, websiteMethod, reason: identityCheck.reason });
        enrichLog.website.identity_check_failed = true;
        const flags = calcIcpDowngradeFlags(websiteUrl, 'unconfirmed', true);
        await persistUpdate(
          `UPDATE prospect_companies SET
             enrichment_status   = 'done',
             website_url         = $2,
             website_source      = COALESCE(website_source, $5),
             website_status      = 'unconfirmed',
             icp_score            = NULL,
             icp_signals           = NULL,
             icp_gates              = NULL,
             icp_bonus_signals       = NULL,
             icp_gate_status          = 'needs_review',
             icp_downgrade_flags       = $3,
             enriched_at                = NOW(),
             enrichment_log               = $4
           WHERE id = $1`,
          [prospectId, websiteUrl, JSON.stringify(flags), JSON.stringify(enrichLog), websiteSource]
        );
        return {
          status: 'needs_review', prospectId, reason: 'domain_unconfirmed',
          ...(dryRun ? { dryRun: true, enrichment_log: enrichLog } : {}),
        };
      }

      // Jeśli scraping nie zwrócił żadnej treści (timeout, 403, parking page itp.)
      // → kontynuuj z pustym tekstem jeśli mamy dane KRS lub LinkedIn
      // → zatrzymaj tylko gdy nie ma żadnych danych do analizy
      if (!websiteText.trim()) {
        // 'blocked' gdy URL znaleziony ale scraping zablokowany (Cloudflare/WAF); 'failed' gdy brak odpowiedzi
        websiteStatus = websiteUrl ? 'blocked' : 'failed';
        enrichLog.website.scrape_failed = true;
        if (!linkedinText.trim() && !krsData) {
          await persistUpdate(
            `UPDATE prospect_companies SET
               enrichment_status = 'no_website',
               website_url       = COALESCE($3, website_url),
               website_status    = $4,
               icp_score          = NULL,
               icp_signals         = NULL,
               icp_gates            = NULL,
               icp_bonus_signals     = NULL,
               icp_gate_status        = 'needs_review',
               enriched_at             = NOW(),
               enrichment_log           = $2
             WHERE id = $1`,
            [prospectId, JSON.stringify(enrichLog), websiteUrl, websiteStatus]
          );
          logger.info('[Prospect] Website scrape returned no content — stopping', { prospectId, websiteUrl });
          return { status: 'no_website', prospectId, ...(dryRun ? { dryRun: true, enrichment_log: enrichLog } : {}) };
        }
        logger.info('[Prospect] Website scrape failed — continuing with KRS/LinkedIn data', { prospectId, websiteUrl, hasKrs: !!krsData, hasLinkedin: !!linkedinText.trim() });
      } else {
        websiteStatus = 'ok';
      }
    }

    // 4. AI analysis — dokładnie jedno wywołanie na firmę (decyzja 20.08: AI
    // nie jest już wywoływane na etapie fast, patrz sekcja 3 wyżej — jeśli
    // websiteUrl istnieje, w tym miejscu websiteText to już treść pełnego
    // crawla albo pusta treść ze ścieżek bez strony/danych, nigdy sama treść fast).
    const { result: analysis, provider: usedProvider, model: usedModel, usage: aiUsage } = await analyzeWithAi(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText);

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
      // Dokładny model z odpowiedzi API (nie z konfiguracji requestu) — np.
      // DeepSeek zwraca "deepseek-v4-flash" mimo że w requeście wysłaliśmy
      // model: "deepseek-chat" (alias). Fallback na stałą tylko gdyby usage/model
      // nie przyszły w odpowiedzi.
      model:        usedModel || (usedProvider === 'anthropic' ? ANTHROPIC_MODEL : DEEPSEEK_MODEL),
      icp_raw:      scoreResult.raw,
      icp_bonus:    bonusResult.bonus,
      icp_total:    totalScore,
      gate_status:  gateStatus,
      signal_reasoning: analysis?.signal_reasoning || null,
      prompt_tokens:            aiUsage?.prompt_tokens ?? null,
      completion_tokens:        aiUsage?.completion_tokens ?? null,
      prompt_cache_hit_tokens:  aiUsage?.prompt_cache_hit_tokens ?? null,
      prompt_cache_miss_tokens: aiUsage?.prompt_cache_miss_tokens ?? null,
    };

    // 5. Zapis do DB
    const aiContacts  = Array.isArray(analysis?.key_contacts) ? analysis.key_contacts : [];
    const merged      = mergeContacts(aiContacts, scrapedContacts.emails, scrapedContacts.phones);
    const keyContacts = merged.length > 0 ? merged : null;

    await persistUpdate(
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
        website_source            = COALESCE(website_source, $28),
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
        websiteSource || null,
      ]
    );

    return {
      status: 'done', prospectId,
      ...(dryRun ? {
        dryRun: true,
        icp_score: totalScore,
        icp_signals: scoreResult.breakdown,
        icp_gates: analysis?.gates || null,
        icp_gate_status: gateStatus,
        ai_summary: analysis?.ai_summary || null,
        enrichment_log: enrichLog,
      } : {}),
    };
  } catch (err) {
    await persistUpdate(
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

module.exports = {
  enrichOne, reEnrichOne, runBatch, getBatchProgress, buildPromptText,
  // Eksport dodatkowy na potrzeby menuAuditTool.js — diagnostyczne narzędzie
  // audytu menu nawigacyjnego, reużywa scrapingu zamiast duplikować go.
  fetchKRS, findWebsiteUrl, scrapeWebsite, normalizeName, fetchPage, extractText, extractInternalLinks, scoreLinkRelevance,
  checkDomainIdentity, isDomainParkingPage,
  // Eksport na potrzeby ręcznego/testowego wywołania fallbacku drugiej domeny
  // w izolacji (audyt 21.08) — enrichOne woła resolveDomainFallback()
  // wewnętrznie (patrz gałąź "domena niepotwierdzona i nie zaufana"), ten
  // eksport służy tylko testom poza pełnym przebiegiem enrichmentu.
  guessFallbackDomains, resolveDomainFallback, scrapeWebsiteFast,
};
