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
const https      = require('https');
const cheerio    = require('cheerio');
const db         = require('../config/database');
const logger     = require('../utils/logger');
const gusRegon   = require('./gusRegonService');
const { normalizeWebsiteUrl, normalizeLinkedinUrl } = require('../utils/urlUtils');
const tenantIcpConfigService = require('./tenantIcpConfigService');

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
  // Poprawka 19.09: "handlowc[yi]"/"handlow[yi]c" był błędnym zawężeniem (nie
  // łapał np. "handlowca", "handlowiec", "handlowych") — goły rdzeń "handlow"
  // łapie WSZYSTKIE odmiany przez samo dopasowanie podciągu, bez wyliczanki.
  // Poprawka 19.09 (druga tura, po regresji Berlinerluft): goły rdzeń "handlow"
  // łapał też "Ogólne Warunki Handlowe" (regulamin, nie dowód sprzedażowy) i
  // wypychał prawdziwą stronę zespołu z budżetu. excludeIfLegalDocument=true
  // — patrz LEGAL_DOCUMENT_PATTERN i scoreLinkRelevance().
  { pattern: /handlow|dzial.handlow|siec.handlow|sprzedaz|przedstawiciel|opiekun.klienta|opiekun.region|regionaln\w*.opiek|sales.rep|account.manager/i, score: 9, excludeIfLegalDocument: true },
  // Serwis techniczny w terenie / serwisanci — sygnał field_service + key contacts
  { pattern: /serwisanc|serwis.techniczny|serwis.terenowy|ekipa.serwis|technicy.terenow/i, score: 8 },
  // Firma, opis działalności — "poznaj nas" też tutaj (Medicover, Luxmed)
  { pattern: /o.nas|o.firmie|about|historia|kim.jestesmy|who.we.are|przedstawiamy|poznaj/i, score: 8 },
  // Usługi/oferta/wycena/konsultacja/doradztwo — sygnały custom_quote_process
  // i consultation_demo_needs_analysis. Poprawka 19.09: "oferta" jako dosłowna
  // forma nie łapała "oferty"/"ofertowy" (różna końcówka = różny podciąg) —
  // zamienione na rdzeń "ofert". Dodane wycena/konsultacja/doradztwo/dobór,
  // wcześniej nigdzie nie rozpoznawane mimo że to główne słowa kluczowe tych
  // dwóch sygnałów. "usługi" z polskim "ł" usunięte jako martwy kod — ten
  // wariant nigdy nie trafiał (anchor jest odakcentowywany przed dopasowaniem).
  { pattern: /uslug|services|ofert|rozwiazani|wycen|konsultacj|doradztw|dob[oó]r|solution|produkt|products/i, score: 7 },
  // Oddziały i lokalizacje — klasyczne i healthcare-specific. Poprawka 19.09:
  // "oddziały"/"placówk" z polskimi znakami to martwy kod (anchor jest
  // odakcentowywany PRZED dopasowaniem, patrz deaccent() — te warianty z ą/ł/ó
  // nigdy się nie mogły dopasować). Rdzenie "oddzia"/"lokalizacj" łapią
  // wszystkie odmiany przez sam podciąg.
  { pattern: /oddzia|lokalizacj|locations|biur[ao]|offices|gdzie.jestesmy|placowk|klinik|centra|przychodn|apteki|salon[yi]|punkt.obs/i, score: 9 },
  // Wyszukiwarki lokalizacji ("Znajdź placówkę", "Wyszukaj centrum") — silny sygnał wielu lokalizacji
  { pattern: /znajdz|wyszukaj/i, score: 7 },
  // Kariera — ogłoszenia o pracę
  { pattern: /kariera|praca|jobs|careers|rekrutacja|dolacz|join/i, score: 6 },
  // Sieć partnerów/dealerów — USUNIĘTE STĄD 19.09 (druga tura, po regresji
  // Arpol): płaski wzorzec "partner|dealer|dystrybu" o stałym score 8 łapał
  // RÓWNIEŻ artykuły/newsy o wydarzeniach branżowych osób trzecich ("Genetec
  // Partner Day", "Bosch Partner Day") na równi z prawdziwym dowodem własnej
  // sieci dealerskiej — 5 niemal identycznie ocenionych stron konkurowało o
  // to samo 1-2 miejsca budżetu kategorii "partnerzy". Zastąpione dwupoziomową
  // logiką w scoreLinkRelevance() (PARTNER_STRONG_PATH/PHRASE vs
  // PARTNER_WEAK_PATTERN) — dedykowana strona sieci dostaje wysoki score,
  // gołe wystąpienie słowa "partner" w artykule dostaje niski.
  // "realizacje"/"referencje"/"przetargi" — dowody projektowe i sygnał
  // tender_bidding_department. Poprawka 19.09 (audyt retrievalu): to był
  // najniżej scorowany wzorzec w całej tabeli (6 pkt) i JEDYNY sygnał ICP bez
  // własnego słowa kluczowego "przetarg" — podniesione do 8 i dodane
  // "przetarg"/"zamówienia publiczne", żeby realnie konkurowały o top-12
  // zamiast przegrywać z każdą inną kategorią.
  { pattern: /realizacj|referencj|case.stud|przetarg|zam[oó]wien\w*.publiczn/i, score: 8 },
  // Sklep/e-commerce B2B i zapytania ofertowe (RFQ) — dodane po korektach
  // 20.08 (Wagner-service "Sklep internetowy" i Kigema "zapytanie ofertowe"
  // nigdy nie trafiały do kandydatów, bo nie było dla nich żadnego wzorca).
  // Dodane 19.09: "strefa klienta"/"panel klienta" — częste polskie
  // odpowiedniki "portalu B2B", dotąd nierozpoznawane.
  { pattern: /sklep|shop|e-?commerce|portal.?b2b|konto.?klient|strefa.?klient|panel.?klient|koszyk|checkout|zapytani\w*.?ofert|request.?for.?quot|\brfq\b/i, score: 8 },
  // Gołe "B2B" w menu (link do portalu/subdomeny b2b.<domena>), "hurt" i
  // "współpraca" — dodane po audycie 24.08 (7 rozbieżności AI vs. ręczna
  // weryfikacja: MPL Power, Wodmax miały wprost link "B2B" do b2b.<domena>
  // w menu głównym, Wama Gold anchor "Wyroby jubilerskie - hurt" — wszystkie
  // scorowały 0, więc przegrywały o miejsce w top-12 z ogólnym "Kontakt"/
  // "O nas" mimo realnego znaczenia biznesowego). "platforma" celowo
  // ograniczona do bliskiego kontekstu b2b/zakupów/klientów, żeby nie łapać
  // niezwiązanych trafień typu "platforma widokowa"/"platforma edukacyjna".
  { pattern: /\bb2b\b|\bhurt\w*|wspolprac\w*|platforma.{0,20}\b(b2b|zakup\w*|klient\w*)\b/i, score: 8 },
  // Strony opisujące szczegółowy proces obsługi/certyfikacji/akredytacji —
  // dotąd nierozpoznawane żadnym wzorcem (case: Inova — "Certyfikacja
  // wyrobów", opis wstępnej rozmowy o wymaganiach/dokumentacji/opłatach,
  // score=0 → link filtrowany PRZED dotarciem do budżetu treści, mimo że
  // był na homepage z anchorem "Biuro Certyfikacji Wyrobów").
  { pattern: /certyfikacj|akredytacj|procedura|zasady.wsp[oó]lpracy|jak.to.dziala|jak.dzia[lł]a|krok.po.kroku/i, score: 8 },
  // Sekcja "dla firm"/"przedsiębiorstwa"/bankowość korporacyjna — dotąd
  // nierozpoznawana żadnym wzorcem (audyt 22.09, case Alior Bank: link menu
  // głównego "Przedsiębiorstwa" → /przedsiebiorstwa.html, z realnym opisem
  // "Centra Bankowości Korporacyjnej... profesjonalna opieka doradców",
  // scorował 0/1 i przegrywał o miejsce w top kandydatów z dziesiątkami
  // stron niezwiązanych z B2B, mimo że extractInternalLinks() go poprawnie
  // odkrywał — to była luka w SCORINGU linków, nie w discovery ani w
  // extractText()). Generalizowalne — nie tylko dla banków.
  { pattern: /przedsiebiorstw|korporacyjn|dla.{0,3}firm|\bbiznes\w*/i, score: 8 },
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

// Człony opisowe/prawne/spójnikowe pomijane przy wyborze "najbardziej
// charakterystycznego słowa" nazwy firmy — współdzielone przez nameTokensMatch()
// (identity-check, niżej) i guessFallbackDomains() (fallback drugiej domeny,
// dalej w pliku). Bez tego filtra dwie różne firmy zaczynające się od
// "Przedsiębiorstwo..." dają identyczny (błędny) pierwszy token — dla
// nameTokensMatch to fałszywe odrzucenie identity-check (case: Kopalnia
// Ogorzelec, Insbud — audyt 21.08: title strony ewidentnie zawiera markę,
// ale "przedsiebiorstwo" jako pierwsze słowo nigdy się w title nie pojawia),
// dla guessFallbackDomains identyczna błędna propozycja domeny (case: Fortech
// i Zetpri-Rembud, oba na przedsiebiorstwo.com.pl).
const GENERIC_NAME_WORDS = new Set([
  'przedsiebiorstwo', 'firma', 'osrodek', 'rozlewnia', 'centrum', 'zaklad', 'zaklady',
  'grupa', 'biuro', 'instytut', 'spolka',
  'badan', 'certyfikacji',
  'wod', 'mineralnych',
  // Kolejne opisowe człony po "przedsiębiorstwo" — filtr musi przejść PRZEZ
  // WSZYSTKIE z nich, nie tylko pierwsze słowo, żeby dotrzeć do właściwej
  // marki (case: "Przedsiębiorstwo Wielobranżowe Kopalnia Ogorzelec" — bez
  // 'wielobranzowe' pierwszym niegenerycznym słowem zostawało "wielobranżowe",
  // nie "kopalnia"; "Przedsiębiorstwo Robót Instalacyjnych 'insbud'" — bez
  // 'robot'/'instalacyjne(-ych)' zostawało "robót"/"instalacyjnych", nie
  // "insbud" — oba potwierdzone empirycznie, patrz test 21.08 na tych firmach)
  'robot',
  // Człony częste w nazwach spółek-córek/grup kapitałowych — same w sobie nie
  // odróżniają marki (case: Ameri-pol Trading, Epam Systems (Poland))
  'trading', 'systems', 'polska', 'poland', 'holding', 'group', 'international',
  // Generyczne określenia typu działalności — nie są marką (case: Tenir Serwis)
  'serwis', 'service', 'uslugi',
  // Spójniki
  'i', 'z', 'w', 'na', 'do', 'dla', 'oraz', 'a',
  // Formy prawne (bugfix 23.09). normalizeName() obcina formę prawną TYLKO na
  // KOŃCU nazwy (kotwica `\s*$`). Gdy siedzi w środku — a w tych danych to
  // bardzo częste, bo opis działalności idzie po formie ("Zimnik sp. z o.o.
  // Kopalnia Granitu") — tokeny 'sp'/'z'/'o' zostają i wchodzą do nazwy
  // domeny. Efekt: zimniksp.com.pl / zimnik-sp.pl zamiast zimnik.pl, czyli
  // WSZYSCY czterej kandydaci bezużyteczni. Zmierzone na batchu
  // workend_ola_9001-10000: 63 firmy z 1096 (5,7%) miały zerową szansę.
  // Świadomie NIE ma tu 'zoo' — "z o.o." nigdy nie tokenizuje się do 'zoo'
  // (rozpada się na 'z','o','o'), więc filtr trafiałby wyłącznie w prawdziwe
  // nazwy typu "Zoo Wrocław".
  'sp', 'spzoo', 'ltd', 'gmbh', 'inc', 'llc',
  // "Euro" jako pierwszy człon nazwy jest zbyt generyczny, żeby samodzielnie
  // potwierdzać domenę (strong_brand_identity V3, 21.09) — case Euro-Net →
  // euro.com.pl dawał fałszywe dopasowanie tokenu "euro" do dowolnej domeny
  // zawierającej ten ciąg.
  'euro',
]);

// Rdzenie polskich przymiotników opisujących RODZAJ działalności (nie markę),
// dopasowywane po PREFIKSIE zamiast dokładnym słowem — polska fleksja daje
// wiele końcówek tego samego rdzenia (-y/-e/-a/-o/-ych/-ej/-ymi...), a
// GENERIC_NAME_WORDS jako zbiór dokładnych słów wymagałby wymieniania każdej
// z osobna. Luka tego typu naprawdę wystąpiła (audyt INT, 18.09): "Przedsiębiorstwo
// PRODUKCYJNO-HANDLOWE 'Mirex'" miało na liście tylko formy dla "instalacyjne"/
// "wielobranżowe" — "produkcyjno"/"handlowe" nigdy nie były filtrowane, więc
// nameTokensMatch wybierał "produkcyjno" jako "najbardziej charakterystyczne
// słowo" zamiast "mirex", i odrzucał poprawną domenę mimo trafienia adresowego
// 1:1. Rozwiązanie ogólne (rdzenie, nie pojedynczy wyjątek), bo ten sam wzorzec
// ("X-handlowe", "X-usługowe" itd.) jest bardzo częsty w polskich nazwach spółek.
const GENERIC_NAME_STEMS = [
  'produkcyjn',   // produkcyjne/produkcyjna/produkcyjno/produkcyjnych
  'handlow',      // handlowe/handlowa/handlowo/handlowych
  'uslugow',      // usługowe/usługowa/usługowo/usługowych
  'budowlan',     // budowlane/budowlana/budowlano/budowlanych
  'transportow',  // transportowe/transportowa/transportowo
  'spedycyjn',    // spedycyjna/spedycyjne/spedycyjnych
  'montazow',     // montażowe/montażowa/montażowych
  'projektow',    // projektowe/projektowa/projektowo
  'remontow',     // remontowe/remontowa/remontowo
  'inzynieryjn',  // inżynieryjno/inżynieryjne/inżynieryjna
  'wdrozeniow',   // wdrożeniowe/wdrożeniowa/wdrożeniowych
  'innowacyjn',   // innowacyjno/innowacyjne/innowacyjna
  'wielobranz',   // wielobranżowe/wielobranżowa/wielobranżowych
  'instalacyjn',  // instalacyjne/instalacyjnych/instalacyjna
];

function isGenericNameWord(word) {
  return GENERIC_NAME_WORDS.has(word) || GENERIC_NAME_STEMS.some(stem => word.startsWith(stem));
}

// Najbardziej charakterystyczne słowo nazwy firmy (pierwsze PO odfiltrowaniu
// GENERIC_NAME_WORDS/GENERIC_NAME_STEMS) — współdzielone przez nameTokensMatch
// (identity-check) i strong_brand_identity V3 (evaluateBrandIdentityFallback,
// niżej), żeby obie ścieżki liczyły token tej samej firmy dokładnie tak samo.
function firstDistinctiveNameToken(companyName) {
  const norm  = normalizeName(companyName);
  const words = norm.split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !isGenericNameWord(w));
  return words[0] || null;
}

// Dopasowuje najbardziej charakterystyczne słowo nazwy firmy do title/h1
// strony — ten sam wzorzec co guessDomainsFromName()/guessFallbackDomains()
// używają do zgadywania domen.
function nameTokensMatch(companyName, titleText) {
  if (!companyName || !titleText) return false;
  const firstWord = firstDistinctiveNameToken(companyName);
  if (!firstWord) return false;
  return normalizeName(titleText).includes(firstWord);
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
  // Silne dopasowanie adresowe (audyt INT, 18.09): kod pocztowy ORAZ ulica
  // TRAFIONE JEDNOCZEŚNIE, niezależnie od nazwy — wystarcza samo, bez nameHit.
  // Powód: nameHit zawodzi po rebrandingu/zmianie nazwy spółki (case: "Musi
  // Novum" → "Hunters Novum" na stronie, "Novum" w rekordzie CRM — tytuł
  // strony nie dzieli już żadnego tokenu z nazwą rejestrową), a dwa NIEZALEŻNE
  // trafienia adresowe naraz (nie jedno, jak w słabym dowodzie niżej) to
  // dowód praktycznie tak mocny jak NIP — przypadkowa strona nie będzie miała
  // akurat TEJ ulicy I TEGO kodu pocztowego wpisanych razem w treści.
  // Pojedyncze trafienie (samo postcode LUB sama ulica) NIE kwalifikuje się
  // tutaj — zostaje w słabym dowodzie niżej, wciąż wymagającym nameHit.
  const strong = postcodeHit && streetHit;
  return { positive: !!(postcodeHit || streetHit), negative, strong, postcodeHit, streetHit, foreignHit };
}

// Decyduje czy domena (zgadnięta/wyszukana LUB ręcznie podana z CSV, gdy
// wywołana z tego kontekstu) faktycznie należy do analizowanej firmy.
//
// Mocny dowód (wystarcza sam): NIP, KRS lub REGON znalezione w treści strony,
// LUB kod pocztowy + ulica z KRS/GUS trafione JEDNOCZEŚNIE (niezależnie od
// nazwy — patrz identitySecondarySignal/strong).
// Słaby dowód (wymaga OBU): nazwa w title/h1 ORAZ pojedynczy element adresu
// (ulica LUB kod pocztowy) z danych rejestrowych KRS lub GUS. Samo miasto nie wystarcza.
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
  // Silny dowód adresowy (postcode + ulica jednocześnie) wystarcza sam, bez
  // nameHit — patrz komentarz przy identitySecondarySignal/strong. Sprawdzany
  // PRZED słabym dowodem, żeby nie zależeć od kolejności.
  if (secondary.strong) return { verified: true, reason: 'strong_registry_address', nameHit, secondary, evidence };
  if (nameHit && secondary.positive) return { verified: true, reason: 'name_plus_registry_address', nameHit, secondary, evidence };
  return { verified: false, reason: 'insufficient_evidence', nameHit, secondary, evidence };
}

// ── Monotonic identity resolution (21.09, po benchmarku 50 firm) ───────────
// Problem znaleziony w praktyce: identityCheck.verified===true ustawione przez
// runIdentityFallback LUB evaluateBrandIdentityFallback (V3) było CICHO
// gubione, gdy kod po dokończeniu pełnego crawla przeliczał tożsamość jeszcze
// raz na szerszej treści (computeIdentityCheck(scraped)) i ta druga próba nie
// znalazła TEGO SAMEGO dowodu — np. bo dowodowa podstrona odpadła z finalnego
// tekstu przez limit global_12k_truncation (case PSE), albo bo dowód V3
// (brand-consistency) w ogóle nie jest czymś, co checkDomainIdentity umie
// wykryć (case Pepco/Kanał 6 — zawsze "insufficient_evidence" na recompute,
// bo ta funkcja nie zna V3). Poprzedni fix (`identityFallback?.verified`)
// naprawiał to tylko dla STRICT fallbacku, nie dla V3 — stąd ten ogólny,
// nazwany mechanizm zamiast kolejnego doraźnego warunku.
//
// Zasada (wymóg biznesowy, nie tylko techniczny): sam BRAK dowodu w kolejnym,
// bardziej ograniczonym materiale NIE jest dowodem, że wcześniejsza
// weryfikacja była błędna — więc `insufficient_evidence` NIGDY nie cofa
// wcześniejsze verified:true. Cofnąć je może WYŁĄCZNIE odkrycie NOWEGO,
// twardego, pozytywnego dowodu konfliktu (inny podmiot/adres/numer
// rejestrowy) — te powody ZAWSZE wygrywają, niezależnie od tego, co ustalił
// wcześniejszy etap. Priorytet: hard conflict > wcześniejsze verified >
// insufficient_evidence.
const HARD_IDENTITY_CONFLICT_REASONS = new Set([
  'foreign_address_conflict',
  'legal_entity_conflict',
  'foreign_entity_or_country_conflict',
  'different_entity_brand',
]);

function resolveIdentityMonotonically(previous, next) {
  if (next?.reason && HARD_IDENTITY_CONFLICT_REASONS.has(next.reason)) return next; // twardy konflikt zawsze wygrywa, nawet nad wcześniejszym verified
  if (previous?.verified && !next?.verified) return previous; // sam brak dowodu (insufficient_evidence i podobne) nie cofa wcześniejszej weryfikacji
  return next; // next.verified===true (potwierdzenie/mocniejszy dowód), albo previous i tak nie było verified
}

// ── Identity fallback: dane prawne firmy poza homepage (20.09, case Alior Bank) ──
// checkDomainIdentity() na treści z fast-scanu nie widzi stopki ani całych
// podstron: extractText() zwraca tylko <main> i tnie do 6000 znaków (limit
// budżetu dla AI), a fast-scan pobiera tylko 4 najlepiej punktowane linki, wśród
// których rzadko jest strona z danymi rejestrowymi. Alior: NIP, REGON, ulica i
// kod pocztowy są w HTML /kontakt (18 tys. znaków), ale poza pierwszymi 6000.
// Zanim domena trafi do needs_review/domain_unconfirmed, sprawdzamy więc (bez
// pełnego crawla): PEŁNY tekst homepage z już pobranego HTML + maksymalnie
// IDENTITY_FALLBACK_MAX_PAGES stron o znaczeniu prawnym/kontaktowym.
//
// PRECYZJA (nie poluzowujemy identity checka): fallback zatwierdza domenę
// WYŁĄCZNIE po mocnym dowodzie znalezionym na JEDNEJ stronie tej samej domeny:
// NIP, KRS lub REGON, albo kod pocztowy + ulica jednocześnie. Słaba reguła
// "nazwa w title + pojedynczy element adresu" NIE działa w fallbacku (na dużych
// stronach kod pocztowy trafia się przypadkiem). Sama nazwa/podobieństwo domeny
// nigdy nie wystarcza; konflikt zagranicznego adresu nadal blokuje.
const IDENTITY_TEXT_MAX_CHARS = 300_000;
const IDENTITY_FALLBACK_MAX_PAGES = 5;
const IDENTITY_FALLBACK_MAX_DISCOVERED = 3;
const IDENTITY_FALLBACK_STRICT_REASONS = new Set(['nip_match', 'krs_match', 'regon_match', 'strong_registry_address']);

// Kolejność = prawdopodobieństwo, że strona ma pełne dane rejestrowe.
const IDENTITY_PAGE_RANKS = [
  /dane[-_.]?(spolki|rejestrowe|firmy)|informacje[-_.]?prawne|nota[-_.]?prawna|impressum|stopka|company[-_.]?(details|data)|legal[-_.]?(notice|info)/i,
  /polityka[-_.]?prywatnosci|privacy|rodo|regulamin|terms/i,
  /kontakt|contact/i,
  /o[-_.]?nas|o[-_.]?firmie|o[-_.]?spolce|about/i,
];
const IDENTITY_DEFAULT_PATHS = ['/kontakt', '/o-firmie', '/o-nas', '/polityka-prywatnosci', '/regulamin'];

// PEŁNY tekst strony do sprawdzania tożsamości: bez ograniczenia do <main>, bez
// cięcia do 6000 znaków, z JSON-LD (structured data). To NIE jest tekst dla AI.
function extractIdentityText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (raw) jsonLd.push(raw);
  });
  $('script, style, noscript, iframe').remove();
  const body = $('body').text() || $.root().text();
  return `${body} ${jsonLd.join(' ')}`.replace(/\s+/g, ' ').trim().slice(0, IDENTITY_TEXT_MAX_CHARS);
}

function sameSiteHost(urlA, urlB) {
  try {
    const host = u => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return host(urlA) === host(urlB);
  } catch {
    return false;
  }
}

// Wybiera do sprawdzenia kilka stron: najpierw odkryte linki o znaczeniu
// prawnym/kontaktowym (max 3, wg rangi), potem standardowe ścieżki (m.in.
// /kontakt), łącznie max IDENTITY_FALLBACK_MAX_PAGES. Zwraca pełne URL-e.
function pickIdentityFallbackUrls(links, baseUrl, { maxPages = IDENTITY_FALLBACK_MAX_PAGES, maxDiscovered = IDENTITY_FALLBACK_MAX_DISCOVERED } = {}) {
  const normPath = p => (String(p || '').toLowerCase().replace(/\/+$/, '') || '/');
  const chosen = new Map();
  const ranked = [];
  for (const l of (links || [])) {
    if (!l || !l.path || l.path === '/') continue;
    const rank = IDENTITY_PAGE_RANKS.findIndex(re => re.test(`${l.path} ${deaccent(l.anchor || '')}`));
    if (rank === -1) continue;
    ranked.push({ l, rank, depth: l.path.split('/').filter(Boolean).length });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.l.path.length - b.l.path.length);
  for (const { l } of ranked) {
    if (chosen.size >= maxDiscovered) break;
    const key = normPath(l.path);
    if (chosen.has(key)) continue;
    try { chosen.set(key, l.fullHref || new URL(l.path, baseUrl).toString()); } catch { /* zły link — pomiń */ }
  }
  for (const p of IDENTITY_DEFAULT_PATHS) {
    if (chosen.size >= maxPages) break;
    const key = normPath(p);
    if (chosen.has(key)) continue;
    try { chosen.set(key, new URL(p, baseUrl).toString()); } catch { /* zła baza — pomiń */ }
  }
  return [...chosen.values()];
}

// Pełna nazwa prawna (bez formy prawnej) w tekście — wyłącznie DIAGNOSTYKA;
// o zatwierdzeniu domeny nie decyduje.
function legalNameInText(companyName, text) {
  const core = deaccent(String(companyName || '').toLowerCase())
    .replace(/\s+(sp\.?\s*z\s*o\.?\s*o\.?|s\.?\s*a\.?|sp\.?\s*k\.?|sp\.?\s*j\.?|spolka\b.*)$/i, '')
    .trim();
  return core.length >= 5 && deaccent(String(text || '').toLowerCase()).includes(core);
}

// CZYSTA funkcja decyzyjna fallbacku — testowalna bez sieci. Każde źródło
// (homepage / podstrona) oceniane OSOBNO regułami checkDomainIdentity, żeby
// cyfry z końca jednego tekstu nie łączyły się z początkiem innego w fałszywy
// NIP. Zatwierdza tylko strict reasons (patrz IDENTITY_FALLBACK_STRICT_REASONS).
function evaluateIdentityFallback({ company, krsData, gusData, title, sources }) {
  const perSource = [];
  let decided = null;
  let foreignSource = null;
  let weakOnly = false;
  for (const src of (sources || [])) {
    const check = checkDomainIdentity({ nip: company.nip, text: src.text, title, company, krsData, gusData });
    const ev = check.evidence || {};
    perSource.push({
      source: src.label, chars: (src.text || '').length, reason: check.reason,
      hits: {
        nip: !!ev.nip_match, regon: !!ev.regon_match, krs: !!ev.krs_match,
        postcode: !!ev.postcode_hit, street: !!ev.street_hit,
        foreign_conflict: !!ev.foreign_conflict,
        legal_name: legalNameInText(company.company_name, src.text),
      },
    });
    if (!decided && check.verified && IDENTITY_FALLBACK_STRICT_REASONS.has(check.reason)) {
      decided = { source: src.label, reason: check.reason, evidence: check.evidence };
    } else if (check.verified) {
      weakOnly = true; // np. name_plus_registry_address — w fallbacku NIE wystarcza
    }
    if (!foreignSource && check.reason === 'foreign_address_conflict') foreignSource = src.label;
  }
  if (decided) {
    return { verified: true, reason: decided.reason, decided_by: `${decided.reason}@${decided.source}`, evidence: decided.evidence, sources: perSource };
  }
  const reason = foreignSource ? 'foreign_address_conflict' : 'insufficient_evidence';
  return {
    verified: false, reason,
    decided_by: foreignSource ? `foreign_address_conflict@${foreignSource}` : (weakOnly ? 'weak_evidence_not_accepted_in_fallback' : 'no_strict_evidence'),
    evidence: null, sources: perSource,
  };
}

// Część sieciowa: homepage z już pobranego HTML (0 requestów) + do 5 podstron
// równolegle (fetchPage, timeout 10 s, bez retry). Odrzuca strony, które po
// przekierowaniu wylądowały na INNYM hoście (obce dane nie mogą potwierdzać).
async function runIdentityFallback({ company, krsData, gusData, crawlState, title }) {
  const base = crawlState?.effectiveBase;
  if (!base) {
    return { attempted: false, verified: false, reason: 'no_crawl_state', decided_by: 'no_crawl_state', evidence: null, sources: [], pages_checked: [] };
  }
  const sources = [];
  if (crawlState.homepageHtml) sources.push({ label: 'homepage', text: extractIdentityText(crawlState.homepageHtml) });

  const links = crawlState.allLinks && typeof crawlState.allLinks.values === 'function' ? Array.from(crawlState.allLinks.values()) : [];
  const urls = pickIdentityFallbackUrls(links, base);
  const fetched = await Promise.all(urls.map(async url => {
    try {
      const { html, finalUrl } = await fetchPage(url);
      if (!html) return { url, status: 'empty' };
      if (!sameSiteHost(finalUrl, base)) return { url, status: 'other_host', final_host: (() => { try { return new URL(finalUrl).hostname; } catch { return null; } })() };
      return { url, status: 'ok', text: extractIdentityText(html) };
    } catch (e) {
      return { url, status: 'error', error: String(e.message || e).slice(0, 80) };
    }
  }));

  const pagesChecked = [];
  for (const f of fetched) {
    pagesChecked.push({ url: f.url, status: f.status, chars: f.text ? f.text.length : 0, ...(f.final_host ? { final_host: f.final_host } : {}), ...(f.error ? { error: f.error } : {}) });
    if (f.status === 'ok') sources.push({ label: f.url, text: f.text });
  }
  const verdict = evaluateIdentityFallback({ company, krsData, gusData, title, sources });
  // raw_sources (pełny tekst, nie tylko metadane z evaluateIdentityFallback) —
  // reużywane przez evaluateBrandIdentityFallback (strong_brand_identity V3,
  // niżej), żeby nie pobierać tych samych stron drugi raz.
  return { attempted: true, ...verdict, pages_checked: pagesChecked, raw_sources: sources };
}

// ── strong_brand_identity V3 (21.09, case Pepco/Euro Freight/BSH-TROX) ──────
// Konserwatywny, DODATKOWY fallback uruchamiany WYŁĄCZNIE gdy runIdentityFallback
// powyżej zwrócił verified:false, reason:'insufficient_evidence' (NIE przy
// foreign_address_conflict — ten wciąż wygrywa bez zmian, patrz miejsce wywołania
// w enrichOne). Domena bez NIP/KRS/REGON/adresu w treści może i tak być
// prawidłowa (marka nie publikuje danych rejestrowych na stronie marketingowej —
// case Pepco), ale precyzja jest priorytetem: V1 (samo dopasowanie nazwy) miał
// prawie 0% recall po zaostrzeniu, V2 (punktowy brand-consistency bez sprawdzania
// obcego podmiotu) dawał realne ryzyko false positive (Euro Freight Logistics →
// eurofreight.com, strona cypryjskiej firmy o tej samej nazwie branżowej). V3
// dokłada DWA twarde negatywne sprawdzenia PRZED jakimkolwiek pozytywnym
// scoringiem marki — dopiero gdy oba przejdą czysto, liczone są punkty.
//
// Kolejność (żadna z tych trzech gałęzi nie zależy od kolejnej):
//   1. legal_entity_conflict            — NIP/KRS/REGON/pełna nazwa prawna
//      INNEGO polskiego podmiotu w treści.
//   2. foreign_entity_or_country_conflict — Tier A (twardy: strona
//      identyfikacyjna/JSON-LD/obcy numer rejestrowy) / Tier B (miękki: kraj w
//      title/treści, wymaga POLISH_LINK_EVIDENCE żeby NIE ograniczyć wyniku).
//   2b. different_entity_brand          — marka/nazwa prawna innego podmiotu
//      (z zagranicznym LUB polskim sufiksem prawnym) powtórzona w ≥2 niezależnych
//      miejscach (title + treść), przy ZEROWYM śladzie własnej marki na stronie
//      (case BSH Sprzęt Gospodarstwa Domowego → bsh.pl, który dziś faktycznie
//      serwuje treść TROX SE — title "Homepage | TROX SE Homepage" powtórzone na
//      wielu podstronach, żadna nie wspomina BSH).
//   3. brand consistency scoring        — punkty za domenę/title-h1/wielostronicową
//      spójność marki/​o-nas-kontakt, próg wyższy dla source='resolver' (domena
//      zgadnięta algorytmicznie nie może potwierdzić się sama podobieństwem
//      nazwy — wymaga silniejszego dowodu niż CSV/manual).
//   4. group/global portal cap          — title/H1 sugerujący portal
//      grupy/marki globalnej (Europe/Global/International/Worldwide) BEZ
//      dowodu powiązania z polską spółką ogranicza wynik do unresolved, nawet
//      jeśli punkty formalnie przekroczyłyby próg (case Follett Europe Polska →
//      folletteurope.com, title "Europe | Follett Ice" — prawdopodobnie
//      poprawne, ale bez potwierdzenia nie ryzykujemy false positive).

const BRAND_DOWNGRADE_CTX_RX = /partner|klient|dostawc|wykonawc|dystrybutor|sponsor|wsp[oó][łl]prac|zleceniodawc|kontrahent/i;
// Reużywa pierwszy (najsilniejszy) wzorzec z IDENTITY_PAGE_RANKS — te same
// ścieżki, którymi kieruje się już wybór stron do fallbacku. "Strona
// identyfikacyjna" = ranga 0 (impressum/nota prawna/dane spółki) ORAZ ranga 1
// (polityka prywatności/regulamin/RODO/terms) — dane operatora/właściciela
// strony równie często są w regulaminie/polityce prywatności co w stopce
// prawnej (case Ardix Pl → ardix.pl/polityka-prywatnosci: adres belgijskiego
// biura). Sama ranga 0 to za wąski zakres — bez rangi 1 ten dowód był
// niewidoczny dla foreign_entity_or_country_conflict/legal_entity_conflict,
// co dawało fałszywe brand_verified (znalezione przy walidacji benchmarku V3
// na realnej implementacji, 21.09).
const BRAND_IDENTITY_PAGE_RX = new RegExp(`${IDENTITY_PAGE_RANKS[0].source}|${IDENTITY_PAGE_RANKS[1].source}`, 'i');
const BRAND_ONAS_KONTAKT_PATH_RX = /o[-_.]?nas|o[-_.]?firmie|o[-_.]?spolce|about|kontakt|contact/i;
const PL_LEGAL_NAME_RX = /([A-ZŁŚŻŹĆŃÓĄĘ][\włśżźćńóąęĄĘŁŃÓŚŹŻ.-]*(?:\s+[A-ZŁŚŻŹĆŃÓĄĘ][\włśżźćńóąęĄĘŁŃÓŚŹŻ.-]*){0,4})\s+(Sp\.\s*z\s*o\.?\s*o\.?|S\.A\.|Sp\.\s*j\.|S\.K\.A\.)/g;
const FOREIGN_LEGAL_NAME_RX = /([A-ZÄÖÜ][\wÄÖÜäöüß&.-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß&.-]*){0,4})\s+(SE|AG|GmbH(?:\s*&\s*Co\.?\s*KG)?|Ltd\.?|PLC|LLC|Inc\.?|S\.p\.A\.|B\.V\.|N\.V\.)\b/g;
const FOREIGN_REGISTRY_NUMBER_RX = /Companies\s*House|Company\s*(?:Registration|Reg\.?)\s*(?:Number|No\.?)|HRB\s*[0-9]|Handelsregister|I[ČC]O[:\s]*[0-9]{8}|VAT\s*(?:number|no\.?|id)?[:\s]*(?:GB|DE|CZ|SK|NL|FR|IT|ES|CY|IE|LT|RO|HU|AT)[0-9A-Z]{6,}/i;
const FOREIGN_COUNTRY_NAME_RX = /\b(Cyprus|Cypr(?:u|em|owi)?|Germany|Niemc(?:y|ach|iec|zech)|Deutschland|United Kingdom|UK|Great Britain|United States|USA|France|Francj(?:a|i)|Italy|W[łl]och(?:y|ach)|Spain|Hiszpani(?:a|i)|Netherlands|Holandi(?:a|i)|Czech Republic|Czech(?:y|ach)|Slovakia|S[łl]owacj(?:a|i)|Switzerland|Szwajcari(?:a|i)|Ukraine|Ukrain(?:a|ie)|Lithuania|Litw(?:a|ie)|Ireland|Irlandi(?:a|i)|Belgium|Belgi(?:a|i)|Sweden|Szwecj(?:a|i)|Denmark|Dani(?:a|i)|Norway|Norwegi(?:a|i)|Hungary|W[eę]gr(?:y|ach|zech)|Romania|Rumuni(?:a|i)|China|Chin(?:y|ach)|Austria|Austri(?:a|i)|Portugal|Portugali(?:a|i))\b/;
const FOREIGN_JSONLD_COUNTRY_RX = /addressCountry"?\s*:\s*"?([A-Za-z]{2,24})"?/gi;
const SHIPPING_CONTEXT_RX = /wysy[łl]k\w*|dostaw\w*|shipping|deliver\w*|dor[eę]cz\w*|obs[łl]uguj[ea]my|dzia[łl]amy w|we (?:serve|operate|ship|deliver)|export\w*|eksport\w*|klient\w* z ca[łl]ego [śs]wiata|worldwide/i;
const POLISH_LINK_EVIDENCE_RX = /\bPolsk(?:a|i|ie|iej|iego)\b|\bPoland\b|oddzia[łl]\s*w\s*Polsce|filia\s*w\s*Polsce|local\s*office.{0,20}Poland|subsidiary.{0,20}Poland|europe\s*branch|biuro\s*w\s*Polsce|przedstawicielstwo\s*w\s*Polsce/i;
const GROUP_PORTAL_HINT_RX = /\bEurope\b|\bGlobal\b|\bInternational\b|\bWorldwide\b|\bGroup\b/i;
const LEGAL_BLOCK_WINDOW = 250;

// "Ten sam blok danych firmy" (spec 21.09, po fałszywych odrzuceniach K+L/
// ZBUiAND/Bemo Motors w walidacji V2→V3): jeśli w promieniu LEGAL_BLOCK_WINDOW
// wokół znalezionego KRS występuje TAKŻE nasz własny NIP lub REGON, a w tym
// samym oknie NIE ma innej jednoznacznej pełnej nazwy prawnej — uznajemy KRS za
// nasz, nawet gdy prospect.krs_number jest nieznany (null) i nie da się
// porównać wprost. Bez tego trzy realne firmy były fałszywie odrzucane
// wyłącznie z powodu luki w naszych danych, nie realnego konfliktu.
function isOwnRegistryBlock({ company, gusData, text, matchIndex }) {
  const windowText = text.slice(Math.max(0, matchIndex - LEGAL_BLOCK_WINDOW), matchIndex + LEGAL_BLOCK_WINDOW);
  const ownNipHit = nipFoundInText(company.nip, windowText);
  const ownRegonHit = regonFoundInText(gusData?.regon, windowText);
  if (!ownNipHit && !ownRegonHit) return false;
  // "Inna jednoznaczna pełna nazwa prawna" = WIĘCEJ NIŻ JEDNA odrębna nazwa w
  // tym samym oknie — NIE porównanie tokenu znalezionej nazwy z
  // firstDistinctiveNameToken(company.company_name). Powód (znaleziony przy
  // walidacji V2→V3, case K+L/ZBUiAND): firma na własnej stronie często
  // przedstawia się skrótem/akronimem ("ZBUiAND Sp. z o.o.", "K+L Biuro
  // Handlowe Polska"), którego żadna tokenizacja pełnej nazwy rejestrowej z
  // bazy nie odtworzy — porównanie token-do-tokenu fałszywie odrzucało takie
  // firmy jako "inny podmiot". Własny NIP/REGON w oknie już zakotwiczają blok
  // jako nasz; DOKŁADNIE JEDNA nazwa w całym oknie (niezależnie od jej
  // brzmienia) nie może jednocześnie być "naszą" i "czyjąś inną" — taki zbieg
  // okoliczności (ten sam NIP+REGON, ale nazwa innej firmy) praktycznie nie
  // występuje. Dwie LUB WIĘCEJ różnych nazw w oknie nadal blokują inferencję.
  const distinctTokens = new Set();
  let m;
  PL_LEGAL_NAME_RX.lastIndex = 0;
  while ((m = PL_LEGAL_NAME_RX.exec(windowText)) !== null) {
    const foundToken = firstDistinctiveNameToken(m[1]);
    if (foundToken) distinctTokens.add(foundToken);
  }
  return distinctTokens.size <= 1;
}

// NIP/KRS/REGON INNEGO podmiotu w treści (nie naszego) — z wykluczeniem
// kontekstu partner/klient/dostawca (wzmianka o kontrahencie nie jest
// konfliktem tożsamości) i own-registry-block inference dla KRS (patrz wyżej).
function findLegalEntityConflict({ company, krsData, gusData, sources }) {
  const ourKrsDigits = String(krsData?.krsNumber || '').replace(/\D/g, '').replace(/^0+/, '');
  const ourToken = firstDistinctiveNameToken(company.company_name);
  const LABELED_RX = {
    nip: /NIP[:\s]{0,10}([0-9][0-9\s.-]{8,13}[0-9])/gi,
    krs: /KRS[:\s]{0,10}(\d[\d\s.-]{4,12}\d)/gi,
    regon: /REGON[:\s]{0,10}(\d[\d\s.-]{7,16}\d)/gi,
  };
  for (const src of sources) {
    const text = src.text || '';
    const isIdentityPage = BRAND_IDENTITY_PAGE_RX.test(src.label || '');
    for (const [label, rx] of Object.entries(LABELED_RX)) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        const digits = m[1].replace(/\D/g, '').replace(/^0+/, '');
        if (digits.length < 6) continue;
        if (label === 'nip' && nipFoundInText(company.nip, m[0])) continue;
        if (label === 'regon' && regonFoundInText(gusData?.regon, m[0])) continue;
        if (label === 'krs') {
          if (ourKrsDigits && digits === ourKrsDigits) continue; // znamy własny KRS i się zgadza
          if (!ourKrsDigits && isOwnRegistryBlock({ company, gusData, text, matchIndex: m.index })) continue; // nieznany własny KRS, ale ten sam blok danych
        }
        const around = text.slice(Math.max(0, m.index - 100), m.index + 100);
        if (BRAND_DOWNGRADE_CTX_RX.test(around)) continue;
        return {
          conflict: true, type: `differing_${label}`, page: src.label, evidence: m[0].trim(),
          context: around.replace(/\s+/g, ' ').trim(),
        };
      }
    }
    if (isIdentityPage) {
      let m;
      PL_LEGAL_NAME_RX.lastIndex = 0;
      while ((m = PL_LEGAL_NAME_RX.exec(text)) !== null) {
        const foundToken = firstDistinctiveNameToken(m[1]);
        if (foundToken && foundToken !== ourToken) {
          const around = text.slice(Math.max(0, m.index - 100), m.index + 100);
          if (BRAND_DOWNGRADE_CTX_RX.test(around)) continue;
          return {
            conflict: true, type: 'differing_legal_name_on_identity_page', page: src.label, evidence: m[0].trim(),
            context: around.replace(/\s+/g, ' ').trim(),
          };
        }
      }
    }
  }
  return { conflict: false };
}

function extractForeignCountriesFromJsonLd(text) {
  const found = [];
  FOREIGN_JSONLD_COUNTRY_RX.lastIndex = 0;
  let m;
  while ((m = FOREIGN_JSONLD_COUNTRY_RX.exec(text)) !== null) found.push(m[1]);
  return found;
}

// Tier A (twardy, blokuje brand scoring): obcy kraj na stronie identyfikacyjnej,
// JSON-LD addressCountry != PL, lub jawny obcy numer rejestrowy. Tier B (miękki):
// kraj wspomniany w title/treści ogólnej poza kontekstem wysyłki/eksportu —
// zwraca dodatkowo polishLinkEvidence, decyzję (cap czy nie) podejmuje wywołujący.
function findForeignEntityOrCountryConflict({ sources, homepageTitle }) {
  for (const src of sources) {
    const text = src.text || '';
    for (const country of extractForeignCountriesFromJsonLd(text)) {
      if (!/^(PL|POLAND|POLSKA)$/i.test(country.trim())) {
        return { tier: 'A', type: 'jsonld_foreign_address_country', page: src.label, evidence: country };
      }
    }
    const registryMatch = FOREIGN_REGISTRY_NUMBER_RX.exec(text);
    if (registryMatch) {
      const around = text.slice(Math.max(0, registryMatch.index - 100), registryMatch.index + 100);
      return { tier: 'A', type: 'foreign_registry_number', page: src.label, evidence: registryMatch[0], context: around.replace(/\s+/g, ' ').trim() };
    }
  }
  // Nazwa obcego kraju (bez numeru rejestrowego/JSON-LD) — ZAWSZE Tier B,
  // NIGDY twardy Tier A, nawet na stronie identyfikacyjnej (polityka
  // prywatności/regulamin/impressum). Powód (znaleziony przy walidacji
  // benchmarku V3 na realnych 87 rekordach, 21.09): globalne firmy bardzo
  // często podają adres centrali grupy w polityce prywatności RODO — nawet na
  // stronie lokalnej/europejskiej spółki-córki (case Follett Europe Polska →
  // follettice.com/privacy-policy: adres centrali w Easton, PA, USA — to
  // NIE dowodzi, że strona nie należy do polskiej spółki, tylko że operator
  // grupy jest amerykański, co jest normalne dla globalnej marki). Sama nazwa
  // kraju w tekście to więc dowód SŁABSZY niż numer rejestrowy/JSON-LD — stąd
  // zawsze przechodzi przez ten sam mechanizm co Tier B niżej: wymaga braku
  // POLISH_LINK_EVIDENCE, żeby cokolwiek zablokować, i wtedy tylko ogranicza
  // do unresolved (nie odrzuca na twardo).
  const haystacks = [{ label: 'title', text: homepageTitle || '' }, ...sources];
  for (const h of haystacks) {
    const countryMatch = FOREIGN_COUNTRY_NAME_RX.exec(h.text || '');
    if (countryMatch) {
      const around = (h.text || '').slice(Math.max(0, countryMatch.index - 100), countryMatch.index + 100);
      if (!SHIPPING_CONTEXT_RX.test(around)) {
        const polishLinkEvidence = POLISH_LINK_EVIDENCE_RX.test(homepageTitle || '') || sources.some(s => POLISH_LINK_EVIDENCE_RX.test(s.text || ''));
        return { tier: 'B', type: 'foreign_country_weak_mention', page: h.label, evidence: countryMatch[0], context: around.replace(/\s+/g, ' ').trim(), polishLinkEvidence };
      }
    }
  }
  return null;
}

// Marka/nazwa prawna INNEGO podmiotu (z sufiksem prawnym, polskim lub obcym)
// powtórzona w title ORAZ na ≥1 osobnej podstronie (mocny dowód — pojedyncza
// wzmianka NIE wystarcza), przy CAŁKOWITYM braku śladu własnej marki na
// żadnej sprawdzonej stronie (bez tego warunku ryzykowne — case: legalna
// wzmianka o zagranicznej centrali obok własnej marki, patrz Cartonplast).
function findDifferentEntityBrand({ company, sources, homepageTitle }) {
  const ourToken = firstDistinctiveNameToken(company.company_name);
  const ourBrandFoundAnywhere = !!ourToken && (
    tokenInText(ourToken, homepageTitle) || sources.some(s => tokenInText(ourToken, s.text))
  );
  if (ourBrandFoundAnywhere) return null;

  const hits = new Map(); // token -> Set(location labels)
  const registerHit = (rxSource, label, text) => {
    const rx = new RegExp(rxSource.source, 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 100), m.index + 100);
      if (BRAND_DOWNGRADE_CTX_RX.test(around)) continue;
      const token = firstDistinctiveNameToken(m[1]);
      if (!token || token === ourToken) continue;
      if (!hits.has(token)) hits.set(token, { locations: new Set(), evidence: m[0].trim(), context: around.replace(/\s+/g, ' ').trim() });
      hits.get(token).locations.add(label);
    }
  };
  registerHit(FOREIGN_LEGAL_NAME_RX, 'title', homepageTitle || '');
  registerHit(PL_LEGAL_NAME_RX, 'title', homepageTitle || '');
  for (const src of sources) {
    registerHit(FOREIGN_LEGAL_NAME_RX, src.label, src.text || '');
    registerHit(PL_LEGAL_NAME_RX, src.label, src.text || '');
  }
  for (const [token, info] of hits.entries()) {
    if (info.locations.size >= 2) {
      return { type: 'different_entity_brand', token, evidence: info.evidence, context: info.context, locations: [...info.locations] };
    }
  }
  return null;
}

function tokenInText(token, text) {
  return !!token && normalizeName(text || '').includes(token);
}

function looksLikeGroupPortalWithoutPolishLink({ homepageTitle, sources }) {
  if (!GROUP_PORTAL_HINT_RX.test(homepageTitle || '')) return false;
  const polishLink = POLISH_LINK_EVIDENCE_RX.test(homepageTitle || '') || sources.some(s => POLISH_LINK_EVIDENCE_RX.test(s.text || ''));
  return !polishLink;
}

// Punktacja spójności marki — domena/title-h1(połączone, jak już są dostępne
// na tym etapie)/wielostronicowa obecność marki/o-nas-kontakt. Próg wyższy dla
// source='resolver' (domena zgadnięta algorytmicznie), bo tam samo podobieństwo
// nazwy nie może być jedynym potwierdzeniem — wymaga JEDNOCZEŚNIE dopasowania
// domeny i title/h1.
function scoreBrandConsistency({ company, candidateUrl, homepageTitle, sources }) {
  const token = firstDistinctiveNameToken(company.company_name);
  let hostname = '';
  try { hostname = normalizeName(new URL(candidateUrl).hostname.replace(/^www\./, '')); } catch { /* zły URL — brak dopasowania domeny */ }

  const domainStrong = !!token && (hostname === token || hostname.startsWith(token));
  const domainWeak = !!token && !domainStrong && hostname.includes(token);
  const titleMatch = tokenInText(token, homepageTitle);
  const pagesWithBrand = sources.filter(s => tokenInText(token, s.text) && (s.text || '').length >= 300);
  const onasKontaktHit = sources.some(s => BRAND_ONAS_KONTAKT_PATH_RX.test(s.label || '') && (s.text || '').length >= 1000 && tokenInText(token, s.text));
  const maxChars = sources.length ? Math.max(...sources.map(s => (s.text || '').length)) : 0;

  let points = 0;
  if (domainStrong) points += 2; else if (domainWeak) points += 1;
  if (titleMatch) points += 3;
  if (pagesWithBrand.length >= 2) points += 3;
  if (onasKontaktHit) points += 2;

  return { token, points, detail: { domainStrong, domainWeak, titleMatch, multiPageBrandCount: pagesWithBrand.length, onasKontaktHit, maxChars } };
}

// Punkt wejścia — wołany z enrichOne WYŁĄCZNIE gdy strict identity fallback
// (runIdentityFallback, powyżej) zwrócił verified:false z powodem
// 'insufficient_evidence' (foreign_address_conflict nadal wygrywa bez zmian,
// patrz kolejność w enrichOne). Zwraca jeden z czterech werdyktów:
//   verified:true  → brand_verified (dowód pozytywny wystarczający)
//   verified:false, reason='legal_entity_conflict'/'foreign_entity_or_country_conflict'/
//     'different_entity_brand' → jawny konflikt, silniejszy sygnał niż zwykłe
//     insufficient_evidence (surowane do identity_check.reason w enrichOne)
//   verified:false, reason='insufficient_evidence' → bez zmian względem stanu
//     przed V3, ewentualnie z cap_reason gdy punkty by wystarczyły, ale
//     zadziałało ograniczenie (Tier B bez polish link, portal grupy/marki)
// Straż klasy "przejęta/wygasła domena" (23.09). Brand fallback przyznaje do
// 10 pkt przy progu 7, ale WSZYSTKIE cztery składniki (domainStrong, titleMatch,
// pagesWithBrand, onasKontaktHit) wywodzą się z jednego faktu — obecności tokenu
// marki. Gdy domena nazywa się tak jak firma, token jest w domenie i w szablonie
// <title>, a szablon powtarza się na każdej podstronie, więc `pagesWithBrand`
// liczy JEDEN dowód wielokrotnie. Efekt: każda żywa strona pod domeną zgodną
// z nazwą przechodzi — dokładnie taki jest profil wygasłej domeny przejętej pod
// SEO (squatter zachowuje nazwę, bo jest w domenie).
//
// Straż jest systemowa, bez żadnych wyjątków dla konkretnych domen: marka musi
// wystąpić w TREŚCI po ekstrakcji (bez nawigacji i stopki), nie tylko
// w szablonie tytułu.
//
// Zmierzone na całym batchu workend_ola_9001-10000 (251 done z potwierdzonym
// identity, 10 przez brand fallback): blokuje 3 rekordy = 1,2% wszystkich done,
// i KAŻDY z tych trzech ma icp_score = 0 — czyli zero realnej straty dla
// handlowca. Zachowuje wszystkie wartościowe (score 70/80/95).
const BRAND_CONTENT_MIN_HITS = 2;

function brandAppearsInContent(token, contentText) {
  if (!token) return false;
  if (typeof contentText !== 'string' || !contentText) return false;
  const rx = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return (normalizeName(contentText).match(rx) || []).length >= BRAND_CONTENT_MIN_HITS;
}

function evaluateBrandIdentityFallback({ company, krsData, gusData, candidateUrl, candidateSource, homepageTitle, sources, contentText }) {
  if (!sources || !sources.length) {
    return { verified: false, reason: 'insufficient_evidence', decided_by: 'no_sources_for_brand_fallback', positive_evidence: null, conflict_evidence: null, cap_reason: null };
  }

  const legalConflict = findLegalEntityConflict({ company, krsData, gusData, sources });
  if (legalConflict.conflict) {
    return {
      verified: false, reason: 'legal_entity_conflict', decided_by: `legal_entity_conflict@${legalConflict.page}`,
      positive_evidence: null, conflict_evidence: legalConflict, cap_reason: null,
    };
  }

  const foreignConflict = findForeignEntityOrCountryConflict({ sources, homepageTitle });
  if (foreignConflict && foreignConflict.tier === 'A') {
    return {
      verified: false, reason: 'foreign_entity_or_country_conflict', decided_by: `foreign_entity_or_country_conflict@${foreignConflict.page}`,
      positive_evidence: null, conflict_evidence: foreignConflict, cap_reason: null,
    };
  }

  const differentBrand = findDifferentEntityBrand({ company, sources, homepageTitle });
  if (differentBrand) {
    return {
      verified: false, reason: 'different_entity_brand', decided_by: `different_entity_brand@${differentBrand.locations.join(',')}`,
      positive_evidence: null, conflict_evidence: differentBrand, cap_reason: null,
    };
  }

  // `token` jest RODZEŃSTWEM `detail`, nie jego polem — dotąd `detail.token`
  // w positive_evidence niżej zapisywało się jako undefined.
  const { token, points, detail } = scoreBrandConsistency({ company, candidateUrl, homepageTitle, sources });
  const threshold = candidateSource === 'resolver' ? 9 : 7;
  const hardRequiredForResolver = candidateSource === 'resolver' ? (detail.domainStrong || detail.domainWeak) && detail.titleMatch : true;
  let verified = detail.maxChars >= 1000 && points >= threshold && hardRequiredForResolver;

  let capReason = null;
  // Straż przejętych domen — patrz komentarz przy BRAND_CONTENT_MIN_HITS.
  // `contentText === undefined` oznacza wywołanie spoza enrichOne (testy
  // jednostkowe scoringu) — wtedy straż się nie uruchamia, żeby nie zmieniać
  // kontraktu samego scoreBrandConsistency.
  if (verified && contentText !== undefined && !brandAppearsInContent(token, contentText)) {
    verified = false;
    capReason = `brand_only_in_template: token "${token}" nie występuje w treści strony (min. ${BRAND_CONTENT_MIN_HITS}x) — profil przejętej/wygasłej domeny`;
  }
  if (verified && foreignConflict && foreignConflict.tier === 'B' && !foreignConflict.polishLinkEvidence) {
    verified = false;
    capReason = `foreign_entity_or_country_conflict tier B (${foreignConflict.evidence}) bez POLISH_LINK_EVIDENCE`;
  }
  if (verified && looksLikeGroupPortalWithoutPolishLink({ homepageTitle, sources })) {
    verified = false;
    capReason = 'group/global portal hint (Europe/Global/International/Worldwide w title) bez dowodu powiazania z polska spolka';
  }

  return {
    verified,
    reason: verified ? 'brand_verified' : 'insufficient_evidence',
    decided_by: verified ? `brand_verified@points_${points}_${threshold}` : 'brand_consistency_below_threshold',
    positive_evidence: verified ? { token, points, threshold, detail } : null,
    conflict_evidence: null,
    cap_reason: capReason,
    points, threshold,
  };
}

// Zaufanie do domeny jest WYŁĄCZNIE jednorazowe, per KONKRETNE wywołanie
// enrichOne (opts.trustedDomain) — NIGDY z trwale zapisanej w bazie kolumny
// website_source. Bug potwierdzony na INT 18.09: 'manual_correction' ustawione
// raz (nawet przez samo otwarcie i zatwierdzenie dialogu "Re-process" w UI BEZ
// faktycznej zmiany URL-a — pole tam jest z góry wypełnione bieżącym adresem)
// omijało checkDomainIdentity() bezterminowo, także przy każdym kolejnym,
// niepowiązanym re-processie tego samego rekordu (case: IMW Inżynieria Maszyn
// Wałcz→deckert.de, M+B Birke→birke.com, Mirol→mirol.com, Minos→placeholder
// hostingowy — wszystkie cztery kończyły jako "Wzbogacone" mimo
// identity_check.verified=false). website_source w bazie zostaje jako
// informacyjna etykieta pochodzenia URL-a (do wyświetlenia w UI), ale nie
// steruje już tym, czy identity-check jest respektowany — o zaufaniu decyduje
// wyłącznie to, czy TEN request faktycznie przyniósł nowy, ręcznie podany URL
// (patrz POST /:id/re-process w admin-prospects.js, zmienna websiteChanged).
function isDomainTrustedForThisRun(opts) {
  return opts?.trustedDomain === true;
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

// Strona-wyzwanie anty-bot (JS fingerprinting + auto-reload), nie treść firmy —
// case 18.09 (audyt sygnałów ICP, dachcentrum.pl): tytuł "Proszę czekać…" +
// setTimeout(...).location.reload() w <script>, żadnej rzeczywistej treści bez
// wykonania JS. Bez tego checka extractText() (fallback meta) brał tytuł
// "Proszę czekać…" jako jedyny "tekst strony" i wysyłał go do AI jako realną
// treść — sygnały ICP fałszywie wychodziły "false" bo strona wyglądała na pustą,
// zamiast poprawnie trafić do needs_review z jawnym powodem. Nie renderujemy JS
// (brak headless browsera w tym serwisie) — to tylko wykrycie i jawne oznaczenie
// przypadku, nie obejście blokady.
const BOT_CHALLENGE_TITLE_HINTS = /prosz[eę] czeka[cć]|please wait|just a moment|checking your browser|weryfikacj[eę] [zż][aą]dania|verifying you are human/i;
const BOT_CHALLENGE_SCRIPT_HINTS = /settimeout\s*\(\s*function\s*\(\s*\)\s*\{\s*window\.location\.reload/i;

function isBotChallengePage(html) {
  if (!html) return false;
  const head = html.slice(0, 5_000);
  return BOT_CHALLENGE_TITLE_HINTS.test(head) && BOT_CHALLENGE_SCRIPT_HINTS.test(html);
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
// Awaria na poziomie połączenia — dotyczy KONKRETNEGO hosta, nie domeny jako
// takiej (w odróżnieniu od ENOTFOUND/TLS). Uzasadnia jednorazową próbę
// wariantu www ↔ apex, patrz fetchPageForCrawl.
const CONNECTION_LEVEL_ERROR = /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ECONNABORTED|timeout of \d+ms exceeded/i;

// Podzbiór DETERMINISTIC_FETCH_ERROR dotyczący WYŁĄCZNIE certyfikatu (nie DNS)
// — ENOTFOUND/EAI_AGAIN celowo wykluczone, bo pominięcie walidacji certyfikatu
// nie naprawi nierozwiązującej się nazwy hosta (rozwiązanie DNS zachodzi przed
// handshake TLS). Używane WYŁĄCZNIE w fetchPageForCrawl (publiczny crawler
// stron firm — audyt 21.08 pokazał 4 firmy z realnymi, żywymi stronami
// odrzucanymi wyłącznie przez błąd certyfikatu: altname niepasujący do
// wildcardu hostingu (*.home.pl), wygasły certyfikat, niekompletny łańcuch).
const TLS_CERT_ERROR = /certificate|altnames|ERR_TLS|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF|SELF_SIGNED/i;

// no_website po nieudanym pobraniu jest uzasadnione TYLKO gdy wiemy z
// pewnością, że domena nie istnieje (DNS) albo jest parkingiem — wszystko
// inne (403/429/5xx, timeout, błąd certyfikatu) to needs_review, bo strona
// realnie może działać (patrz: Kaufland, blokada bota na 403).
function isConfirmedDeadDomain(deterministicFailure) {
  if (!deterministicFailure) return false;
  if (deterministicFailure.type === 'domain_parking') return true;
  // Cała treść strony to przekierowanie client-side na lander parkingu albo
  // webmail (etap 4, 23.09) — pod tym adresem nie ma strony firmy i ponowna
  // próba zobaczy dokładnie to samo, tak samo jak przy parkingu.
  if (deterministicFailure.type === 'client_side_redirect_only') return true;
  if (deterministicFailure.type === 'tls_dns') {
    return !TLS_CERT_ERROR.test(deterministicFailure.reason || '');
  }
  return false;
}

// Agent z pominiętą walidacją certyfikatu — celowo NIE globalny (nie dotyka
// process.env.NODE_TLS_REJECT_UNAUTHORIZED ani domyślnej konfiguracji axios).
// Przekazywany jawnie jako `httpsAgent` WYŁĄCZNIE w jednej, kontrolowanej
// próbie w fetchPageForCrawl, po wyczerpaniu normalnych retry z ważną
// walidacją. Domena pobrana w ten sposób i tak musi przejść zwykły
// checkDomainIdentity — to wyłącznie odzyskanie treści do analizy, nie
// automatyczne zaufanie.
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

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

// ── Sygnały ICP — DYNAMICZNE per tenant od ETAPU B (2026-09) ──────────────
// Dawny hardkodowany ICP_SIGNALS (8 sygnałów, promptKey→bool) został zastąpiony
// przez tenant_icp_signals/tenantIcpConfigService.getActiveConfig() — patrz
// buildSystemPrompt()/calcIcpScore() niżej. Domyślna konfiguracja CRMtree
// (DEFAULT_SIGNALS w tenantIcpConfigService.js) to 1:1 kopia dawnych 8 sygnałów
// — te same label/definicje/punkty/zależności, suma punktów aktywnych sygnałów
// nadal wynosi dokładnie 70 (gates 20 + bonus 10 + signals 70 = max 100).

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

// Punkty za bramki (decyzja 2026-09-17): 10 pkt za KAŻDĄ bramkę ze statusem
// "pass" — wcześniej bramki tylko kwalifikowały/dyskwalifikowały (icpGateStatus)
// i nie wpływały na icp_score. "fail"/"unknown" = 0 pkt za tę bramkę (bez
// dodatkowej kary — kara za brak kwalifikacji to już samo disqualified/needs_review).
// Decyzja 2026-09-22: gate'y NIE dodają już punktów do icp_score (patrz enrichOne())
// — ICP_GATE_POINTS/ICP_GATE_DEFS/ICP_MAX_GATE_SCORE zostają wyłącznie informacyjne
// (icp_gate_points w bazie, panel Inspekcji), disqualified/needs_review i tak już
// dziś nigdzie realnie nie blokuje pipeline'u (żadne query nie filtruje po
// icp_gate_status — sprawdzone), więc to nie jest zmiana zachowania, tylko
// odcięcie wkładu punktowego.
const ICP_GATE_POINTS = 10;
const ICP_GATE_DEFS = [
  { id: 'b2b', label: 'Sprzedaż B2B (nie do konsumenta)' },
  { id: 'company_size', label: 'Minimum 15 pracowników' },
];
const ICP_MAX_GATE_SCORE = ICP_GATE_DEFS.length * ICP_GATE_POINTS; // 20 — informacyjne, nie wchodzi do icp_score

// Wymagana suma punktów AKTYWNYCH sygnałów tenanta — decyzja 2026-09-22: icp_score
// to WYŁĄCZNIE suma aktywnych sygnałów (gates/bonus zostają informacyjne, patrz
// komentarz przy ICP_GATE_POINTS/ICP_BONUS_SIGNALS), więc sygnały same muszą
// sumować się do pełnego sufitu — stąd STAŁE 100, nie hybryda z gates/bonus jak
// wcześniej (100 − gates(20) − bonus(10) = 70, gdzie wyłączenie jednego sygnału
// bez ręcznej rekompensacji gdzie indziej psuło sumę i blokowało publikację na
// zawsze — admin nie miał jak po prostu "wyłączyć sygnał i mieć to z głowy").
// Ten sam mechanizm LIVE/PUBLISHED zostaje bez zmian (patrz
// tenantIcpConfigService.bumpRevisionAndMaybePublish): wyłączenie/dodanie
// sygnału w LIVE publikuje się dopiero, gdy suma AKTYWNYCH sygnałów znów
// wynosi dokładnie ICP_REQUIRED_SIGNALS_MAX_SCORE — do tego czasu enrichment
// dalej używa ostatniej poprawnej PUBLISHED wersji.
const ICP_BONUS_MAX_SCORE = ICP_BONUS_SIGNALS.reduce((sum, b) => sum + b.points, 0); // 10 — informacyjne, nie wchodzi do icp_score
const ICP_TOTAL_MAX_SCORE = 100;
const ICP_REQUIRED_SIGNALS_MAX_SCORE = ICP_TOTAL_MAX_SCORE; // 100 — signals alone must reach the full ceiling

// Ocena configu ICP tenanta względem wymaganej sumy sygnałów (tenantIcpConfigService
// sam tego nie wie — patrz komentarz przy getActiveConfig() w tamtym pliku).
// icpConfig: wynik tenantIcpConfigService.getActiveConfig().
function evaluateIcpConfigValidity(icpConfig) {
  const signalsSum = icpConfig.maxScore;
  return {
    signalsSum,
    signalsMax: ICP_REQUIRED_SIGNALS_MAX_SCORE,
    isValid: signalsSum === ICP_REQUIRED_SIGNALS_MAX_SCORE,
    // Decyzja 2026-09-22: gates/bonus nie dodają już punktów do icp_score, więc
    // finalMaxScore = wyłącznie signalsSum (dawniej: + ICP_MAX_GATE_SCORE + ICP_BONUS_MAX_SCORE).
    finalMaxScore: signalsSum,
  };
}

// company_size to TWARDA bramka liczona w backendzie z employment_count (dane z
// importu) — NIGDY z odpowiedzi AI. Powód (audyt Alior Bank, 20.09): rekord bez
// employment_count dostawał od modelu company_size="pass" 3/3 razy mimo
// instrukcji w prompcie, żeby przy braku danych zwrócić "unknown".
// Brak lub niepoprawna liczba => "unknown" (nie zgadujemy), a nie "fail".
const COMPANY_SIZE_MIN_EMPLOYEES = 15;

// Zatrudnienie z importu bywa ZAKRESEM ("10-19 osób", "250+"), nie liczbą.
// Parsujemy je do przedziału {min, max} i NIGDY nie zgadujemy wartości ze środka
// ani nie traktujemy dolnej granicy jako dokładnej liczby. Dokładna liczba to
// przedział zdegenerowany {n, n}. Zwraca null, gdy wartości nie da się
// jednoznacznie sparsować (brak, tekst, liczba ujemna, odwrócony zakres).
function parseEmploymentBounds(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? { min: value, max: value } : null;
  }
  if (typeof value !== 'string') return null;

  const s = value.trim().toLowerCase()
    .replace(/\s*(os[oó]b\w*|pracownik\w*|etat\w*)\s*$/, '')
    .trim();
  if (!s) return null;

  const N = '(\\d[\\d\\s.,]*)';
  const toNum = t => Number(String(t).replace(/[\s.,]/g, ''));
  let m;

  if (new RegExp(`^${N}$`).test(s)) {
    const n = toNum(s);
    return Number.isFinite(n) ? { min: n, max: n } : null;
  }
  if ((m = s.match(new RegExp(`^(?:od\\s+)?${N}\\s*(?:-|–|—|do)\\s*${N}$`)))) {
    const min = toNum(m[1]);
    const max = toNum(m[2]);
    return Number.isFinite(min) && Number.isFinite(max) && min <= max ? { min, max } : null;
  }
  if ((m = s.match(new RegExp(`^${N}\\s*\\+$`))) || (m = s.match(new RegExp(`^(?:od|min\\.?|minimum)\\s+${N}$`)))) {
    const min = toNum(m[1]);
    return Number.isFinite(min) ? { min, max: Infinity } : null;
  }
  if ((m = s.match(new RegExp(`^(?:powy[żz]ej|ponad)\\s+${N}$`)))) {
    const min = toNum(m[1]) + 1;
    return Number.isFinite(min) ? { min, max: Infinity } : null;
  }
  if ((m = s.match(new RegExp(`^(?:do|max\\.?|maksymalnie)\\s+${N}$`)))) {
    const max = toNum(m[1]);
    return Number.isFinite(max) ? { min: 0, max } : null;
  }
  if ((m = s.match(new RegExp(`^poni[żz]ej\\s+${N}$`)))) {
    const max = toNum(m[1]) - 1;
    return Number.isFinite(max) && max >= 0 ? { min: 0, max } : null;
  }
  return null;
}

// Reguła progu 15 (na przedziale, nie na punkcie):
//   cały przedział < 15           → fail    (np. 1-9, 14)
//   cały przedział >= 15          → pass    (np. 20-49, 250+, 15)
//   przedział przecina próg       → unknown (np. 10-19 — nie zgadujemy)
//   brak / nieparsowalne          → unknown
// employmentRange (surowy tekst z importu) ma pierwszeństwo, bo employment_count
// to tylko jego dolna granica; gdy zakresu brak lub jest nieparsowalny, liczymy
// z employment_count jako z dokładnej liczby (rekordy sprzed zapisu zakresu).
function calcCompanySizeGate(employmentCount, employmentRange) {
  const bounds = parseEmploymentBounds(employmentRange) || parseEmploymentBounds(employmentCount);
  if (!bounds) return 'unknown';
  if (bounds.max < COMPANY_SIZE_MIN_EMPLOYEES) return 'fail';
  if (bounds.min >= COMPANY_SIZE_MIN_EMPLOYEES) return 'pass';
  return 'unknown';
}

// Składa finalny obiekt icp_gates: b2b zostaje dokładnie tak, jak zwróciło AI,
// natomiast company_size jest ZAWSZE nadpisywane wartością deterministyczną —
// niezależnie od tego, czy AI w ogóle zwróciło to pole i jaką ma wartość.
function buildIcpGates(aiGates, employmentCount, employmentRange) {
  const base = aiGates && typeof aiGates === 'object' && !Array.isArray(aiGates) ? aiGates : {};
  return { ...base, company_size: calcCompanySizeGate(employmentCount, employmentRange) };
}

function calcIcpGatePoints(gates) {
  let points = 0;
  const breakdown = ICP_GATE_DEFS.map(def => {
    const hit = gates?.[def.id] === 'pass';
    if (hit) points += ICP_GATE_POINTS;
    return { id: def.id, label: def.label, points: ICP_GATE_POINTS, hit };
  });
  return { points, breakdown };
}

// Kalkuluje icp_score deterministycznie z sygnałów zwróconych przez AI — nie
// ufamy score'owi liczonemu przez sam model, tak jak poprzednio. Od ETAPU B
// dynamiczne: `aiSignals` to zwalidowana tablica {key,value,reasoning} z
// odpowiedzi AI (key = stabilny biznesowy identyfikator sygnału, NIE techniczne
// UUID — patrz analiza przy buildSignalPromptBlock), `tenantSignals` to AKTYWNA
// konfiguracja tenanta (tenantIcpConfigService.getActiveConfig().activeSignals).
// AI nigdy nie przydziela punktów — tylko true/false per key, backend dolicza
// sig.points deterministycznie. rawHits/requires_any_of nadal operują na
// sig.id (technicznym UUID z tenant_icp_signals) — to wewnętrzna, DB-owa
// relacja między sygnałami tego samego tenanta, niezwiązana z kontraktem AI —
// więc tylko ŹRÓDŁO wartości hit zmienia się z aiValueById na aiValueByKey,
// reszta logiki suppresji zostaje identyczna. breakdown[].id celowo używa
// sig.key (nie sig.id/UUID) — to ten sam string, jaki dawny kod trzymał jako
// ICP_SIGNALS[].id (np. "dzial_handlowy"), więc frontend i historyczne dane
// prospektów nadal się mapują bez zmian.
function calcIcpScore(aiSignals, tenantSignals) {
  const aiValueByKey = new Map();
  if (Array.isArray(aiSignals)) {
    for (const entry of aiSignals) {
      if (entry && typeof entry === 'object') aiValueByKey.set(entry.key, entry.value === true);
    }
  }

  const rawHits = {};
  for (const sig of tenantSignals) rawHits[sig.id] = aiValueByKey.get(sig.key) === true;

  // Decyzja 2026-09-22: requires_any_of przestaje wpływać na scoring (sygnały są
  // niezależne) — `suppressed` zostaje w breakdown jako pole (zawsze false), bo
  // frontend (admin-prospects.component.ts) je czyta, nie zmieniam kształtu odpowiedzi.
  let raw = 0;
  const breakdown = [];
  for (const sig of tenantSignals) {
    const hit = rawHits[sig.id];
    if (hit) raw += sig.points;
    breakdown.push({ id: sig.key, label: sig.label, tier: sig.tier, points: sig.points, hit, suppressed: false });
  }
  const maxPossible = tenantSignals.reduce((sum, s) => sum + s.points, 0);
  return { raw, capped: Math.min(100, raw), maxPossible, breakdown };
}

// Rekonstruuje enrichLog.claude.signal_reasoning z analysis.signals[] (kontrakt
// {key,value,reasoning} — patrz buildJsonContractSection) — kluczowane po
// sig.key, żeby getSignalReasoning() we frontendzie (fallback r[s.reasoningKey]
// || r[s.key]) trafiało. Poprawka 22.09: poprzednia (inline) wersja dopasowywała
// po `s.id === entry.id`, ale AI nigdy nie zwraca `entry.id` (kontrakt to
// `key`, nie `id` — dokładnie to samo pole, po którym już poprawnie liczy
// calcIcpScore() wyżej) — dopasowanie zawsze zawodziło, signal_reasoning
// zawsze wychodziło puste `{}`, mimo że AI realnie zwracało uzasadnienie dla
// każdego sygnału (true I false).
function buildSignalReasoningMap(aiSignals, tenantSignals) {
  if (!Array.isArray(aiSignals)) return null;
  return Object.fromEntries(
    aiSignals
      .map(entry => {
        const sig = tenantSignals.find(s => s.key === entry.key);
        return sig ? [sig.key, entry.reasoning ?? null] : null;
      })
      .filter(Boolean)
  );
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

// Blacklista ICP: firmy pasujące do słów kluczowych (domyślnie hurtownie) nie
// mieszczą się w ICP CRMtree — od icp_score odejmowana jest kara. Słowa i kara
// są konfigurowalne per-tenant w app_settings (prospect.icp_blacklist_*); te
// stałe to fallback, gdy brak wiersza dla tenanta (analogicznie do fallbacku
// providera AI na 'deepseek').
const ICP_BLACKLIST_DEFAULT_KEYWORDS = ['hurtow', 'sprzedaż hurtowa', 'handel hurtowy', 'dystrybucja hurtowa'];
const ICP_BLACKLIST_DEFAULT_PENALTY = 15;

async function loadIcpBlacklistSettings(tenantId) {
  try {
    const [kw, pen] = await Promise.all([
      db.query(`SELECT value FROM app_settings WHERE key = 'prospect.icp_blacklist_keywords' AND tenant_id = $1`, [tenantId]),
      db.query(`SELECT value FROM app_settings WHERE key = 'prospect.icp_blacklist_penalty'  AND tenant_id = $1`, [tenantId]),
    ]);
    let keywords = ICP_BLACKLIST_DEFAULT_KEYWORDS;
    if (kw.rows[0]?.value) {
      try {
        const parsed = JSON.parse(kw.rows[0].value);
        if (Array.isArray(parsed)) keywords = parsed;
      } catch { /* zła wartość w ustawieniu — trzymaj się domyślnej listy */ }
    }
    const penaltyRaw = Number(pen.rows[0]?.value);
    const penalty = Number.isFinite(penaltyRaw) && penaltyRaw >= 0 ? penaltyRaw : ICP_BLACKLIST_DEFAULT_PENALTY;
    return { keywords, penalty };
  } catch {
    return { keywords: ICP_BLACKLIST_DEFAULT_KEYWORDS, penalty: ICP_BLACKLIST_DEFAULT_PENALTY };
  }
}

// Cały algorytm naliczania icp_score jako dane — pokazywane wprost w zakładce
// "Zasady naliczania punktów" w Inspekcji (decyzja 18.09, audyt Prospektów:
// dotąd admin widział TYLKO wynik i evidence z AI, nigdzie w UI nie było
// samej definicji wag/formuły/blacklisty). Sekcja `signals` czyta PUBLISHED
// (nie LIVE) konfigurację tenanta — dokładnie tę, której realnie używa
// enrichOne()/calcIcpScore() — celowo, żeby ten widok nigdy nie pokazywał
// nieopublikowanego draftu admina jako "obowiązujących zasad". Gates/bonus/
// blacklist zostają globalne (patrz tenantIcpConfigService.js — V2).
async function getIcpScoringRules(tenantId) {
  const blacklist = await loadIcpBlacklistSettings(tenantId);
  const icpConfig = await tenantIcpConfigService.getPublishedConfig(tenantId);
  const validity = evaluateIcpConfigValidity(icpConfig);

  return {
    // Decyzja 2026-09-22: icp_score = wyłącznie suma punktów TRAFIONYCH aktywnych
    // sygnałów (minus kara blacklisty) — gates i bonusy NIE wchodzą już do wyniku,
    // zostają wyłącznie informacyjne (patrz notes niżej i totalScore w enrichOne()).
    formula: 'icp_score = clamp(0, 100, suma punktów trafionych aktywnych sygnałów − kara_blacklisty)',
    gates: {
      points_per_pass: ICP_GATE_POINTS,
      max_points: ICP_MAX_GATE_SCORE,
      note: 'Informacyjne — NIE wchodzą do icp_score (decyzja 2026-09-22). "fail" nadal ustawia icp_gate_status=disqualified, ' +
        'ale to sama etykieta/status, nic realnie nie blokuje w pipeline (żadne query nie filtruje po icp_gate_status). "unknown" trafia do needs_review. ' +
        'company_size: minimum 15 pracowników, liczone deterministycznie w backendzie na podstawie danych employment_count/employment_range z importu (AI go nie ustala); ' +
        'brak danych, nieczytelna wartość lub zakres przecinający próg 15 (np. 10-19) = unknown. Zakres w całości poniżej 15 (np. 1-9) = fail, w całości od 15 wzwyż (np. 20-49, 250+) = pass. ' +
        'b2b: oceniane przez AI na podstawie treści strony.',
      definitions: ICP_GATE_DEFS.map(g => ({
        id: g.id, label: g.label, points_if_pass: ICP_GATE_POINTS,
        ...(g.id === 'company_size'
          ? { source: 'backend: employment_count/employment_range (deterministycznie, bez AI)', threshold: COMPANY_SIZE_MIN_EMPLOYEES }
          : { source: 'AI: treść strony WWW' }),
      })),
    },
    signals: {
      max_points: validity.signalsSum,
      max_points_expected: validity.signalsMax,
      is_valid: validity.isValid,
      is_default_config: icpConfig.isDefault,
      note: 'AI zwraca wyłącznie true/false per sygnał (nigdy punktów) — punkty przypisuje deterministycznie backend, patrz calcIcpScore(). Konfiguracja dynamiczna per tenant (tenant_icp_signals). Jedyny składnik icp_score poza karą blacklisty.',
      definitions: icpConfig.activeSignals.map(s => ({
        id: s.key,
        technical_id: s.id,
        label: s.label,
        tier: s.tier,
        points: s.points,
        ai_definition: s.ai_definition,
        short_description: s.short_description,
        requires_any_of: s.requires_any_of || null,
      })),
    },
    bonus_signals: {
      max_points: ICP_BONUS_MAX_SCORE,
      note: 'Informacyjne — NIE wchodzą do icp_score (decyzja 2026-09-22). Wykrywane regexem po surowym HTML strony głównej — nie wołają AI.',
      definitions: ICP_BONUS_SIGNALS.map(b => ({ id: b.id, label: b.label, points: b.points })),
    },
    blacklist: {
      keywords: blacklist.keywords,
      penalty: blacklist.penalty,
      checked_sources: ['company_name', 'industry', 'pkd_description', 'gusData.pkdMain', 'gusData.pkdCodes[].nazwa'],
    },
    max_possible_score: validity.finalMaxScore,
  };
}

// Zwraca listę trafionych słów kluczowych (lub null, gdy brak trafienia).
// Szuka po nazwie firmy, branży, opisie PKD z importu oraz nazwach kodów PKD z GUS.
function matchesIcpBlacklist(keywords, company, gusData) {
  if (!Array.isArray(keywords) || !keywords.length) return null;
  const haystack = [
    company?.company_name,
    company?.industry,
    company?.pkd_description,
    gusData?.pkdMain,
    ...(Array.isArray(gusData?.pkdCodes) ? gusData.pkdCodes.map(c => c?.nazwa) : []),
  ].filter(Boolean).join(' | ').toLowerCase();

  const matched = keywords
    .map(k => String(k || '').trim().toLowerCase())
    .filter(k => k && haystack.includes(k));

  return matched.length ? matched : null;
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
// sam). GENERIC_NAME_WORDS (definicja przy nameTokensMatch, na początku pliku)
// pomija te same opisowe/prawne/spójnikowe człony przy zgadywaniu domeny.
// 4 → 6 (23.09, krok 2 poprawy generatora). Sam token marki NIE mieści się w
// limicie 4 — przy nim wypycha formy dwusłowne i hit-rate SPADA (zmierzone:
// 49,3% vs 51,2%). Dopiero limit 6 daje 58,6%. Arytmetyka budżetu zostaje
// spełniona: 6 kandydatów / FALLBACK_CONCURRENCY = 2 partie ×
// FALLBACK_CANDIDATE_BUDGET_MS (6 s) = 12 s < FALLBACK_TIME_BUDGET_MS (15 s).
// Limit 8 dawałby 60,6%, ale to 3 partie = 18 s > budżet — świadomie odrzucone,
// różnica to 4 firmy na 203.
const FALLBACK_MAX_HOSTS       = 6;
const FALLBACK_CONCURRENCY     = 3;
// Budżet CAŁEJ operacji fallbacku. Poprawka 23.09 (audyt 47 firm bez `done`):
// wcześniej 8 s przy koszcie do 12 s na JEDNEGO kandydata (verifyUrl robił
// HEAD 6 s + GET 6 s) — jeden wolny host wyczerpywał budżet całej operacji,
// zanim skończyła się pierwsza partia. W benchmarku 100 firm 10 z 37
// needs_review kończyło się `method: 'timeout'`. Teraz budżet globalny jest
// większy od najgorszego przypadku pojedynczej partii
// (FALLBACK_VERIFY_TIMEOUT_MS * 2 na kandydata + scrape), więc timeout oznacza
// realne wyczerpanie czasu, a nie arytmetyczną niemożliwość.
const FALLBACK_TIME_BUDGET_MS  = 15_000;
// Timeout POJEDYNCZEJ próby HTTP w verifyUrl wewnątrz fallbacku (HEAD, potem
// GET) — świadomie krótszy niż domyślne 6 s verifyUrl używane poza fallbackiem,
// bo tu liczy się przejście przez kilku kandydatów w ramach budżetu, a nie
// cierpliwość wobec jednego wolnego hosta.
const FALLBACK_VERIFY_TIMEOUT_MS = 3_000;
// Twardy limit na CAŁEGO kandydata (verifyUrl + scrapeWebsiteFast razem).
// Bez niego wolny scrape jednego kandydata potrafi wyczerpać budżet globalny
// mimo krótkiego verify (case Artmed, pomiar 23.09). Dobrany tak, by cała
// partia FALLBACK_CONCURRENCY zmieściła się w budżecie globalnym z zapasem.
const FALLBACK_CANDIDATE_BUDGET_MS = 6_000;

// Do FALLBACK_MAX_HOSTS unikalnych hostów. Jeden URL na host (bez oddzielnych
// wariantów www/http/https — verifyUrl (maxRedirects) i tak podąży za
// przekierowaniem na kanoniczny wariant). `excludeUrls` (zawsze zawiera już
// odrzucony URL) wycina kandydatów wskazujących na tę samą domenę
// rejestrowalną — nie ma sensu ponownie próbować URL-a, który identity-check
// już odrzucił.
//
// KOLEJNOŚĆ (wariant "H", 23.09 — zmierzony na 203 firmach z potwierdzoną
// domeną z batcha workend_ola_9001-10000):
//   1. marka × .pl        2. formy dwusłowne × .pl
//   3. marka × .com.pl/.com   4. formy dwusłowne × .com.pl/.com
//
// "Marka" to token, którego generator dotąd NIE próbował: pierwszy znaczący
// człon nazwy, plus marka w cudzysłowie, jeśli jest. Case źródłowy: Airtificial
// Intelligent Robots Poland — prawdziwa domena to airtificial.com, a generator
// próbował wyłącznie airtificial-intelligent.*.
//
// Dlaczego .pl NAJPIERW, a nie TLD-po-TLD jak wcześniej: marka zajmuje pierwsze
// miejsca, więc przy limicie 6 formy dwusłowne z myślnikiem wypadały poza limit.
// Kolejność ".pl dla wszystkiego, potem reszta" odzyskuje połowę tych strat przy
// TEJ SAMEJ liczbie kandydatów: 57,1% → 58,6%, i nadal mieści airtificial.com.
// Zachowany przypadek Star-Dust/Ostróda Yacht (hyphenated+.com.pl) — dlatego w
// krokach 2 i 4 obie formy idą razem, forma nigdy nie jest pętlą zewnętrzną.
//
// Bilans względem stanu sprzed zmiany: 104/203 → 119/203 (+18 zyskanych,
// −3 zgubione: peter-schmidt.com.pl, star-dust.com.pl, chiorino-swidnica.com.pl
// — wszystkie dwuczłonowe z myślnikiem na .com.pl, wypchnięte przez limit 6).

// Bugfix 23.09 — forma prawna W ŚRODKU nazwy. normalizeName() wycina formę
// prawną TYLKO z KOŃCA (kotwica `\s*$`), a w tych danych bardzo często idzie
// po niej opis działalności: "Zimnik sp. z o.o. Kopalnia Granitu". Tokeny
// 'sp'/'z'/'o' przeżywały wtedy filtr i wchodziły do nazwy domeny —
// zimniksp.com.pl zamiast zimnik*. Zmierzone na batchu
// workend_ola_9001-10000: 63 firmy z 1096 (5,7%) miały przez to WSZYSTKICH
// czterech kandydatów bezużytecznych.
//
// Wycinamy FRAZĘ, nie pojedyncze tokeny. Pierwsza próba odfiltrowywała słowa
// krótsze niż 2 znaki i kosztowała 4 potwierdzone domeny, w których jedna
// litera/cyfra JEST członem marki: l-contact.pl, rytm-l.pl, sectorf.pl,
// kanal6.pl. Dlatego tu nie ma żadnego progu długości.
//
// Funkcja jest lokalna dla generatora kandydatów — NIE ruszamy normalizeName(),
// bo ten sam helper karmi identity-check (nameTokensMatch) i brand fallback V3.
const LEGAL_FORM_ANYWHERE = /(\s|^)(spolka\s+z\s+ograniczona\s+odpowiedzialnoscia|spółka\s+z\s+ograniczoną\s+odpowiedzialnością|sp\.?\s*z\s*o\.?\s*o\.?|sp\.?\s*k\.?|sp\.?\s*j\.?)(?=\s|$|,|\.)/gi;

function stripLegalFormAnywhere(name) {
  return String(name).replace(LEGAL_FORM_ANYWHERE, ' ');
}

// Marka podana w cudzysłowie — w tych danych bardzo częsty wzorzec, gdzie
// człony przed cudzysłowem to sam opis działalności: "Fabryka Przetworów
// Rybnych 'mieszko'", "Przedsiębiorstwo Budowy Dróg 'bitum'". W batchu
// workend_ola_9001-10000: 53 nazwy z cudzysłowem, w 30 pierwszy znaczący człon
// NIE pokrywa się z marką. Próg 4 znaków — krótsze skróty ("k&w" → "kw") zbyt
// łatwo trafiają w cudzą domenę, a identity i tak musiałby je odrzucić.
function quotedBrandToken(name) {
  const m = String(name).match(/["'„»]([A-Za-z0-9][^"'”«]{2,})["'”«]/);
  if (!m) return null;
  const token = normalizeName(m[1]).replace(/[^a-z0-9]/g, '');
  return token.length >= 4 ? token : null;
}

function guessFallbackDomains(name, excludeUrls = []) {
  const norm  = normalizeName(stripLegalFormAnywhere(name || ''));
  const words = norm.split(/[^a-z0-9]+/).filter(Boolean).filter(w => !isGenericNameWord(w));
  if (!words.length) return [];

  const significant = words.slice(0, 2);
  const compact      = significant.join('');
  const hyphenated   = significant.join('-');
  const forms = [...new Set([compact, hyphenated])].filter(Boolean);

  // Człony "markowe" — próbowane PRZED formami dwusłownymi (patrz komentarz
  // o kolejności wyżej). Próg 4 znaków na pojedynczy token: krótsze ("mar",
  // "hg") są zbyt pospolite, żeby samodzielnie wskazywać firmę, a każdy
  // kandydat kosztuje request.
  const brandForms = [];
  const quoted = quotedBrandToken(name);
  if (quoted && !forms.includes(quoted)) brandForms.push(quoted);
  const leadToken = words[0];
  if (leadToken && leadToken.length >= 4
      && !forms.includes(leadToken) && !brandForms.includes(leadToken)) {
    brandForms.push(leadToken);
  }

  const excludedHosts = new Set(
    excludeUrls.filter(Boolean).map(u => {
      try { return registrableDomain(new URL(u).hostname); } catch { return null; }
    }).filter(Boolean)
  );

  const seenHosts = new Set();
  const candidates = [];
  // true = limit wyczerpany, przerwij całość
  const addHost = (form, tld) => {
    const host = `${form}${tld}`;
    if (seenHosts.has(host) || excludedHosts.has(host)) return false;
    seenHosts.add(host);
    candidates.push(`https://${host}`);
    return candidates.length >= FALLBACK_MAX_HOSTS;
  };

  const REST_TLDS = ['.com.pl', '.com'];
  for (const form of brandForms) if (addHost(form, '.pl')) return candidates;
  for (const form of forms)      if (addHost(form, '.pl')) return candidates;
  for (const form of brandForms) {
    for (const tld of REST_TLDS) if (addHost(form, tld)) return candidates;
  }
  // forma NIGDY jako pętla zewnętrzna — patrz case Star-Dust w komentarzu wyżej
  for (const tld of REST_TLDS) {
    for (const form of forms) if (addHost(form, tld)) return candidates;
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
async function checkFallbackCandidate(url, { company, krsData, gusData, verifyTimeoutMs }) {
  const verifiedUrl = await verifyUrl(url, verifyTimeoutMs ? { timeoutMs: verifyTimeoutMs } : undefined);
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

  // WSPÓŁDZIELONA tablica (poprawka 23.09): przed poprawką gałąź timeoutu
  // zwracała zahardkodowane `attempts: []`, przez co enrichment_log pokazywał
  // "timeout, 0 sprawdzonych kandydatów" nawet wtedy, gdy kandydaci byli
  // sprawdzeni — częściowe wyniki po prostu ginęły razem z przegraną gałęzią
  // Promise.race. To był artefakt raportowania, nie realne zero prób, i mylił
  // diagnostykę (patrz audyt 47 firm bez `done`). Teraz obie gałęzie widzą tę
  // samą tablicę, więc timeout raportuje to, co faktycznie zdążyło się wykonać.
  const attempts = [];
  let timeoutHandle = null;

  // Twardy limit na JEDNEGO kandydata, obejmujący verifyUrl ORAZ
  // scrapeWebsiteFast. Poprawka 23.09 (druga iteracja etapu 1): pierwsza
  // wersja ograniczała tylko verifyUrl, przez co budżet globalny i tak zjadał
  // scrape (case Artmed: verify przechodził w ~0,5 s, a scrape trwał >15 s →
  // znowu `timeout` z zerem kandydatów). Wynik każdego kandydata jest też
  // zapisywany do `attempts` NATYCHMIAST po rozstrzygnięciu, a nie dopiero po
  // całej partii — inaczej wisząca partia nadal raportowałaby pustkę.
  const checkOne = async (url) => {
    let candidateTimer = null;
    try {
      const result = await Promise.race([
        checkFallbackCandidate(url, {
          company, krsData, gusData, verifyTimeoutMs: FALLBACK_VERIFY_TIMEOUT_MS,
        }),
        new Promise(resolve => {
          candidateTimer = setTimeout(
            () => resolve({ url, exists: null, verified: false, reason: 'candidate_timeout' }),
            FALLBACK_CANDIDATE_BUDGET_MS,
          );
        }),
      ]);
      attempts.push({ url: result.url, exists: result.exists, verified: result.verified, reason: result.reason, evidence: result.evidence });
      return result;
    } finally {
      if (candidateTimer) clearTimeout(candidateTimer);
    }
  };

  const resolvePromise = (async () => {
    for (let i = 0; i < candidates.length; i += FALLBACK_CONCURRENCY) {
      const batch = candidates.slice(i, i + FALLBACK_CONCURRENCY);
      const results = await Promise.all(batch.map(checkOne));
      const hit = results.find(r => r.verified);
      if (hit) return { url: hit.url, method: 'fallback_heuristic', attempts, scraped: hit.scraped };
    }
    return { url: null, method: 'none', attempts };
  })();

  const timeoutPromise = new Promise(resolve => {
    timeoutHandle = setTimeout(
      () => resolve({ url: null, method: 'timeout', attempts, timed_out_after_ms: FALLBACK_TIME_BUDGET_MS }),
      FALLBACK_TIME_BUDGET_MS,
    );
  });

  try {
    return await Promise.race([resolvePromise, timeoutPromise]);
  } finally {
    // Bez tego setTimeout trzyma event loop do końca budżetu nawet wtedy, gdy
    // resolvePromise wygrał wyścig w 200 ms — przy batchu 100 firm to realny
    // narzut czasu (i ostrzeżenia Jest o otwartych handle'ach w testach).
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// Sprawdza czy URL odpowiada (HEAD, fallback GET), zwraca URL lub null.
// `timeoutMs` per POJEDYNCZĄ próbę HTTP (domyślnie 6 s — zachowanie sprzed
// 23.09 dla wszystkich wywołań spoza fallbacku); resolveDomainFallback podaje
// krótszą wartość, żeby zmieścić kilku kandydatów w swoim budżecie.
async function verifyUrl(url, { timeoutMs = 6_000 } = {}) {
  for (const method of ['head', 'get']) {
    try {
      await axios[method](url, {
        timeout: timeoutMs, maxRedirects: 4,
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

// Parsuje pole schema.org Organization.numberOfEmployees (QuantitativeValue)
// do {count, range} — DETERMINISTYCZNIE, żadnego zgadywania: liczy się tylko
// jeśli pole faktycznie jest obecne w JSON-LD, dokładnie tak jak dziś czytamy
// NIP/KRS regexem. .value = dokładna liczba; .minValue/.maxValue = przedział
// (przynajmniej jedna granica). Zwraca {count:null, range:null} gdy brak pola.
function parseNumberOfEmployees(numberOfEmployees) {
  if (!numberOfEmployees || typeof numberOfEmployees !== 'object') return { count: null, range: null };
  const exact = Number(numberOfEmployees.value);
  if (Number.isFinite(exact)) return { count: exact, range: null };
  const min = Number(numberOfEmployees.minValue);
  const max = Number(numberOfEmployees.maxValue);
  if (Number.isFinite(min) || Number.isFinite(max)) {
    return { count: null, range: `${Number.isFinite(min) ? min : '?'}-${Number.isFinite(max) ? max : '?'}` };
  }
  return { count: null, range: null };
}

// Scrapuje stronę firmy na LinkedIn — extrahuje tekst z meta tagów i JSON-LD
// LinkedIn często zwraca 999 (bot detected) ale i tak zawiera OG/schema.org dane w HTML.
// Zwraca też {employmentCount, employmentRange} sparsowane z tego samego JSON-LD
// (fallback dla company_size gate, patrz enrichOne — poprawka 21.09, żadnego
// dodatkowego requestu, tylko dane już i tak pobrane tu dla innych pól).
async function scrapeLinkedin(linkedinUrl) {
  let employmentCount = null;
  let employmentRange = null;
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
            if (o.numberOfEmployees) {
              const parsed = parseNumberOfEmployees(o.numberOfEmployees);
              if (parsed.count != null || parsed.range != null) {
                parts.push(`Zatrudnienie: ${parsed.count ?? parsed.range}`);
                // Pierwsze trafienie wygrywa — strona nie powinna mieć dwóch
                // sprzecznych bloków Organization, ale na wszelki wypadek.
                if (employmentCount == null && employmentRange == null) {
                  employmentCount = parsed.count;
                  employmentRange = parsed.range;
                }
              }
            }
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
    logger.info('[Prospect] LinkedIn scraped', { url: linkedinUrl, chars: result.length, employmentCount, employmentRange });
    return { text: result, employmentCount, employmentRange };
  } catch (err) {
    logger.debug('[Prospect] LinkedIn scrape failed', { url: linkedinUrl, error: err.message });
    return { text: '', employmentCount: null, employmentRange: null };
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
// baseProtocol (np. 'http:') — protokół, pod którym strona główna faktycznie
// odpowiedziała (patrz effectiveBase w _crawlWebsite). Domyślnie 'https:' dla
// wywołań spoza crawla (np. menuAuditTool.js), które go nie przekazują.
// Bez tego linki względne ("/kontakt") były zawsze wymuszane na https, nawet
// gdy realnie działa tylko http — case: Konmet, strona ma we własnej
// nawigacji bezwzględne linki https, ale HTTPS na tym hoście jest zepsute
// (wygasły cert + inna/brakująca treść), więc każda podstrona kończyła się
// fetch_error mimo że dokładnie ta sama ścieżka po http działa poprawnie.
function extractInternalLinks($, baseHostname, baseProtocol = 'https:') {
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
        full = new URL(`${baseProtocol}${raw}`);
      } else if (raw.startsWith('/')) {
        full = new URL(`${baseProtocol}//${baseHostname}${raw}`);
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

// Dokumenty prawne (regulaminy/polityki/warunki handlowe) — NIE mogą podbijać
// score przez wzorzec "dział handlowy" (poprawka 19.09, druga tura, case
// Berlinerluft: "Ogólne Warunki Handlowe" łapały się na goły rdzeń "handlow"
// i zajmowały miejsce w top-12 kosztem prawdziwej strony zespołu sprzedaży).
// Strona NADAL może zostać pobrana, jeśli pasuje do INNEGO wzorca — wykluczamy
// tylko boost z jednego konkretnego wzorca (patrz excludeIfLegalDocument w
// LINK_SCORES), nie całą stronę z crawla. categorizePage() dodatkowo kieruje
// takie strony do kategorii 'legal_excluded' z zerowym budżetem, więc nawet
// jeśli zostaną pobrane (np. dla identity-check), nie wejdą do materiału
// klasyfikacyjnego wysyłanego do AI — patrz CONTENT_CATEGORIES.
const LEGAL_DOCUMENT_PATTERN = /warunki|regulamin|polityka|\brodo\b|cookie|privacy|terms.{0,15}(conditions|service)|prywatnosc/i;

// Sieć partnerów/dealerów — DWA POZIOMY zamiast jednego płaskiego wzorca
// (poprawka 19.09, druga tura, case Arpol: goły rdzeń "partner" łapał też
// artykuły o wydarzeniach branżowych OSÓB TRZECICH — "Genetec Partner Day",
// "Bosch Partner Day" — Arpol jest tam gościem cudzego wydarzenia, nie opisuje
// WŁASNEJ sieci dealerskiej. 5 takich stron o niemal identycznym score
// konkurowało z jedynym prawdziwym dowodem o te same 1-2 miejsca budżetu).
// STRONG: dedykowana, krótka ścieżka sieci partnerskiej ("/partnerzy",
// "/zostan-partnerem") LUB fraza jednoznacznie opisująca WŁASNYCH partnerów
// handlowych/sieć dealerską (np. "spotkanie partnerów handlowych ARPOL").
const PARTNER_STRONG_PATH   = /^\/?(partnerzy|dealerzy|dystrybutorzy|siec\w*[-.]?partnersk\w*|zostan[-.]?partnerem|zostan[-.]?dealerem|zostan[-.]?dystrybutorem|program[-.]?partnerski|dla[-.]?partnerow|dla[-.]?dealerow|dla[-.]?dystrybutorow)\b/i;
const PARTNER_STRONG_PHRASE = /spotkanie\w*.{0,20}partner|partner\w*.{0,10}handlow|siec\w*.{0,10}dealer|siec\w*.{0,10}partner/i;
// WEAK: gołe wystąpienie "partner"/"dealer"/"dystrybutor" gdziekolwiek indziej
// (typowo artykuł/relacja z wydarzenia osoby trzeciej) — realny, ale znacznie
// słabszy dowód, nie może automatycznie wygrywać z dedykowaną stroną.
const PARTNER_WEAK_PATTERN  = /partner|dealer|dystrybu|distributor/i;

// Ocenia trafność linka dla naszych celów enrichmentu
function scoreLinkRelevance(path, anchor) {
  // Normalizuj anchor — usuń diakrytyki żeby "Zarząd" pasował do wzorca /zarzad/
  const combined = `${path} ${deaccent(anchor)}`;
  const isLegalDocument = LEGAL_DOCUMENT_PATTERN.test(combined);

  let score = 0;
  for (const { pattern, score: s, excludeIfLegalDocument } of LINK_SCORES) {
    if (excludeIfLegalDocument && isLegalDocument) continue;
    if (pattern.test(combined)) score = Math.max(score, s);
  }

  if (PARTNER_STRONG_PATH.test(path) || PARTNER_STRONG_PHRASE.test(combined)) {
    score = Math.max(score, 9);
  } else if (PARTNER_WEAK_PATTERN.test(combined)) {
    score = Math.max(score, 4);
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
  $('[class*="cookie"]:not(html):not(body), [class*="Cookie"]:not(html):not(body), [id*="cookie"]:not(html):not(body), [id*="Cookie"]:not(html):not(body)').remove();
  $('[class*="popup"]:not(html):not(body), [class*="Popup"]:not(html):not(body), [class*="modal"]:not(html):not(body), [class*="Modal"]:not(html):not(body)').remove();
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

const CRAWL_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pl,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Encoding': 'gzip, deflate, br',
};

// Jedna, dodatkowa, KONTROLOWANA próba pobrania po wyczerpaniu normalnych
// retry z ważną walidacją certyfikatu — WYŁĄCZNIE gdy ostatni błąd dotyczył
// samego certyfikatu (TLS_CERT_ERROR), nigdy DNS. Zwraca html + tlsUnverified
// przy sukcesie, albo null gdy i to się nie uda (serwer faktycznie
// nieosiągalny niezależnie od certyfikatu).
async function fetchInsecureFallback(url, timeoutMs = 10_000) {
  if (timeoutMs <= 0) return null;
  try {
    const resp = await axios.get(url, {
      timeout: timeoutMs, maxRedirects: 5, headers: CRAWL_REQUEST_HEADERS,
      validateStatus: () => true, httpsAgent: insecureHttpsAgent,
    });
    const finalUrl = resp.request?.res?.responseUrl || url;
    const ct = resp.headers['content-type'] || '';
    if (resp.status >= 400 || !ct.includes('html')) return null;
    if (typeof resp.data !== 'string' || resp.data.length < SUSPICIOUSLY_SHORT_HTML) return null;
    return { html: resp.data, finalUrl, status: resp.status };
  } catch {
    return null; // nawet bez walidacji certyfikatu nieosiągalny — zostaw oryginalny błąd
  }
}

// Jedna, dodatkowa, KONTROLOWANA próba pobrania tego samego URL-a po http://
// zamiast https:// — WYŁĄCZNIE gdy błąd certyfikatu (TLS_CERT_ERROR) i
// fetchInsecureFallback (wciąż https, tylko z pominiętą walidacją certu) też
// nie zwrócił użytecznej strony (case: Konmet/Nordbeton — HTTPS ma zepsuty
// certyfikat i inną/brakującą treść nawet po zignorowaniu certu, ale ten sam
// host po http:// odpowiada normalnie). Zmienia WYŁĄCZNIE protokół — hostname
// i path zostają identyczne, żadnego zgadywania innej domeny (to rola
// resolveDomainFallback, osobno, nigdy stąd wołana). Zwraca html przy
// sukcesie, albo null gdy http też zawiedzie (np. serwer wymusza redirect
// z powrotem na to samo zepsute https).
async function fetchHttpFallback(url, timeoutMs) {
  if (timeoutMs <= 0) return null;
  let httpUrl;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    parsed.protocol = 'http:';
    httpUrl = parsed.toString();
  } catch {
    return null;
  }
  try {
    const resp = await axios.get(httpUrl, {
      timeout: timeoutMs, maxRedirects: 5, headers: CRAWL_REQUEST_HEADERS,
      validateStatus: () => true,
    });
    const finalUrl = resp.request?.res?.responseUrl || httpUrl;
    const ct = resp.headers['content-type'] || '';
    if (resp.status >= 400 || !ct.includes('html')) return null;
    if (typeof resp.data !== 'string' || resp.data.length < SUSPICIOUSLY_SHORT_HTML) return null;
    return { html: resp.data, finalUrl, status: resp.status };
  } catch {
    return null; // http:// też nieosiągalny (albo redirect z powrotem na zepsute https) — zostaw oryginalny błąd
  }
}

// Wariant hosta: "www.x.pl" ↔ "x.pl". Bardzo często tylko JEDEN z tych dwóch
// hostów jest realnie skonfigurowany, a URL z importu trafia w ten drugi.
// Zwraca null, gdy wariant nie istnieje (host bez kropki, IP, localhost).
function swapWwwHost(url) {
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch { return null; }
  if (!hostname || /^[\d.]+$/.test(hostname) || !hostname.includes('.')) return null;
  const altHost = hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
  // "www.pl" nie jest apexem domeny — po obcięciu musi zostać realna domena
  if (altHost.split('.').length < 2) return null;
  return { hostname, altHost, altUrl: url.replace(hostname, altHost) };
}

// Pobiera wariant hosta (www ↔ apex) w pozostałym budżecie. Jeśli wariant też
// zawiedzie przez błąd certyfikatu, dopina się do istniejącego TLS fallbacku.
// Cała próba mieści się we wspólnym, malejącym budżecie `deadline`
// przekazanym przez fetchPageForCrawl — żadnego dodatkowego stałego timeoutu.
async function fetchHostVariant(originalUrl, apexUrl, deadline, originalError) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { html: '', finalUrl: originalUrl, status: null, error: originalError };
  }
  try {
    const resp = await axios.get(apexUrl, {
      timeout: remaining, maxRedirects: 5, headers: CRAWL_REQUEST_HEADERS, validateStatus: () => true,
    });
    const finalUrl = resp.request?.res?.responseUrl || apexUrl;
    const ct = resp.headers['content-type'] || '';
    if (resp.status >= 400 || !ct.includes('html') || typeof resp.data !== 'string') {
      return { html: '', finalUrl, status: resp.status, error: `apex fetch failed: HTTP ${resp.status}` };
    }
    return { html: resp.data, finalUrl, status: resp.status };
  } catch (apexErr) {
    if (TLS_CERT_ERROR.test(apexErr.message)) {
      const insecure = await fetchInsecureFallback(apexUrl, deadline - Date.now());
      if (insecure) {
        logger.warn('[Prospect] tls_unverified — fetched apex (no-www) despite TLS certificate error', {
          url: apexUrl, originalError: apexErr.message, status: insecure.status,
        });
        return { ...insecure, tlsUnverified: true };
      }
    }
    return { html: '', finalUrl: apexUrl, status: null, error: apexErr.message };
  }
}

// Etap 4 (23.09) — przekierowanie wykonywane po stronie KLIENTA. Serwer
// zwraca HTTP 200 z kilkudziesięciu-bajtowym dokumentem, którego jedyną
// treścią jest skok gdzie indziej; axios nie ma czego śledzić, więc crawler
// widział "200, za mało treści" i ponawiał ten sam adres bez sensu.
// Realne przypadki z audytu 47 firm:
//   futrex.com.pl  → <META HTTP-EQUIV="Refresh" CONTENT="0;URL=http://poczta.futrex.com.pl">
//   mieszko.com    → <script>window.onload=function(){window.location.href="/lander"}</script>
// Celowo wąskie: TYLKO dokumenty podejrzanie krótkie (dłuższa strona z
// window.location w kodzie to normalna nawigacja, nie przekierowanie) i tylko
// proste przypisanie do location — bez interpretowania czegokolwiek innego.
//
// DLACZEGO KLASYFIKUJEMY, A NIE ŚLEDZIMY (pomiar 23.09, 17 firm): pierwsza
// wersja tego etapu skakała pod adres docelowy. Cel praktycznie nigdy nie jest
// stroną firmy — to lander parkingu (/lander) albo webmail (poczta.*). Crawler
// przyjmował go za `effectiveBase` i zaczynał zgadywać tam /kontakt, /o-nas,
// dostając 403 z retry Level 2: Futrex urósł z ~11 s do 68 s i zwrócił 62
// znaki śmieci, a ani jeden rekord nie zyskał `done`. Sam fakt "cała treść to
// przekierowanie" jest natomiast pewnym sygnałem, że pod tym adresem NIE MA
// strony firmy — i to jest tu jedyny użytek z tej detekcji.
const META_REFRESH_RE = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"';\s]+)/i;
const JS_LOCATION_RE = /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i;

function extractClientSideRedirect(html, baseUrl) {
  if (typeof html !== 'string' || html.length >= SUSPICIOUSLY_SHORT_HTML) return null;
  const target = (html.match(META_REFRESH_RE) || html.match(JS_LOCATION_RE) || [])[1];
  if (!target) return null;
  try {
    const resolved = new URL(target, baseUrl);
    if (!/^https?:$/.test(resolved.protocol)) return null;   // javascript:, mailto: itp.
    if (resolved.href === baseUrl) return null;              // skok na samego siebie
    return resolved.href;
  } catch {
    return null;
  }
}

async function fetchPageForCrawl(url, { maxRetries = 2 } = {}) {
  const deadline = Date.now() + 10_000;
  let lastStatus = null;
  let lastError = null;
  let lastFinalUrl = url;
  let currentUrl = url;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleepJittered(500 * Math.pow(2, attempt - 1)); // 500ms, 1000ms, ...
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const resp = await axios.get(currentUrl, {
        timeout: remaining,
        maxRedirects: 5,
        headers: CRAWL_REQUEST_HEADERS,
        validateStatus: () => true, // sami decydujemy, co retry'ować
      });
      lastStatus = resp.status;
      const finalUrl = resp.request?.res?.responseUrl || currentUrl;
      lastFinalUrl = finalUrl;

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
          if (retryAfterMs > 0) await sleep(Math.min(retryAfterMs, Math.max(0, deadline - Date.now())));
          continue;
        }
        return { html: '', finalUrl, status: resp.status, attempts: attempt + 1 };
      }

      const ct = resp.headers['content-type'] || '';
      if (!ct.includes('html')) {
        return { html: '', finalUrl, status: resp.status, attempts: attempt + 1 };
      }

      const html = resp.data;
      if (typeof html === 'string' && html.length < SUSPICIOUSLY_SHORT_HTML) {
        // Krótki dokument, którego CAŁĄ treścią jest przekierowanie
        // client-side, nie stanie się dłuższy po ponowieniu — retry na ten sam
        // adres to czysta strata budżetu. Samego skoku nie gonimy (patrz
        // komentarz przy extractClientSideRedirect) — zwracamy go wywołującemu
        // jako sygnał do klasyfikacji.
        const redirectTarget = extractClientSideRedirect(html, finalUrl);
        if (redirectTarget) {
          return { html, finalUrl, status: resp.status, attempts: attempt + 1, clientSideRedirectTo: redirectTarget };
        }
        if (attempt < maxRetries) continue;
      }
      return { html, finalUrl, status: resp.status, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;

      if (/ENOTFOUND/.test(err.message)) {
        const swap = swapWwwHost(currentUrl);
        if (swap && swap.hostname.startsWith('www.')) {
          // DNS dla www się nie zmieni w kolejnych sekundach — nie ponawiamy
          // www, tylko od razu próbujemy apex w pozostałym budżecie.
          const apexResult = await fetchHostVariant(currentUrl, swap.altUrl, deadline, err.message);
          logger.warn('[Prospect] ENOTFOUND on www. host — tried apex without www instead of retrying', {
            url: currentUrl, originalError: err.message, finalUrl: apexResult.finalUrl,
            status: apexResult.status, apexError: apexResult.error || null,
          });
          return { ...apexResult, attempts: attempt + 2 };
        }
      }

      if (attempt >= maxRetries) {
        // Etap 3 (23.09): awaria na poziomie POŁĄCZENIA (reset/hang up/odmowa/
        // timeout) mówi tylko tyle, że TEN host nie odpowiada — drugi wariant
        // (www ↔ apex) bywa skonfigurowany poprawnie. Realny przypadek Micel:
        // www.addevmaterials.pl → "socket hang up", addevmaterials.pl → HTTP
        // 200 i redirect na addevmaterials.com/pl/. Dotąd ta ścieżka istniała
        // WYŁĄCZNIE dla ENOTFOUND, więc taki host kończył jako needs_review
        // bez ani jednego znaku treści. Próba jest jednorazowa i mieści się w
        // tym samym `deadline`, więc nie wydłuża najgorszego przypadku.
        if (CONNECTION_LEVEL_ERROR.test(err.message) && !TLS_CERT_ERROR.test(err.message)) {
          const swap = swapWwwHost(currentUrl);
          if (swap) {
            const variant = await fetchHostVariant(currentUrl, swap.altUrl, deadline, err.message);
            if (variant.html) {
              logger.warn('[Prospect] host_variant_fallback — original host failed at connection level, www/apex variant answered', {
                url: currentUrl, variantUrl: swap.altUrl, originalError: err.message,
                finalUrl: variant.finalUrl, status: variant.status,
              });
              return { ...variant, attempts: attempt + 2, hostVariantFallback: true };
            }
          }
        }

        if (TLS_CERT_ERROR.test(err.message)) {
          const insecure = await fetchInsecureFallback(currentUrl, deadline - Date.now());
          if (insecure) {
            logger.warn('[Prospect] tls_unverified — fetched despite TLS certificate error', {
              url: currentUrl, originalError: err.message, status: insecure.status,
            });
            return { ...insecure, attempts: attempt + 2, tlsUnverified: true };
          }
          const httpFallback = await fetchHttpFallback(currentUrl, deadline - Date.now());
          if (httpFallback) {
            logger.warn('[Prospect] protocol_fallback: https_to_http — HTTPS failed on certificate, plain HTTP succeeded', {
              url: currentUrl, httpUrl: httpFallback.finalUrl, originalError: err.message, status: httpFallback.status,
            });
            return { ...httpFallback, attempts: attempt + 3, protocolFallback: true };
          }
        }
        return { html: '', finalUrl: lastFinalUrl, status: null, attempts: attempt + 1, error: err.message };
      }
    }
  }
  return { html: '', finalUrl: lastFinalUrl, status: lastStatus, attempts: maxRetries + 1, error: lastError?.message };
}

// ── Level 2 — hardened HTTP fallback (21.09, po audycie próbki 50 firm) ──
// Uruchamiany WYŁĄCZNIE po kwalifikującym niepowodzeniu Level 1
// (fetchPageForCrawl, który zostaje bez zmian i nadal jest pierwszą, tanią
// próbą) — 403, 429, timeout/błąd sieciowy nie-deterministyczny, albo
// podejrzanie mało treści mimo HTTP 200. NIGDY dla 404 (strona faktycznie nie
// istnieje) ani dla deterministycznych błędów TLS/DNS (te już przeszły przez
// własne fallbacki Level 1 — inne nagłówki tego nie naprawią). Różnica
// względem Level 1: pełniejszy, spójniejszy zestaw nagłówków przeglądarkowych
// (Sec-Fetch-*/sec-ch-ua — część WAF sprawdza ich OBECNOŚĆ i spójność z UA, nie
// tylko sam UA), osobny keep-alive agent (nie dzieli połączenia z Level 1),
// wolniejszy backoff (1s/3s/8s zamiast 500ms/1000ms — część 429 to zwykłe
// rate-limiting, nie fingerprinting) i cookie jar między próbami tej samej
// domeny w obrębie jednego przebiegu enrichmentu. ŚWIADOMIE NIE próbuje omijać
// CAPTCHA, Cloudflare JS Challenge ani żadnego zabezpieczenia wymagającego
// wykonania JS/interakcji — to wyłącznie "bardziej grzeczny" klient HTTP, nie
// obejście zabezpieczeń. Realistyczne oczekiwanie (patrz audyt 21.09): pomaga
// przy rate-limitingu i niespójnych nagłówkach, NIE pomaga przy twardym
// enterprise WAF (Akamai/Cloudflare Bot Management z fingerprintingiem) — na
// to potrzebny byłby headless browser (Level 3, świadomie odłożony).
const level2Agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const level2CookieJar = new Map(); // hostname -> "a=1; b=2" (per-proces, per-domena, żyje tylko w RAM)

function level2Headers(hostname) {
  const headers = {
    'User-Agent': CRAWL_REQUEST_HEADERS['User-Agent'],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  const cookie = hostname && level2CookieJar.get(hostname);
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function storeLevel2Cookies(hostname, setCookieHeaders) {
  if (!hostname || !setCookieHeaders || !setCookieHeaders.length) return;
  const pairs = setCookieHeaders.map(c => c.split(';')[0]).filter(Boolean);
  if (pairs.length) level2CookieJar.set(hostname, pairs.join('; '));
}

const LEVEL2_BACKOFFS_MS = [1000, 3000, 8000];

async function fetchPageHardened(url, { maxRetries = 2, timeoutMs = 12_000 } = {}) {
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch { /* zostaw null */ }
  const deadline = Date.now() + 25_000;
  let lastStatus = null;
  let lastError = null;
  let lastFinalUrl = url;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleepJittered(LEVEL2_BACKOFFS_MS[attempt - 1] ?? 8000);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const resp = await axios.get(url, {
        timeout: Math.min(timeoutMs, remaining),
        maxRedirects: 5,
        headers: level2Headers(hostname),
        httpsAgent: level2Agent,
        validateStatus: () => true,
      });
      lastStatus = resp.status;
      const finalUrl = resp.request?.res?.responseUrl || url;
      lastFinalUrl = finalUrl;
      storeLevel2Cookies(hostname, resp.headers['set-cookie']);

      if (resp.status === 404) return { html: '', finalUrl, status: 404, attempts: attempt + 1, level: 2 };
      if ([403, 429, 500, 502, 503, 504].includes(resp.status) && attempt < maxRetries) continue;

      const ct = resp.headers['content-type'] || '';
      if (!ct.includes('html')) return { html: '', finalUrl, status: resp.status, attempts: attempt + 1, level: 2 };

      const html = resp.data;
      if (typeof html === 'string' && html.length < SUSPICIOUSLY_SHORT_HTML && attempt < maxRetries) continue;
      return { html, finalUrl, status: resp.status, attempts: attempt + 1, level: 2 };
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) {
        return { html: '', finalUrl: lastFinalUrl, status: null, attempts: attempt + 1, error: err.message, level: 2 };
      }
    }
  }
  return { html: '', finalUrl: lastFinalUrl, status: lastStatus, attempts: maxRetries + 1, error: lastError?.message, level: 2 };
}

// Kwalifikacja do Level 2 — patrz komentarz przy fetchPageHardened wyżej.
function qualifiesForLevel2(result) {
  if (!result) return false;
  if (result.status === 403 || result.status === 429) return true;
  if (!result.html && result.status !== 404 && !(result.error && DETERMINISTIC_FETCH_ERROR.test(result.error))) {
    return true; // timeout/reset/5xx po wyczerpaniu retry Level 1 — nie deterministyczny TLS/DNS
  }
  if (result.html && result.html.length > 0 && result.html.length < 1000 && result.status === 200) {
    return true; // HTTP 200, ale podejrzanie mało treści (placeholder/błąd zamaskowany jako 200)
  }
  return false;
}

// Drop-in zamiennik fetchPageForCrawl() we wszystkich miejscach crawla —
// Level 1 zostaje pierwszą, tanią próbą; Level 2 dogrywany TYLKO po
// kwalifikującym niepowodzeniu Level 1 (patrz qualifiesForLevel2). Zwraca ten
// sam kształt co fetchPageForCrawl(), więc wywołujący kod się nie zmienia.
async function fetchPageResilient(url, opts) {
  const level1 = await fetchPageForCrawl(url, opts);
  // Dokument będący wyłącznie przekierowaniem client-side kwalifikuje się do
  // Level 2 regułą "200, ale <1000 znaków" — a hardening niczego tu nie zmieni
  // (to nie blokada bota, tylko skok). Kończymy od razu, zachowując
  // klasyfikację i oszczędzając całą rundę Level 2.
  if (level1.clientSideRedirectTo) return level1;
  if (!qualifiesForLevel2(level1)) return level1;
  const level2 = await fetchPageHardened(url);
  if (!level2.html) return level1;
  // fetchPageHardened to osobna ścieżka i nie zna detekcji z fetchPageForCrawl
  // — bez tego Level 2 zwracałby ten sam stub przekierowania już BEZ
  // klasyfikacji, a rekord wracał do needs_review z zerem znaków.
  const redirectTarget = extractClientSideRedirect(level2.html, level2.finalUrl || url);
  return redirectTarget ? { ...level2, clientSideRedirectTo: redirectTarget } : level2;
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
// Poprawka 19.09 (audyt retrievalu, ETAP 3 — polskie warianty/odmiany jako
// podstawa rankingu i kategoryzacji, EN jako uzupełnienie):
// - "placow" nigdy nie łapał "placówka" (różnica w "ó", ta funkcja NIE
//   odakcentowuje anchora, w przeciwieństwie do scoreLinkRelevance/deaccent())
//   — poprawione na "plac[oó]wk".
// - "oferta" jako dosłowna forma nie łapał "oferty"/"ofertowy" — zamienione
//   na rdzeń "ofert". Dodane wycena/konsultacja/doradztwo/dobór — główne
//   słowa kluczowe custom_quote_process i consultation_demo_needs_analysis,
//   dotąd nigdzie nierozpoznawane przy kategoryzacji.
// - "dystrybutor" → "dystrybu" żeby złapać też "dystrybucyjny"/"dystrybucja".
// - nowa kategoria 'realizacje_przetargi' — dotąd strony /realizacje,
//   /referencje, /przetargi w ogóle nie miały własnej kategorii i lądowały w
//   'other' na resztkach budżetu (patrz audyt ETAP 1: tender_bidding_department
//   był jedynym sygnałem bez dedykowanej kategorii i z najniższym link score
//   w całej tabeli). Skromna rezerwacja (1000 zn.), niższy priorytet niż
//   kontakt/oferta/zespół, ale WYŻSZY niż nic (wcześniej: zero gwarancji).
// Poprawka 19.09 (druga tura): dokumenty prawne (regulaminy/polityki/warunki
// handlowe) dostają WŁASNĄ kategorię z zerowym budżetem — MUSI być pierwsza
// na liście, bo categorizePage() zwraca pierwsze pasujące dopasowanie. Strona
// może zostać pobrana (np. jeśli pasuje też do innego wzorca), ale nigdy nie
// wejdzie do materiału klasyfikacyjnego wysyłanego do AI — patrz
// LEGAL_DOCUMENT_PATTERN w scoreLinkRelevance(). Nie usuwamy jej z crawla w
// ogóle (np. na potrzeby identity-check nadal może zostać pobrana), tylko z
// budżetu sygnałów sprzedażowych.
const CONTENT_CATEGORIES = [
  { id: 'legal_excluded',       reserved: 0,    pattern: LEGAL_DOCUMENT_PATTERN },
  { id: 'kontakt_oddzialy',     reserved: 3000, pattern: /kontakt|contact|oddzia[lł]|plac[oó]wk|lokalizacj|biur[ao]|adres|gdzie.jestesmy/i },
  // Rozszerzone po audycie 24.08 o gołe "b2b", "hurt" i "współpraca" — te
  // strony (np. subdomena b2b.<domena>, "/o-firmie/wspolpraca") były już
  // pobierane (HTTP 200), ale kategoryzowały się jako 'oferta'/'o_nas_zespol'
  // (dopasowanie po "o-firmie" w ścieżce) albo 'other' i przegrywały o
  // budżet znaków z sąsiednimi stronami tej samej kategorii (Targor-Truck,
  // W. Śliwiński — content_limit mimo trafienia w top rankingu linków).
  // Dodane 19.09: "strefa klienta"/"panel klienta".
  { id: 'sklep_b2b',            reserved: 1500, pattern: /sklep|shop|e-?commerce|portal.?b2b|konto.?klient|strefa.?klient|panel.?klient|koszyk|checkout|\bb2b\b|hurt\w*|wsp[oó][lł]prac\w*|platforma.{0,20}\b(b2b|zakup\w*|klient\w*)\b/i },
  // "przedsiebiorstw|korporacyjn|dla firm|biznes" dopisane 22.09 razem z
  // odpowiadającym wzorcem w LINK_SCORES (case Alior Bank) — bez tego strona
  // po pobraniu i tak trafiłaby do 'other' zamiast dostać zarezerwowany
  // budżet znaków obok pokrewnej treści ofertowej.
  { id: 'oferta',               reserved: 2000, pattern: /ofert|us[lł]ug|produkt|rozwiazani|wycen|konsultacj|doradztw|dob[oó]r|solution|service|zapytani\w*.?ofert|request.?for.?quot|\brfq\b|certyfikacj|akredytacj|procedura|zasady.wsp[oó]lpracy|przedsiebiorstw|korporacyjn|dla.{0,3}firm|\bbiznes\w*/i },
  { id: 'o_nas_zespol',         reserved: 3000, pattern: /o[.-]?nas|o[.-]?firmie|about|zesp[oó][lł]|team|kim.jestesmy|historia/i },
  { id: 'realizacje_przetargi', reserved: 1000, pattern: /realizacj|referencj|case.stud|przetarg|zam[oó]wien\w*.publiczn/i },
  { id: 'praca',                reserved: 2500, pattern: /praca|kariera|jobs|career|rekrutacj|dolacz|join/i },
  { id: 'partnerzy',            reserved: 1500, pattern: /partner|dealer|dystrybu|distributor/i },
];
const PER_PAGE_CHAR_CAP = 3000;

// Frazy związane z ocenianymi sygnałami ICP — strony/fragmenty, które je
// zawierają, są preferowane w obrębie tej samej kategorii (patrz
// selectWithinBudget()), zamiast polegać wyłącznie na randze linku.
const SIGNAL_KEYWORDS = /dzia[lł] handlow|dedykowan|opiekun|key account|klient\w* kluczow|indywidualn\w* wycen|zapytaj o ofert|um[oó]w demo|konsultacj|zosta[nń] partnerem|sie[cć] dealer|realizacj|referencj|przetarg|zam[oó]wien\w* publiczn|sklep|shop|e-?commerce|portal.?b2b|konto.?klient|koszyk|checkout|zapytani\w*.?ofert|request.?for.?quot|\brfq\b/i;

// Tie-break ogólny (19.09, trzecia tura, case Berlinerluft): przy remisie
// score w OBRĘBIE tej samej kategorii, strony z realną treścią informacyjną
// o osobach/zespole/dziale sprzedaży mają wygrywać z czystymi formularzami
// kontaktowymi — formularz sam w sobie rzadko niesie dowód sygnału ICP, a
// zajmował budżet kategorii przed właściwą stroną z osobami (np.
// /osobykontaktowe vs /berlinerluftformularzkontaktowy, oba score=10).
// Celowo NIE dotyka score/kategoryzacji/limitu 12k — to wyłącznie kolejność
// wyboru w ramach już przydzielonego budżetu kategorii. Zwykłe /kontakt NIE
// jest tu obniżane (bonus=0), bo może zawierać wartościowe dane.
const PEOPLE_TEAM_PATH_PATTERN = /osob\w*kontakt\w*|zespol|\bteam\b|pracownic|dzial[-.]?sprzedaz|przedstawiciel/i;
const CONTACT_FORM_PATH_PATTERN = /formularz[-.]?kontakt|contact[-.]?form/i;

function pageRankTieBreakBonus(path) {
  if (PEOPLE_TEAM_PATH_PATTERN.test(path)) return 1;
  if (CONTACT_FORM_PATH_PATTERN.test(path)) return -1;
  return 0;
}

function categorizePage(path, anchor) {
  const hay = `${path} ${anchor || ''}`.toLowerCase();
  for (const cat of CONTENT_CATEGORIES) if (cat.pattern.test(hay)) return cat.id;
  return 'other';
}

// Limit różnorodności przy wyborze KANDYDATÓW do pobrania (poprawka 19.09,
// druga tura, case Arpol) — wcześniej top-N było czystym sortowaniem po
// score, więc jedna kategoria (np. "partnerzy" z 5 stronami o score 9-10)
// mogła zająć 5 z 12 miejsc, zostawiając mniej miejsca na strony INNYCH
// kategorii, których w ogóle mogliśmy nie odkryć/wybrać. Dwuprzebiegowy
// wybór: najpierw max `maxPerCategory` z KAŻDEJ kategorii (w kolejności wg
// malejącego score globalnego), potem reszta miejsc wg czystego score bez
// ograniczeń — więc jeśli jedna kategoria naprawdę dominuje treścią firmy,
// nadal dostanie dodatkowe miejsca, ale dopiero PO zapewnieniu, że inne
// kategorie miały szansę wejść.
const MAX_PER_CATEGORY_FIRST_PASS = 2;

function selectDiverseCandidates(candidatesWithScore, limit) {
  const withCategory = candidatesWithScore.map(c => ({ ...c, category: categorizePage(c.path, c.anchor) }));
  const byScoreDesc = [...withCategory].sort((a, b) => b.score - a.score);

  const selected = [];
  const perCategoryCount = new Map();

  for (const c of byScoreDesc) {
    if (selected.length >= limit) break;
    const count = perCategoryCount.get(c.category) || 0;
    if (count < MAX_PER_CATEGORY_FIRST_PASS) {
      selected.push(c);
      perCategoryCount.set(c.category, count + 1);
    }
  }
  if (selected.length < limit) {
    for (const c of byScoreDesc) {
      if (selected.length >= limit) break;
      if (!selected.includes(c)) selected.push(c);
    }
  }
  return selected;
}

// Rozdziela zebrane strony na budżet znaków: najpierw rezerwacja per
// kategoria (w kolejności priorytetu), potem reszta budżetu dla nadwyżki
// (np. newsy) wg rangi linku. Zwraca finalnie wybrane strony (przycięte do
// limitu) + zbiór ścieżek, które się zmieściły + `outcomes` (ETAP 4,
// audytowalność 19.09) — per-ścieżka { included_chars, reason }, gdzie reason
// dla WYKLUCZONYCH stron rozróżnia PRECYZYJNIE:
//   'category_budget_exhausted' — własna kategoria strony już wyczerpała
//     swoją rezerwację (cat.reserved), zanim doszła kolej na tę stronę;
//   'global_12k_truncation' — kategoria miała jeszcze miejsce, ale globalny
//     limit 12k (a właściwie totalLimit = 12000 - homepage) już się skończył.
// Wcześniej obie sytuacje trafiały do tego samego reason:'content_limit' —
// nie dało się odróżnić "za mało miejsca w tej kategorii" od "strona główna
// + wcześniejsze kategorie zjadły wszystko".
function selectWithinBudget(pages, totalLimit) {
  const byCategory = new Map();
  for (const cat of CONTENT_CATEGORIES) byCategory.set(cat.id, []);
  byCategory.set('other', []);
  for (const p of pages) byCategory.get(p.category).push({ ...p, text: p.text.slice(0, PER_PAGE_CHAR_CAP) });

  for (const [, list] of byCategory) {
    list.sort((a, b) => {
      const aBonus = pageRankTieBreakBonus(a.path);
      const bBonus = pageRankTieBreakBonus(b.path);
      if (aBonus !== bBonus) return bBonus - aBonus;
      const aKw = SIGNAL_KEYWORDS.test(a.text) ? 1 : 0;
      const bKw = SIGNAL_KEYWORDS.test(b.text) ? 1 : 0;
      if (aKw !== bKw) return bKw - aKw;
      return b.score - a.score;
    });
  }

  const selected = [];
  const includedPaths = new Set();
  const outcomes = new Map(); // path -> { included_chars, reason }
  let used = 0;

  for (const cat of CONTENT_CATEGORIES) {
    let catUsed = 0;
    for (const p of byCategory.get(cat.id)) {
      if (catUsed >= cat.reserved) {
        outcomes.set(p.path, { included_chars: 0, reason: 'category_budget_exhausted' });
        continue;
      }
      if (used >= totalLimit) {
        outcomes.set(p.path, { included_chars: 0, reason: 'global_12k_truncation' });
        continue;
      }
      const room = Math.min(p.text.length, cat.reserved - catUsed, totalLimit - used);
      if (room <= 0) {
        outcomes.set(p.path, { included_chars: 0, reason: 'global_12k_truncation' });
        continue;
      }
      selected.push({ ...p, text: p.text.slice(0, room) });
      includedPaths.add(p.path);
      outcomes.set(p.path, { included_chars: room, reason: 'included' });
      catUsed += room;
      used += room;
    }
  }

  // Kategorie z reserved:0 (np. legal_excluded) są celowo wykluczone z budżetu
  // klasyfikacji sygnałów — nie mogą "przeciekać" do niego przez fazę leftoverów
  // opartą tylko na globalnym score, bo to zniweczyłoby wykluczenie.
  const zeroReservedCategories = new Set(CONTENT_CATEGORIES.filter(c => c.reserved === 0).map(c => c.id));
  const leftovers = pages
    .filter(p => !includedPaths.has(p.path) && !zeroReservedCategories.has(p.category))
    .map(p => ({ ...p, text: p.text.slice(0, PER_PAGE_CHAR_CAP) }))
    .sort((a, b) => b.score - a.score);

  for (const p of leftovers) {
    if (used >= totalLimit) {
      outcomes.set(p.path, { included_chars: 0, reason: 'global_12k_truncation' });
      continue;
    }
    const room = Math.min(p.text.length, totalLimit - used);
    if (room <= 0) {
      outcomes.set(p.path, { included_chars: 0, reason: 'global_12k_truncation' });
      continue;
    }
    selected.push({ ...p, text: p.text.slice(0, room) });
    includedPaths.add(p.path);
    outcomes.set(p.path, { included_chars: room, reason: 'included' });
    used += room;
  }

  return { selected, includedPaths, used, outcomes };
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
  let tlsUnverified   = resume?.tlsUnverified  ?? false;
  let protocolFallback = resume?.protocolFallback ?? false;

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
    const { html, finalUrl, status: homeStatus, error: homeError, tlsUnverified: homeTlsUnverified, protocolFallback: homeProtocolFallback, level: homeFetchLevel, clientSideRedirectTo } = await fetchPageResilient(base);
    homepageHtml = typeof html === 'string' ? html : '';
    if (homeTlsUnverified) tlsUnverified = true;
    if (homeProtocolFallback) protocolFallback = true;

    if (!homepageHtml) {
      // Błąd deterministyczny (TLS/DNS) — nie zniknie przy ponownej próbie
      // tego samego URL-a, patrz enrichOne (etap fast NIE kontynuuje crawla
      // na podstawie tej flagi).
      const deterministic = !!homeError && DETERMINISTIC_FETCH_ERROR.test(homeError);
      logger.warn('[Prospect] Homepage fetch failed', { base, error: homeError, status: homeStatus, deterministic });
      return {
        terminal: {
          text: '', contacts: { emails: [], phones: [] },
          diagnostics: [{ url: base, attempt: 1, http_status: homeStatus, raw_length: 0, extracted_length: 0, included: false, reason: homeStatus === 404 ? 'not_found' : 'fetch_error', fetch_level: homeFetchLevel || 1 }],
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

    // Etap 4 (23.09): cała treść strony wejściowej to przekierowanie
    // client-side (meta refresh / window.location). Pod tym adresem nie ma
    // strony firmy i kolejna próba tego nie zmieni — traktujemy to jak
    // potwierdzoną martwą domenę, dzięki czemu rekord trafia do fallbacku
    // domenowego (etap 2) i kończy jako `no_website` zamiast wisieć w
    // needs_review z zerem znaków i bez powodu. Celowo NIE podążamy za skokiem
    // — pomiar pokazał, że cel to lander parkingu albo webmail.
    if (clientSideRedirectTo) {
      logger.info('[Prospect] Entry page is only a client-side redirect — treating as no company site', {
        base, finalUrl, redirectTo: clientSideRedirectTo, rawLength: homepageHtml.length,
      });
      return {
        terminal: {
          text: '', contacts: { emails: [], phones: [] },
          diagnostics: [{ url: base, attempt: 1, http_status: homeStatus, raw_length: homepageHtml.length, extracted_length: 0, included: false, reason: 'client_side_redirect_only', redirect_to: clientSideRedirectTo }],
          identity: { title: '', h1: '' },
          deterministicFailure: { type: 'client_side_redirect_only', reason: `client_side_redirect_only: ${clientSideRedirectTo}` },
        },
      };
    }

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
      logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: true, reason: 'included' , fetch_level: homeFetchLevel || 1 });
    } else if (isBotChallengePage(homepageHtml)) {
      // Nie wpuszczaj tytułu strony-wyzwania ("Proszę czekać…") do promptu jako
      // rzekomej treści firmy — patrz komentarz przy isBotChallengePage().
      logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: 0, included: false, reason: 'bot_challenge_suspected' , fetch_level: homeFetchLevel || 1 });
    } else {
      const $meta = cheerio.load(homepageHtml);
      const title       = $meta('title').text().trim();
      const description = $meta('meta[name="description"]').attr('content')?.trim() || '';
      const ogDesc      = $meta('meta[property="og:description"]').attr('content')?.trim() || '';
      const fallback    = [title, description || ogDesc].filter(Boolean).join(' — ');
      if (fallback.length > 10) {
        homeSection = `[/ — strona główna (meta)]\n${fallback}`;
        logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: true, reason: 'included_meta_fallback' , fetch_level: homeFetchLevel || 1 });
      } else {
        logDiag({ url: base, attempt: 1, http_status: 200, raw_length: homepageHtml.length, extracted_length: homeText.length, included: false, reason: 'too_short' , fetch_level: homeFetchLevel || 1 });
      }
    }
    fetched.add(effectiveBase);
    fetched.add(effectiveBase + '/');
  }

  // ── Krok 2: Zbierz linki z nawigacji (+ sitemapy w trybie pełnym) ─
  // Tryb szybki (fast) pomija sitemapę — to 1-3 dodatkowe żądania HTTP, a
  // nawigacja sama w sobie już wskazuje najważniejsze podstrony (patrz
  // enrichOne — scrapeWebsiteFast/continueCrawlToFull).
  // Protokół, pod którym strona główna faktycznie odpowiedziała — linki
  // względne w nawigacji muszą go dziedziczyć, nie być na sztywno https
  // (patrz komentarz przy extractInternalLinks).
  let baseProtocol = 'https:';
  try { baseProtocol = new URL(effectiveBase).protocol; } catch { /* zostaw https: */ }

  const $ = cheerio.load(homepageHtml);
  const navLinks     = extractInternalLinks($, baseHostname, baseProtocol);
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
  const candidates = selectDiverseCandidates(
    Array.from(allLinks.values()).filter(l => l.score > 0 && l.path !== '/'),
    level1Limit,
  );

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
    const category = categorizePage(path, anchor);
    if (fetched.has(fullHref)) {
      logDiag({ url: fullHref, path, score, category, attempt: 0, http_status: null, raw_length: 0, extracted_length: 0, included: false, reason: 'duplicate' });
      return;
    }
    fetched.add(fullHref);

    const { html, status, attempts, error, level: fetchLevel, finalUrl } = await fetchPageResilient(fullHref);
    if (error || !html) {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: 0, extracted_length: 0, included: false, reason: status === 404 ? 'not_found' : 'fetch_error', fetch_level: fetchLevel || 1 });
      await sleepJittered(400);
      return;
    }

    // Host po redirectach musi wciąż być related wobec baseHostname — sam
    // href w momencie discovery (extractInternalLinks/isRelatedHost) mówi
    // tylko dokąd link WSKAZYWAŁ, nie dokąd request faktycznie wylądował po
    // 301/302 (wygasła podstrona przejęta przez inny podmiot, migracja po
    // przejęciu firmy). Bez tej weryfikacji treść obcej firmy mogłaby trafić
    // do fetchedPages i dalej do promptu AI, mimo że identity-check strony
    // głównej przeszedł poprawnie (audyt Enrichment V2, H1, 23.09).
    let finalHostname = null;
    try { finalHostname = new URL(finalUrl).hostname; } catch { /* zostaw null */ }
    if (finalHostname && !isRelatedHost(finalHostname, baseHostname, `${path} ${anchor}`)) {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: 0, included: false, reason: 'other_host', fetch_level: fetchLevel || 1, final_host: finalHostname });
      await sleepJittered(400);
      return;
    }

    const $page = cheerio.load(html);
    collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
    const text  = extractText($page);
    if (text.length > 100) {
      const label = anchor ? `${path} — ${anchor}` : path;
      fetchedPages.push({ path, anchor, score, text, label, category });
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: true, reason: 'included', fetch_level: fetchLevel || 1 });
    } else {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: false, reason: 'too_short', fetch_level: fetchLevel || 1 });
    }

    // Tryb szybki nie rozwija się do poziomu 2 — pomiń zbieranie kandydatów.
    if (!fast) {
      for (const { path: p2, fullHref: h2, anchor: a2 } of extractInternalLinks($page, baseHostname, baseProtocol)) {
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
  const level2Candidates = fast ? [] : selectDiverseCandidates(Array.from(level2Links.values()), 6);

  if (level2Candidates.length) {
    logger.info('[Prospect] Level-2 pages discovered', {
      base,
      pages: level2Candidates.map(c => `${c.path}(${c.score})`),
    });
  }

  async function fetchLevel2Candidate({ fullHref, path, anchor, score }) {
    const category = categorizePage(path, anchor);
    if (fetched.has(fullHref)) {
      logDiag({ url: fullHref, path, score, category, attempt: 0, http_status: null, raw_length: 0, extracted_length: 0, included: false, reason: 'duplicate' });
      return;
    }
    fetched.add(fullHref);

    const { html, status, attempts, error, level: fetchLevel, finalUrl } = await fetchPageResilient(fullHref);
    if (error || !html) {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: 0, extracted_length: 0, included: false, reason: 'fetch_error', fetch_level: fetchLevel || 1 });
      await sleepJittered(400);
      return;
    }

    // Patrz komentarz przy tym samym sprawdzeniu w fetchLevel1Candidate — host
    // po redirectach musi wciąż być related wobec baseHostname (audyt
    // Enrichment V2, H1, 23.09).
    let finalHostname = null;
    try { finalHostname = new URL(finalUrl).hostname; } catch { /* zostaw null */ }
    if (finalHostname && !isRelatedHost(finalHostname, baseHostname, `${path} ${anchor}`)) {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: 0, included: false, reason: 'other_host', fetch_level: fetchLevel || 1, final_host: finalHostname });
      await sleepJittered(400);
      return;
    }

    const $page = cheerio.load(html);
    collectContacts(html, $page);          // PRZED extractText — aria-hidden jeszcze istnieje
    const text  = extractText($page);
    if (text.length > 100) {
      const label = anchor ? `${path} — ${anchor}` : path;
      fetchedPages.push({ path, anchor, score, text, label, category });
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: true, reason: 'included', fetch_level: fetchLevel || 1 });
    } else {
      logDiag({ url: fullHref, path, score, category, attempt: attempts, http_status: status, raw_length: html.length, extracted_length: text.length, included: false, reason: 'too_short', fetch_level: fetchLevel || 1 });
    }

    await sleepJittered(400);
  }

  await runWithConcurrency(level2Candidates, CRAWL_CONCURRENCY, fetchLevel2Candidate);

  return {
    state: {
      fetched, allEmails, allPhones, diagnostics, fetchedPages,
      identityTitle, identityH1, homepageHtml, effectiveBase, homeSection, baseHostname,
      allLinks, level2Links, tlsUnverified, protocolFallback,
      // ETAP 4 (audytowalność, 19.09) — ścieżki wybrane do faktycznego
      // pobrania na obu poziomach, żeby finalizeCrawl mogło oznaczyć w
      // link_audit KAŻDY odkryty link jako selected/not-selected, nie tylko
      // te które faktycznie trafiły do fetchedPages.
      level1SelectedPaths: new Set(candidates.map(c => c.path)),
      level2SelectedPaths: new Set(level2Candidates.map(c => c.path)),
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

// ETAP 4 (audytowalność retrievalu, 19.09) — buduje pełną listę WSZYSTKICH
// odkrytych linków (nie tylko tych pobranych) z ich losem na każdym etapie
// lejka: score → wybrany do top-12/top-6? → pobrany? → jaka kategoria? →
// ile znaków faktycznie trafiło do tekstu dla AI? → jeśli nie trafiło, DOKŁADNIE
// dlaczego. Cel: dla jednej firmy dać jednoznaczną odpowiedź "czy AI dostało
// stronę, na której był dowód", bez przeszukiwania logów ręcznie.
function buildLinkAudit(state, outcomes) {
  const { allLinks, level2Links, level1SelectedPaths, level2SelectedPaths, fetchedPages, diagnostics } = state;
  const fetchedByPath = new Map(fetchedPages.map(p => [p.path, p]));
  const audit = [];

  for (const [path, link] of [...allLinks, ...level2Links]) {
    if (audit.some(a => a.path === path)) continue; // level2Links nie duplikuje allLinks, ale na wszelki wypadek
    const selectedLevel1 = level1SelectedPaths.has(path);
    const selectedLevel2 = level2SelectedPaths.has(path);
    const fetchedPage = fetchedByPath.get(path);
    const diag = diagnostics.find(d => d.path === path);
    const outcome = outcomes.get(path);

    let stage, reason, included_chars = 0, extracted_length = null, category = fetchedPage?.category ?? null;

    if (link.score <= 0) {
      stage = 'LINK_SCORE_TOO_LOW';
      reason = `score ${link.score} — odfiltrowany przed rankingiem (próg > 0)`;
    } else if (!selectedLevel1 && !selectedLevel2) {
      stage = 'PAGE_NOT_SELECTED';
      reason = `score ${link.score}, ale poza top-${FULL_LEVEL1_LIMIT} (poziom 1) / top-6 (poziom 2)`;
    } else if (!fetchedPage) {
      extracted_length = diag?.extracted_length ?? null;
      if (diag?.reason === 'fetch_error' || diag?.reason === 'not_found') stage = 'FETCH_FAILED';
      else if (diag?.reason === 'bot_challenge_suspected') stage = 'BOT_CHALLENGE';
      else if (diag?.reason === 'too_short') stage = 'FETCH_FAILED';
      else stage = 'FETCH_FAILED';
      reason = diag?.reason || 'nieznany błąd pobierania';
    } else {
      extracted_length = fetchedPage.text.length;
      category = fetchedPage.category;
      if (outcome?.reason === 'included') {
        stage = 'EVIDENCE_REACHED_AI';
        included_chars = outcome.included_chars;
        reason = `pobrana i włączona do finalnego tekstu (${included_chars} zn.)`;
      } else if (outcome?.reason === 'category_budget_exhausted') {
        stage = 'CATEGORY_BUDGET_EXHAUSTED';
        reason = `kategoria "${category}" wyczerpała rezerwację zanim doszła kolej na tę stronę`;
      } else if (outcome?.reason === 'global_12k_truncation') {
        stage = 'GLOBAL_12K_TRUNCATION';
        reason = 'globalny limit 12 000 znaków wyczerpany wcześniejszymi kategoriami/stroną główną';
      } else {
        stage = 'GLOBAL_12K_TRUNCATION';
        reason = 'pobrana, ale nie zakwalifikowana do finalnego tekstu';
      }
    }

    audit.push({
      path, anchor: link.anchor || fetchedPage?.anchor || null, score: link.score,
      category, selected_level1: selectedLevel1, selected_level2: selectedLevel2,
      fetched: !!fetchedPage, extracted_length, included_chars, stage, reason,
    });
  }

  return audit.sort((a, b) => b.score - a.score);
}

function finalizeCrawl(state) {
  const { homeSection, fetchedPages, diagnostics, allEmails, allPhones, identityTitle, identityH1, tlsUnverified, protocolFallback } = state;
  const remainingBudget = Math.max(0, 12_000 - homeSection.length);
  const { selected, includedPaths, outcomes } = selectWithinBudget(fetchedPages, remainingBudget);

  // Strony, które miały dobrą treść, ale nie zmieściły się w budżecie —
  // odnotuj to wprost w diagnostyce zamiast cichego pominięcia. Poprawka
  // 19.09: rozróżniamy TERAZ category_budget_exhausted vs global_12k_truncation
  // (wcześniej oba wpadały pod ten sam napis 'content_limit') i dopisujemy
  // included_chars na WSZYSTKICH wpisach, nie tylko wykluczonych.
  for (const p of fetchedPages) {
    const diag = diagnostics.find(d => d.path === p.path && d.reason === 'included');
    if (!diag) continue;
    const outcome = outcomes.get(p.path);
    diag.included_chars = outcome?.included_chars ?? 0;
    if (!includedPaths.has(p.path)) {
      diag.reason = outcome?.reason || 'content_limit';
      diag.included = false;
    }
  }

  const linkAudit = buildLinkAudit(state, outcomes);

  const rawSections = [homeSection, ...selected.map(p => `[${p.label}]\n${p.text}`)].filter(Boolean);
  const { sections: finalTexts, charsBefore: dedupCharsBefore, charsAfter: dedupCharsAfter } = dedupeRepeatedFragments(rawSections);
  logger.info('[Prospect] Content dedup', {
    chars_before: dedupCharsBefore, chars_after: dedupCharsAfter, removed: dedupCharsBefore - dedupCharsAfter,
  });
  logger.info('[Prospect] Link audit (ETAP 4)', {
    total_discovered: linkAudit.length,
    by_stage: linkAudit.reduce((acc, a) => { acc[a.stage] = (acc[a.stage] || 0) + 1; return acc; }, {}),
  });

  const contacts = {
    emails: [...allEmails].filter(e => e.includes('@')),
    phones: [...allPhones].filter(p => p.replace(/\D/g, '').length >= 9),
  };

  return {
    text: finalTexts.join('\n\n---\n\n'), contacts, diagnostics, link_audit: linkAudit,
    identity: { title: identityTitle, h1: identityH1 }, deterministicFailure: null,
    dedup: { chars_before: dedupCharsBefore, chars_after: dedupCharsAfter },
    tls_unverified: !!tlsUnverified,
    protocol_fallback: protocolFallback ? 'https_to_http' : null,
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
// Nagłówek promptu WSPÓLNY dla wszystkich tenantów (decyzja przed ETAPEM B) —
// ogólne instrukcje, zasada "nie zgaduj", bramki, format odpowiedzi. Sekcja
// SYGNAŁÓW jest doklejana dynamicznie (buildSystemPrompt) z konfiguracji
// tenanta, patrz tenantIcpConfigService.js. Bramki zostają globalne w V1.
const PROMPT_STATIC_HEADER = `Jesteś analitykiem oceniającym, czy firma B2B pasuje do profilu klienta systemu CRM
(CRMtree) — firmy z formalnym działem handlowym i złożonym, relacyjnym procesem sprzedaży,
nie sklepu samoobsługowego czy zakupu impulsowego.

═══════════════════════════════════════
ZASADA GŁÓWNA (recall-first — decyzja biznesowa 2026-09-23): firma ma trafić do
handlowca nawet przy niepełnym dowodzie — koszt zbędnego telefonu jest dla nas dużo
niższy niż koszt pominięcia realnego klienta. Oceniaj sygnały SEMANTYCZNIE, nie przez
dopasowanie dosłownej frazy:
  • Wiarygodna, konkretna przesłanka biznesowa WYSTARCZA do true — nie wymagaj
    literalnej nazwy stanowiska, dokładnego sformułowania ani „podręcznikowego”
    dowodu. Jeśli opis firmy jednoznacznie wskazuje na dany mechanizm biznesowy,
    nawet innymi słowami niż w definicji sygnału niżej, zalicz jako dopasowanie.
  • Przy rozsądnej niepewności (dowód jest wiarygodny, ale niepełny lub pośredni)
    wybieraj TRUE, nie FALSE.
  • WYJĄTEK — NIGDY nie ustawiaj true bez ŻADNEJ konkretnej przesłanki z treści: sama
    branża, sama wielkość firmy albo czysty domysł bez punktu zaczepienia w tekście to
    wciąż za mało. Musi być COŚ konkretnego w treści, na czym opierasz wniosek — ale
    to „coś” nie musi być idealne, dosłowne ani jedyną możliwą interpretacją.
  • ZASADA NIEZALEŻNOŚCI DOWODU (2026-09-23, trzecia tura): jeden fragment tekstu
    może uzasadniać więcej niż jeden sygnał TYLKO jeśli faktycznie zawiera OSOBNY
    sens biznesowy dla każdego z nich. Sama ogólna fraza typu "biuro projektowe",
    "obsługa klienta", "doradztwo" nie może automatycznie zapalać kilku różnych
    sygnałów naraz — sprawdź dla KAŻDEGO sygnału osobno, czy fragment realnie
    opisuje TO KONKRETNE zjawisko, czy tylko przypomina je z nazwy.
Jeśli treści brakuje CAŁKOWICIE (pusta/martwa strona, zero danych): bramki → "unknown",
sygnały → false — to jedyny przypadek false z braku danych, nie z braku pewności.
═══════════════════════════════════════

BRAMKI (status: "pass" / "fail" / "unknown") — WYŁĄCZNIE informacyjne. NIE wpływają na wynik
(icp_score), NIE dyskwalifikują firmy i NIE zmieniają oceny żadnego sygnału — oceń każdy
sygnał niezależnie od wyniku bramek, nawet gdy bramka wychodzi "fail" albo "unknown":

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
profilu CRMtree, nie sygnał "dobrego momentu". Poniżej lista sygnałów TEGO KLIENTA —
inny klient może mieć inną listę.`;

// Blok promptu dla JEDNEGO sygnału tenanta — [key: ...] mówi AI dokładnie jakiej
// wartości "key" użyć w odpowiedzi JSON (signals[].key musi być tym samym stringiem).
// Świadomie KEY, nie techniczne UUID (analiza przed wdrożeniem, patrz komentarz
// przy validateAiSignalsResponse): key jest krótszy (mniej tokenów promptu i
// odpowiedzi razy N sygnałów), czytelny semantycznie, i tak samo niezmienny jak
// id — model nie ma żadnego powodu operować na UUID. Treść pod etykietą to
// ai_definition z tenant_icp_signals, wklejana bez zmian (admin edytuje ją w
// przyszłej zakładce Tenant → Enrichment/ICP).
function buildSignalPromptBlock(signal) {
  return `"${signal.label}" [key: ${signal.key}]:\n  ${signal.ai_definition}`;
}

// Kontrakt odpowiedzi AI — STAŁY kształt niezależnie od liczby sygnałów tenanta
// (5 czy 12): "signals" to zawsze tablica {key,value,reasoning}, NIE dynamiczny
// obiekt z kluczami per sygnał (stary format icp_signals{}/signal_reasoning{}).
// Przykładowe wpisy niżej są wygenerowane z RZECZYWISTYCH key aktywnych sygnałów
// tego tenanta, więc AI wie dokładnie ile obiektów i jakich key oczekujemy —
// walidacja odpowiedzi (validateAiSignalsResponse) to później twardo egzekwuje.
function buildJsonContractSection(activeSignals) {
  const signalsExample = activeSignals
    .map(s => `    {"key": "${s.key}", "value": <true|false>, "reasoning": "<max 10 słów>"}`)
    .join(',\n');
  return `═══════════════════════════════════════
Zwróć odpowiedź WYŁĄCZNIE jako JSON (bez markdown, bez \`\`\`):
{
  "gates": {
    "b2b": "pass|fail|unknown",
    "company_size": "pass|fail|unknown"
  },
  "signals": [
${signalsExample}
  ],
  "ai_summary": "<2-3 zdania po polsku: DLACZEGO ta firma pasuje lub nie pasuje do CRMtree, jakie konkretne cechy na to wskazują>",
  "key_contacts": [
    {"name": "<imię nazwisko>", "title": "<stanowisko>", "email": "<email lub null>", "phone": "<telefon lub null>"}
  ]
}

Dla "signals": zwróć DOKŁADNIE jeden obiekt dla KAŻDEGO "key" wymienionego w sekcji SYGNAŁY
powyżej — nie pomijaj żadnego, nie dodawaj "key" spoza tej listy. "value" to zawsze true albo
false (AI nigdy nie przydziela punktów — to robi backend). "reasoning" max 10 słów po polsku.
Dla key_contacts: wypełnij tylko pola których jesteś pewien. Puste pole → null. Max 8 osób.`;
}

// Pełny SYSTEM_PROMPT dla KONKRETNEGO tenanta — core prompt (PROMPT_STATIC_HEADER)
// jest wspólny dla wszystkich, doklejana jest tylko sekcja sygnałów i przykładowy
// kontrakt JSON zbudowany z aktywnych sygnałów TEGO tenanta (tyle wpisów, ile ma
// aktywnych sygnałów — 5, 8, 12, cokolwiek).
function buildSystemPrompt(activeSignals) {
  const signalsSection = activeSignals.map(buildSignalPromptBlock).join('\n\n');
  return `${PROMPT_STATIC_HEADER}\n\n${signalsSection}\n\n${buildJsonContractSection(activeSignals)}`;
}

// Zwalidowana odpowiedź AI dla "signals": każdy AKTYWNY sygnał tenanta musi
// wystąpić DOKŁADNIE RAZ (po key, nie po technicznym id — patrz analiza przy
// buildSignalPromptBlock), bez nieznanych key, value musi być boolean. Brakujący
// sygnał to NIGDY ciche false — to invalid/incomplete response, rzucamy błąd
// (enrichOne go łapie i ustawia enrichment_status='error', tak jak każdy inny
// błąd tego kroku — patrz catch w enrichOne).
class IcpAiResponseValidationError extends Error {}

function validateAiSignalsResponse(rawSignals, activeSignals) {
  if (!Array.isArray(rawSignals)) {
    throw new IcpAiResponseValidationError('Odpowiedź AI: "signals" nie jest tablicą (albo jej brak)');
  }
  const expectedKeys = new Set(activeSignals.map(s => s.key));
  const seenKeys = new Set();
  for (const entry of rawSignals) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') {
      throw new IcpAiResponseValidationError('Odpowiedź AI: wpis w "signals" bez poprawnego "key"');
    }
    if (!expectedKeys.has(entry.key)) {
      throw new IcpAiResponseValidationError(`Odpowiedź AI: nieznany key sygnału "${entry.key}" spoza aktywnej konfiguracji tenanta`);
    }
    if (seenKeys.has(entry.key)) {
      throw new IcpAiResponseValidationError(`Odpowiedź AI: key sygnału "${entry.key}" powtórzony w "signals"`);
    }
    seenKeys.add(entry.key);
    if (typeof entry.value !== 'boolean') {
      throw new IcpAiResponseValidationError(`Odpowiedź AI: "value" dla sygnału "${entry.key}" nie jest boolean`);
    }
  }
  const missing = [...expectedKeys].filter(key => !seenKeys.has(key));
  if (missing.length > 0) {
    throw new IcpAiResponseValidationError(`Odpowiedź AI: brak wpisu "signals" dla key: ${missing.join(', ')}`);
  }
  return true;
}


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

// Połączony prompt (dla endpointu inspekcji /prompt) — activeSignals to
// aktywna konfiguracja ICP tenanta (tenantIcpConfigService.getActiveConfig()
// .activeSignals), caller ją pobiera raz i przekazuje tutaj.
function buildPromptText(company, krsData, websiteText, activeSignals, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
  return `${buildSystemPrompt(activeSignals)}\n\n${buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText)}`;
}

async function callDeepSeek(userMessage, systemPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const { data } = await axios.post(
    DEEPSEEK_API,
    {
      model: DEEPSEEK_MODEL,
      max_tokens: 3000,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
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

async function callAnthropic(userMessage, systemPrompt) {
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
          text: systemPrompt,
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

// activeSignals: konfiguracja ICP tenanta (tenantIcpConfigService.getActiveConfig()
// .activeSignals) — caller (enrichOne) ją pobiera RAZ i przekazuje tutaj, żeby nie
// odpytywać bazy drugi raz przy scoringu. Walidacja odpowiedzi rzuca
// IcpAiResponseValidationError (niezłapane tutaj celowo — propaguje do enrichOne,
// które oznacza enrichment jako 'error', tak jak każdy inny błąd tego kroku).
// Całkowity brak parsowalnego JSON-a (raw nie jest JSON-em wcale) rzuca ten sam
// IcpAiResponseValidationError — enrichment MUSI wejść w ścieżkę 'error' (i tym
// samym w retry), nigdy nie zapisać się jako 'done' z syntetycznym icp_score=0
// (naprawione 2026-09-23 — wcześniej zwracało result=null, co enrichOne cicho
// zapisywał jako pozornie ukończony enrichment z zerowym wynikiem).
async function analyzeWithAi(company, krsData, websiteText, activeSignals, fbData = null, linkedinText = '', gusData = null, pracujText = '') {
  const { rows } = await db.query(
    `SELECT value FROM app_settings WHERE key = 'prospect.ai_provider' AND tenant_id = $1`,
    [company.tenant_id]
  );
  const provider = rows[0]?.value || 'deepseek';

  const systemPrompt = buildSystemPrompt(activeSignals);
  const userMessage = buildUserMessage(company, krsData, websiteText, fbData, linkedinText, gusData, pracujText);
  const { content: raw, model: usedModel, usage } = provider === 'anthropic'
    ? await callAnthropic(userMessage, systemPrompt)
    : await callDeepSeek(userMessage, systemPrompt);

  logger.info('[Prospect] AI raw response', { provider, company: company.company_name, rawLength: raw.length, rawPreview: raw.slice(0, 500) });

  let parsed;
  try {
    parsed = JSON.parse(raw);
    logger.info('[Prospect] AI parse OK', { provider, company: company.company_name, signals: parsed.signals, summary: parsed.ai_summary?.slice(0, 80) });
  } catch {
    // Fallback: wytnij blok {} i spróbuj jeszcze raz
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn('[Prospect] AI returned unparseable response', { provider, preview: raw.slice(0, 200) });
      throw new IcpAiResponseValidationError('Odpowiedź AI: nie udało się sparsować jako JSON (brak bloku {})');
    }
    try {
      parsed = JSON.parse(match[0]);
      logger.info('[Prospect] AI parse OK (regex fallback)', { provider, company: company.company_name, signals: parsed.signals });
    } catch {
      logger.warn('[Prospect] AI JSON malformed after regex extract', { provider, rawLength: raw.length, rawTail: raw.slice(-200), preview: match[0].slice(0, 300) });
      throw new IcpAiResponseValidationError('Odpowiedź AI: JSON niepoprawny nawet po ekstrakcji bloku {}');
    }
  }

  // JSON sparsowany poprawnie — teraz musi respektować kontrakt "signals" (jeden
  // wpis per AKTYWNY sygnał tenanta, bez braków/duplikatów/nieznanych id). Rzuca,
  // nie zwraca null — brakujący sygnał to invalid response, nie ciche false.
  validateAiSignalsResponse(parsed.signals, activeSignals);
  return { result: parsed, provider, model: usedModel, usage };
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
    // Fallback company_size (poprawka 21.09): JSON-LD numberOfEmployees z tej
    // SAMEJ strony LinkedIn, już i tak pobieranej wyżej dla innych pól — zero
    // dodatkowego requestu wyłącznie po zatrudnienie. Użyte niżej TYLKO gdy
    // import nie dał ani employment_count ani employment_range (patrz
    // employmentSource przy buildIcpGates) — import zawsze ma pierwszeństwo.
    let linkedinEmploymentCount = null;
    let linkedinEmploymentRange = null;

    if (opts.processLinkedin) {
      const linkedinFound = await findLinkedinUrl(company);
      if (linkedinFound.url) {
        resolvedLinkedinUrl = linkedinFound.url;
        const linkedinResult = await scrapeLinkedin(resolvedLinkedinUrl);
        linkedinText = linkedinResult.text;
        linkedinEmploymentCount = linkedinResult.employmentCount;
        linkedinEmploymentRange = linkedinResult.employmentRange;
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
               icp_gate_points        = NULL,
               icp_gate_status        = 'needs_review',
               icp_config_version_id   = NULL,
               ai_summary              = NULL,
               enriched_at               = NOW(),
               enrichment_log             = $2
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
      // Zaufanie jednorazowe, per to wywołanie — patrz isDomainTrustedForThisRun
      // (poprawka 18.09: wcześniej czytaliśmy tu też trwałą kolumnę
      // website_source==='manual_correction', co dawało bezterminowe obejście).
      const trustedByHuman = isDomainTrustedForThisRun(opts);

      const fastScraped = await scrapeWebsiteFast(websiteUrl);
      let scraped = fastScraped;
      let identityCheck = computeIdentityCheck(fastScraped);

      // Identity fallback na TEJ SAMEJ domenie (20.09, case Alior Bank): homepage
      // nie dała mocnego dowodu, ale dane prawne bywają w stopce lub na
      // /kontakt, /regulamin, /polityka-prywatnosci. Uruchamiany tylko gdy
      // wynik to insufficient_evidence (NIE przy konflikcie zagranicznego
      // adresu, parkingu ani błędzie deterministycznym) i nie zaufano domenie.
      // Zatwierdza wyłącznie mocny dowód (NIP/KRS/REGON albo kod+ulica) — patrz
      // evaluateIdentityFallback. Nic tu nie omija checkDomainIdentity.
      let identityFallback = null;
      let brandFallback = null;
      if (!fastScraped.deterministicFailure && !trustedByHuman && !identityCheck.verified
          && identityCheck.reason === 'insufficient_evidence'
          && (fastScraped.text || '').trim() && fastScraped.crawlState) {
        const fallbackTitle = `${fastScraped.identity?.title || ''} ${fastScraped.identity?.h1 || ''}`.trim();
        identityFallback = await runIdentityFallback({
          company, krsData, gusData, crawlState: fastScraped.crawlState, title: fallbackTitle,
        });
        logger.info('[Prospect] Identity fallback on same domain', {
          prospectId, websiteUrl, verified: identityFallback.verified, decidedBy: identityFallback.decided_by,
          pages: (identityFallback.pages_checked || []).length,
        });
        if (identityFallback.verified) {
          identityCheck = { verified: true, reason: identityFallback.reason, evidence: identityFallback.evidence, via_fallback: true };
        } else if (identityFallback.reason === 'insufficient_evidence') {
          // strong_brand_identity V3 (21.09) — TYLKO gdy strict identity
          // fallback wyżej nie znalazł nic i nie natrafił na
          // foreign_address_conflict (ten wciąż wygrywa bez zmian). Reużywa
          // te same, już pobrane strony (raw_sources) — zero dodatkowych
          // requestów. Patrz komentarz przy evaluateBrandIdentityFallback.
          brandFallback = evaluateBrandIdentityFallback({
            company, krsData, gusData, candidateUrl: websiteUrl, candidateSource: websiteSource,
            homepageTitle: fallbackTitle, sources: identityFallback.raw_sources || [],
            // Tekst PO ekstrakcji (bez nawigacji/nagłówka/stopki) — patrz
            // BRAND_CONTENT_MIN_HITS. raw_sources zawierają boilerplate, więc
            // nie nadają się do sprawdzenia, czy marka jest w realnej treści.
            contentText: fastScraped.text || '',
          });
          logger.info('[Prospect] Brand identity fallback (V3) on same domain', {
            prospectId, websiteUrl, verified: brandFallback.verified, reason: brandFallback.reason, decidedBy: brandFallback.decided_by,
          });
          if (brandFallback.verified) {
            identityCheck = { verified: true, reason: brandFallback.reason, evidence: brandFallback.positive_evidence, via_fallback: true, via_brand_fallback: true };
          } else if (brandFallback.reason !== 'insufficient_evidence') {
            // Jawny konflikt (legal_entity_conflict / foreign_entity_or_country_conflict
            // / different_entity_brand) — silniejszy, nazwany powód niż zwykłe
            // insufficient_evidence, mimo że identityCheck.verified zostaje false
            // (rekord i tak idzie do needs_review — to samo zachowanie DB co dziś,
            // różnica jest wyłącznie w czytelności identity_check.reason w logu).
            identityCheck = { verified: false, reason: brandFallback.reason, evidence: brandFallback.conflict_evidence, via_brand_fallback: true };
          }
        }
      }

      if (fastScraped.deterministicFailure) {
        // Błąd deterministyczny (TLS/DNS, potwierdzony parking domeny, zły
        // URL) — pełny crawl na TEJ domenie zobaczyłby dokładnie to samo,
        // więc go nie dokańczamy (decyzja 20.08, DETERMINISTIC_FETCH_ERROR).
        //
        // ETAP 2 (23.09): ale zanim uznamy firmę za `no_website`, próbujemy
        // znaleźć INNĄ domenę — dokładnie tym samym resolverem, którego używa
        // już gałąź "domena niepotwierdzona" niżej. Wcześniej martwa domena z
        // importu kończyła enrichment natychmiast, bez ani jednej próby
        // alternatywy (audyt 47 firm: wszystkie 10 `no_website` miało
        // `fallback: BRAK`, mimo że dla 3 z nich istniała żywa domena —
        // artmed.pl, joanelektronic.pl, airtificial.com).
        //
        // UWAGA do historii: fallback po deterministicFailure testowano 21.08
        // (0/20 odzyskanych, +330% czasu) i wycofano. Tamten pomiar powstał
        // jednak PRZED naprawą budżetu resolvera (etap 1, 23.09) — przy
        // budżecie 8 s i koszcie do 12 s na kandydata fallback potrafił
        // zwrócić `timeout` nie sprawdziwszy nikogo, więc "0/20" mogło mierzyć
        // zepsuty timeout, a nie brak sensu tej ścieżki. Stąd ponowna próba,
        // tym razem z pomiarem po naprawie.
        //
        // Identity NIE jest osłabione: checkFallbackCandidate woła
        // checkDomainIdentity i zwraca verified:true wyłącznie przy mocnym
        // dowodzie (NIP/KRS/REGON albo kod+ulica). Domena z fallbacku
        // przechodzi tę samą ścieżkę co domena z importu.
        let deadDomainFallback = null;
        if (!trustedByHuman) {
          deadDomainFallback = await resolveDomainFallback({
            company, krsData, gusData, rejectedUrl: websiteUrl,
          });
          enrichLog.website.dead_domain_fallback = {
            attempted:        true,
            rejected_url:     websiteUrl,
            rejected_reason:  fastScraped.deterministicFailure.type,
            candidates_tried: (deadDomainFallback.attempts || []).length,
            found_url:        deadDomainFallback.url,
            method:           deadDomainFallback.method,
          };
        }

        if (deadDomainFallback?.url) {
          logger.info('[Prospect] Dead imported domain — fallback found a verified alternate', {
            prospectId, rejectedUrl: websiteUrl, foundUrl: deadDomainFallback.url,
            rejectedReason: fastScraped.deterministicFailure.type,
          });
          websiteUrl    = deadDomainFallback.url;
          websiteSource = 'resolver';
          scraped       = await continueCrawlToFull(websiteUrl, deadDomainFallback.scraped.crawlState);
          identityCheck = computeIdentityCheck(scraped);
          scanStage     = 'full';
          enrichLog.website.url    = websiteUrl;
          enrichLog.website.source = websiteSource;
        } else {
          logger.info('[Prospect] Fast scan hit a deterministic failure — not completing crawl', {
            prospectId, websiteUrl, type: fastScraped.deterministicFailure.type, reason: fastScraped.deterministicFailure.reason,
          });
          scanStage = fastScraped.deterministicFailure.type === 'domain_parking'
            ? 'fast_domain_parking'
            : 'fast_deterministic_fetch_error';
        }
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
        // wąskiej treści fast. Łączenie z dotychczasowym `identityCheck` (który
        // w tym miejscu może już nieść potwierdzenie ze strict fallbacku LUB
        // z V3 brand fallbacku) idzie przez resolveIdentityMonotonically —
        // patrz komentarz przy tej funkcji: hard conflict > wcześniejsze
        // verified > insufficient_evidence, nigdy odwrotnie.
        {
          const recomputed = computeIdentityCheck(scraped);
          identityCheck = resolveIdentityMonotonically(identityCheck, recomputed);
        }
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
      // Strona pobrana mimo błędu certyfikatu TLS (patrz TLS_CERT_ERROR /
      // fetchInsecureFallback) — wyłącznie odzyskanie treści, checkDomainIdentity
      // niżej nadal decyduje o weryfikacji bez żadnej taryfy ulgowej.
      if (scraped.tls_unverified) enrichLog.website.tls_unverified = true;
      // Homepage odzyskana po http:// zamiast https:// (fetchHttpFallback) —
      // wyłącznie gdy błąd certyfikatu i insecure fallback też zawiodły
      // (patrz komentarz przy fetchHttpFallback). checkDomainIdentity niżej
      // nadal decyduje o weryfikacji bez żadnej taryfy ulgowej.
      if (scraped.protocol_fallback) enrichLog.website.protocol_fallback = scraped.protocol_fallback;
      // Diagnostyka per-kandydat (decyzja 19.08) — żadna strona nie znika bez
      // śladu: url, próby, status HTTP, długości przed/po, czy weszła do
      // finalnej treści, i dokładny powód jeśli nie.
      enrichLog.website.candidates = scraped.diagnostics || [];
      // ETAP 4 (audytowalność retrievalu, 19.09) — KAŻDY odkryty link (nie
      // tylko pobrane) z jego score/kategorią/losem w lejku selekcji, jedną
      // z 8 klas: LINK_SCORE_TOO_LOW, PAGE_NOT_SELECTED, FETCH_FAILED,
      // BOT_CHALLENGE, CATEGORY_BUDGET_EXHAUSTED, GLOBAL_12K_TRUNCATION,
      // EVIDENCE_REACHED_AI. Pozwala odpowiedzieć "czy AI dostało stronę z
      // dowodem" bez przeszukiwania logów ręcznie — patrz buildLinkAudit().
      enrichLog.website.link_audit = scraped.link_audit || [];
      // Szczegóły identity-check (decyzja 20.08) — NIP/KRS/REGON sprawdzone i
      // trafione, nazwa firmy vs title/h1, adres z KRS/GUS i czy trafił w
      // tekście, oraz czy wykryto konflikt zagranicznego adresu.
      // Diagnostyka (20.09): na pytanie "dlaczego ta domena została uznana za
      // właściwą albo odrzucona?" odpowiadają pola poniżej — kandydat i jego
      // źródło, jaki dowód zdecydował (decided_by), czy zadziałał identity
      // fallback oraz które strony sprawdzono i co na każdej znaleziono.
      enrichLog.website.identity_check = {
        verified: identityCheck.verified,
        reason:   identityCheck.reason,
        evidence: identityCheck.evidence || null,
        candidate_url:    websiteUrl,
        candidate_source: websiteSource || null,
        trusted_by_human: trustedByHuman,
        // Priorytet zgodny z resolveIdentityMonotonically: jeśli finalny
        // identityCheck.reason to twardy konflikt NIEZNANY wcześniejszym etapom
        // (odkryty dopiero na przeliczeniu po pełnym crawlu — patrz komentarz
        // przy tej funkcji), decided_by musi to pokazać wprost, żeby log nie
        // pokazywał mylącego "brand_verified"/fallback-decided_by dla rekordu,
        // który finalnie został odrzucony.
        decided_by: (HARD_IDENTITY_CONFLICT_REASONS.has(identityCheck.reason)
          && identityCheck.reason !== identityFallback?.reason && identityCheck.reason !== brandFallback?.reason)
          ? `${identityCheck.reason}@recompute_full_crawl`
          : identityFallback?.verified
            ? identityFallback.decided_by
            : (brandFallback && (brandFallback.verified || brandFallback.reason !== 'insufficient_evidence'))
              ? brandFallback.decided_by
              : (trustedByHuman && !identityCheck.verified ? 'trusted_domain_override' : identityCheck.reason),
        fallback: identityFallback
          ? {
              attempted:  identityFallback.attempted,
              used:       !!identityFallback.verified,
              verified:   identityFallback.verified,
              reason:     identityFallback.reason,
              decided_by: identityFallback.decided_by,
              pages_checked: identityFallback.pages_checked || [],
              sources:    identityFallback.sources || [],
            }
          : { attempted: false, used: false },
        // strong_brand_identity V3 (21.09) — wołany tylko gdy fallback wyżej
        // był attempted i insufficient_evidence, patrz evaluateBrandIdentityFallback.
        // via_brand_fallback jawnie mówi, czy TEN werdykt (verified LUB konkretny
        // powód odrzucenia) pochodzi z V3, a nie ze strict identity check.
        brand_fallback: brandFallback
          ? {
              attempted: true,
              used: !!brandFallback.verified,
              via_brand_fallback: true,
              verified: brandFallback.verified,
              reason: brandFallback.reason,
              decided_by: brandFallback.decided_by,
              positive_evidence: brandFallback.positive_evidence || null,
              conflict_evidence: brandFallback.conflict_evidence || null,
              cap_reason: brandFallback.cap_reason || null,
              points: brandFallback.points ?? null,
              threshold: brandFallback.threshold ?? null,
            }
          : { attempted: false, used: false },
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
             enrichment_status   = 'needs_review',
             website_url         = $2,
             website_source      = COALESCE(website_source, $5),
             website_status      = 'unconfirmed',
             icp_score            = NULL,
             icp_signals           = NULL,
             icp_gates              = NULL,
             icp_bonus_signals       = NULL,
             icp_gate_points          = NULL,
             icp_gate_status          = 'needs_review',
             icp_config_version_id     = NULL,
             icp_downgrade_flags       = $3,
             ai_summary                 = NULL,
             enriched_at                  = NOW(),
             enrichment_log                 = $4
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
          // no_website tylko dla potwierdzonego parkingu/nieistniejącej domeny na
          // niezaufanym źródle; ręcznie potwierdzona domena (manual_correction/
          // trustedDomain) po błędzie pobrania ZAWSZE ląduje jako needs_review.
          //
          // ETAP 2 (23.09): jeśli fallback podmienił martwą domenę z importu na
          // inną, zweryfikowaną, to `fastScraped.deterministicFailure` opisuje
          // JUŻ NIEUŻYWANĄ domenę — nie wolno na jego podstawie orzekać
          // `no_website` o domenie, która realnie odpowiada. Taki rekord idzie
          // do needs_review (mamy domenę, tylko bez treści), nie do no_website.
          const deadDomainReplaced = !!enrichLog.website?.dead_domain_fallback?.found_url;
          const finalStatus = (!trustedByHuman && !deadDomainReplaced
                               && isConfirmedDeadDomain(fastScraped.deterministicFailure))
            ? 'no_website'
            : 'needs_review';
          await persistUpdate(
            `UPDATE prospect_companies SET
               enrichment_status = $5,
               website_url       = COALESCE($3, website_url),
               website_status    = $4,
               icp_score          = NULL,
               icp_signals         = NULL,
               icp_gates            = NULL,
               icp_bonus_signals     = NULL,
               icp_gate_points        = NULL,
               icp_gate_status        = 'needs_review',
               icp_config_version_id   = NULL,
               ai_summary              = NULL,
               enriched_at               = NOW(),
               enrichment_log             = $2
             WHERE id = $1`,
            [prospectId, JSON.stringify(enrichLog), websiteUrl, websiteStatus, finalStatus]
          );
          logger.info('[Prospect] Website scrape returned no content — stopping', { prospectId, websiteUrl, finalStatus });
          return { status: finalStatus, prospectId, ...(dryRun ? { dryRun: true, enrichment_log: enrichLog } : {}) };
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
    //
    // Konfiguracja ICP tenanta — pobrana RAZ, użyta i do budowy promptu
    // (buildSystemPrompt w analyzeWithAi), i do scoringu (calcIcpScore) niżej, i do
    // icp_config_version_id zapisywanego z wynikiem.
    //
    // CELOWO getPublishedConfig(), NIE getActiveConfig(): enrichment musi zawsze
    // czytać ostatnią PUBLISHED (już zweryfikowaną jako poprawną) wersję configu,
    // nigdy roboczy LIVE stan w tenant_icp_signals — LIVE może być CHWILOWO invalid
    // w trakcie edycji (np. admin przenosi punkty między sygnałami: suma na chwilę
    // 75/70), a to nie może przerywać ani psuć trwającego enrichmentu. Stara,
    // poprawna PUBLISHED wersja (albo fallback DEFAULT_SIGNALS, jeśli tenant
    // jeszcze nigdy niczego nie opublikował) obsługuje enrichment przez cały czas
    // edycji — dopiero powrót LIVE do poprawnej sumy automatycznie publikuje nową
    // wersję (tenantIcpConfigService.bumpRevisionAndMaybePublish), bez żadnego
    // ręcznego przycisku "Publikuj".
    const icpConfig = await tenantIcpConfigService.getPublishedConfig(company.tenant_id);
    // Defensywna asercja, nie pierwsza linia obrony: getPublishedConfig() z
    // konstrukcji zwraca zawsze coś, co było poprawne W MOMENCIE publikacji —
    // to może się jedynie rozjechać, gdyby PO fakcie zmienił się globalny
    // ICP_REQUIRED_SIGNALS_MAX_SCORE (np. deploy zmieniający wymaganą sumę, tak
    // jak decyzja 2026-09-22 sama to zrobiła — wtedy trzeba było uruchomić
    // src/scripts/migrateIcpSignalsTo100.js PRZED deployem, patrz ten skrypt).
    // Zatrzymuje enrichment zamiast po cichu policzyć max_score inny niż 100.
    const icpConfigValidity = evaluateIcpConfigValidity(icpConfig);
    if (!icpConfigValidity.isValid) {
      throw new Error(
        `Opublikowana konfiguracja ICP tenanta (wersja ${icpConfig.currentVersionNumber ?? 'domyślna'}) ` +
        `jest nieprawidłowa względem AKTUALNEGO wymogu: suma AKTYWNYCH sygnałów wynosi ` +
        `${icpConfigValidity.signalsSum}, oczekiwano dokładnie ${icpConfigValidity.signalsMax}. ` +
        `To nie powinno się zdarzyć dla normalnej edycji w Ustawienia aplikacji → Enrichment/ICP — sprawdź, czy ` +
        `ICP_REQUIRED_SIGNALS_MAX_SCORE nie zmienił się w kodzie od czasu ostatniej publikacji configu tego ` +
        `tenanta (jeśli tak, uruchom migrację przed deployem, patrz src/scripts/migrateIcpSignalsTo100.js).`
      );
    }

    const { result: analysis, provider: usedProvider, model: usedModel, usage: aiUsage } = await analyzeWithAi(company, krsData, websiteText, icpConfig.activeSignals, fbData, linkedinText, gusData, pracujText);

    // Oddziały: tylko z KRS (twarde dane) — nowy prompt ICP nie zwraca już
    // branches_found (to była część starego travel-scoringu).
    const branchesCount = krsData?.branchesCount ?? null;
    const branchesScope = krsData?.branchesScope ?? null;

    // Bramki: b2b z AI bez zmian, company_size WYŁĄCZNIE deterministycznie z
    // employment_count/employment_range (patrz calcCompanySizeGate). Priorytet
    // źródeł danych o zatrudnieniu (poprawka 21.09): import z CSV zawsze
    // pierwszy — LinkedIn JSON-LD tylko gdy import nie dał NIC (ani count, ani
    // range). Dane z importu w company.employment_count/_range NIGDY nie są
    // nadpisywane wartością z LinkedIn — to tylko efemeryczny fallback na czas
    // TEGO przebiegu, nie trafia do kolumn importowych w bazie.
    const hasImportEmployment = company.employment_count != null || company.employment_range != null;
    const hasLinkedinEmployment = linkedinEmploymentCount != null || linkedinEmploymentRange != null;
    const effectiveEmploymentCount = hasImportEmployment ? company.employment_count : linkedinEmploymentCount;
    const effectiveEmploymentRange = hasImportEmployment ? company.employment_range : linkedinEmploymentRange;
    const employmentSource = hasImportEmployment ? 'import' : (hasLinkedinEmployment ? 'linkedin_jsonld' : 'none');
    // Ta jedna wartość `gates` jest używana wszędzie niżej (status, punkty, log,
    // zapis do bazy, zwrot dryRun) — żadna ścieżka nie czyta już analysis.gates
    // bezpośrednio.
    const gates = analysis ? buildIcpGates(analysis.gates, effectiveEmploymentCount, effectiveEmploymentRange) : null;

    const scoreResult   = calcIcpScore(analysis?.signals, icpConfig.activeSignals);
    const gateStatus    = icpGateStatus(gates);
    const gatePointsResult = calcIcpGatePoints(gates);
    const downgradeFlags = calcIcpDowngradeFlags(websiteUrl, websiteStatus);

    // Blacklista ICP (np. hurtownie) — kara punktowa do icp_score, NIE zmienia
    // gate_status. Słowa/kara z app_settings, fallback na stałe gdy brak wiersza.
    const icpBlacklist     = await loadIcpBlacklistSettings(company.tenant_id);
    const blacklistMatches = matchesIcpBlacklist(icpBlacklist.keywords, company, gusData);
    const blacklistPenalty = blacklistMatches ? icpBlacklist.penalty : 0;
    if (blacklistMatches) {
      downgradeFlags.push({
        id: 'icp_blacklist',
        label: `Na blacklist ICP (${blacklistMatches.join(', ')}) — -${blacklistPenalty} pkt`,
        points: -blacklistPenalty,
        matched: blacklistMatches,
      });
    }

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

    // Decyzja 2026-09-22: icp_score = wyłącznie suma trafionych sygnałów (minus
    // kara blacklisty) — gatePointsResult/bonusResult dalej się liczą i zapisują
    // (icp_gate_points, icp_bonus_signals — informacyjne w Inspekcji), ale już nie
    // wchodzą do sumy wyniku.
    const totalScore = Math.max(0, Math.min(100, scoreResult.raw - blacklistPenalty));

    enrichLog.claude = {
      provider:     usedProvider,
      // Dokładny model z odpowiedzi API (nie z konfiguracji requestu) — np.
      // DeepSeek zwraca "deepseek-v4-flash" mimo że w requeście wysłaliśmy
      // model: "deepseek-chat" (alias). Fallback na stałą tylko gdyby usage/model
      // nie przyszły w odpowiedzi.
      model:        usedModel || (usedProvider === 'anthropic' ? ANTHROPIC_MODEL : DEEPSEEK_MODEL),
      icp_raw:      scoreResult.raw,
      icp_bonus:    bonusResult.bonus,
      icp_gate_points: gatePointsResult.points,
      icp_blacklist_penalty: blacklistPenalty,
      icp_blacklist_matched: blacklistMatches || null,
      icp_total:    totalScore,
      gate_status:  gateStatus,
      // Audyt bramki company_size: wartość finalna (deterministyczna), dane wejściowe
      // (z importu ORAZ, jeśli użyty, fallback LinkedIn — patrz employmentSource),
      // oraz to, co zwróciło AI — żeby nadpisanie było widoczne w Inspekcji.
      company_size_gate: {
        value:                     gates?.company_size ?? null,
        employment_count:          company.employment_count ?? null,
        employment_range:          company.employment_range ?? null,
        employment_source:         employmentSource, // 'import' | 'linkedin_jsonld' | 'none'
        linkedin_employment_count: linkedinEmploymentCount,
        linkedin_employment_range: linkedinEmploymentRange,
        ai_value:                  analysis?.gates?.company_size ?? null,
        overridden:                (analysis?.gates?.company_size ?? null) !== (gates?.company_size ?? null),
      },
      signal_reasoning: buildSignalReasoningMap(analysis?.signals, icpConfig.activeSignals),
      icp_config_version_id: icpConfig.currentVersionId,
      icp_config_is_default: icpConfig.isDefault,
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
        icp_gate_points           = $29,
        icp_config_version_id     = $30,
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
        gates ? JSON.stringify(gates) : null,
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
        JSON.stringify(gatePointsResult.breakdown),
        icpConfig.currentVersionId,
      ]
    );

    return {
      status: 'done', prospectId,
      ...(dryRun ? {
        dryRun: true,
        icp_score: totalScore,
        icp_signals: scoreResult.breakdown,
        icp_gates: gates,
        icp_gate_status: gateStatus,
        icp_gate_points: gatePointsResult.breakdown,
        icp_downgrade_flags: downgradeFlags,
        icp_config_version_id: icpConfig.currentVersionId,
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
  checkDomainIdentity, isDomainParkingPage, isDomainTrustedForThisRun,
  matchesIcpBlacklist, getIcpScoringRules, calcIcpScore, buildSignalReasoningMap,
  // Eksport na potrzeby ręcznego/testowego wywołania fallbacku drugiej domeny
  // w izolacji (audyt 21.08) — enrichOne woła resolveDomainFallback()
  // wewnętrznie (patrz gałąź "domena niepotwierdzona i nie zaufana"), ten
  // eksport służy tylko testom poza pełnym przebiegiem enrichmentu.
  guessFallbackDomains, resolveDomainFallback, verifyUrl, scrapeWebsiteFast,
  // Eksport na potrzeby audytu jakości sygnałów ICP (regresja treści promptu +
  // replay realnych wywołań DeepSeek poza pełnym przebiegiem enrichmentu).
  // SYSTEM_PROMPT nie istnieje już jako stały string (ETAP B, prompt dynamiczny
  // per tenant) — buildSystemPrompt(activeSignals) go zastępuje.
  buildSystemPrompt, PROMPT_STATIC_HEADER, buildSignalPromptBlock, buildJsonContractSection,
  validateAiSignalsResponse, IcpAiResponseValidationError,
  // Wymagana suma punktów sygnałów WYLICZONA z gates/bonus (nie hardkodowana) +
  // helper oceniający config tenanta względem niej — jedyne źródło prawdy dla
  // wszystkiego, co musi znać "ile to ma być 70/100" (enrichOne, getIcpScoringRules,
  // przyszłe API Tenant → Enrichment/ICP).
  ICP_MAX_GATE_SCORE, ICP_BONUS_MAX_SCORE, ICP_TOTAL_MAX_SCORE, ICP_REQUIRED_SIGNALS_MAX_SCORE,
  evaluateIcpConfigValidity,
  buildUserMessage, callDeepSeek,
  // Eksport na potrzeby testów regresyjnych retrievalu (19.09, druga tura —
  // limit różnorodności kandydatów, wykluczenie dokumentów prawnych z budżetu
  // klasyfikacyjnego, dwupoziomowe scorowanie "partner").
  categorizePage, selectDiverseCandidates, selectWithinBudget,
  // Eksport na potrzeby testu regresyjnego tie-breaku (19.09, trzecia tura —
  // strony z osobami/zespołem wygrywają remis score z formularzami kontaktowymi).
  pageRankTieBreakBonus,
  // Eksport na potrzeby testów bramki company_size (20.09) — deterministyczna,
  // z employment_count, bez udziału AI — oraz jej przepływu do statusu/punktów.
  calcCompanySizeGate, buildIcpGates, icpGateStatus, calcIcpGatePoints,
  // Identity fallback (20.09, case Alior Bank) — testy jednostkowe i walidacja
  // poza pełnym enrichOne.
  extractIdentityText, sameSiteHost, pickIdentityFallbackUrls,
  evaluateIdentityFallback, runIdentityFallback,
  // Eksport na potrzeby domknięcia pokrycia testami (20.09, review przed
  // commitem) — obie funkcje czyste, testowalne bez sieci/AI.
  isBotChallengePage, buildLinkAudit,
  // Level 2 hardened HTTP fallback (21.09) — qualifiesForLevel2 testowalne bez
  // sieci; fetchPageHardened/fetchPageResilient testowane przez mock axios.
  qualifiesForLevel2, fetchPageHardened, fetchPageResilient,
  // Etap 3 (23.09) — wariant hosta www ↔ apex przy awarii połączenia
  swapWwwHost, CONNECTION_LEVEL_ERROR,
  // Etap 4 (23.09) — przekierowania client-side (meta refresh / window.location)
  extractClientSideRedirect,
  // Fallback company_size z LinkedIn JSON-LD (21.09) — czysta funkcja
  // parsująca schema.org QuantitativeValue, testowalna bez sieci.
  parseNumberOfEmployees,
  // strong_brand_identity V3 (21.09) — konserwatywny brand-identity fallback,
  // wołany dopiero po strict identity fallback. Funkcje czyste, testowalne
  // bez sieci; evaluateBrandIdentityFallback to punkt wejścia.
  firstDistinctiveNameToken, findLegalEntityConflict, findForeignEntityOrCountryConflict,
  findDifferentEntityBrand, scoreBrandConsistency, evaluateBrandIdentityFallback,
  // Monotonic identity resolution (21.09, po benchmarku 50 firm) — czysta
  // funkcja, testowalna bez sieci/AI.
  resolveIdentityMonotonically, HARD_IDENTITY_CONFLICT_REASONS,
};
