'use strict';
// ─────────────────────────────────────────────────────────────────
// services/callAnalysisService.js
//
// Analizuje notatki z rozmów telefonicznych per-NIP za pomocą
// DeepSeek i oblicza score skłonności do zakupu 0-100.
//
// Env: DEEPSEEK_API_KEY
// ─────────────────────────────────────────────────────────────────

const axios  = require('axios');
const db     = require('../config/database');
const logger = require('../utils/logger');

const DEEPSEEK_API        = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL      = 'deepseek-chat';
const BATCH_CONCURRENCY   = 3;

// ── System prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `Jesteś doświadczonym analitykiem sprzedaży firmy świadczącej usługi CRM dla przedsiębiorstw. Twoje zadanie: na podstawie notatek z rozmów telefonicznych z potencjalnym klientem ocenić skłonność firmy do zakupu usługi.

Skala oceny (score 0-100):
0-20  : Zdecydowanie niezainteresowany — zły segment, jawne odrzucenie lub firma jest konkurentem
21-40 : Niskie zainteresowanie — brak wyraźnej potrzeby, kwestie budżetowe, odwlekanie, brak dostępu do decydenta
41-60 : Umiarkowane zainteresowanie — firma bada opcje, brak pilności, wymagany follow-up
61-80 : Silne zainteresowanie — zidentyfikowana potrzeba, decydent zaangażowany, zdefiniowany horyzont czasowy
81-100: Gotowy do zakupu — potwierdzony budżet i harmonogram, aktywne porównywanie dostawców

BEZWZGLĘDNA REGUŁA — "follow_up_required" MUSI być false, jeśli w transkrypcji NIE DOSZŁO DO ŻADNEJ ROZMOWY Z CZŁOWIEKIEM. Przypadki wymagające natychmiastowego false (bez wyjątku):
- komunikat automatyczny centrali lub operatora: "Abonent chwilowo niedostępny", "poczta głosowa", "skrzynka głosowa", "numer nie istnieje", "numer jest chwilowo niedostępny", "rozmowa nie może zostać połączona", sygnał zajętości bez odbioru
- rozmowa trwała 0–10 sekund lub składa się wyłącznie z automatycznych komunikatów
- brak jakiegokolwiek słowa lub zdania wypowiedzianego przez żywą osobę (pracownika firmy lub handlowca)
Powyższe NIE są sygnałem do follow-up — to po prostu nieodebrane połączenia. Nie wolno dedukować "handlowiec musi oddzwonić" z samego faktu, że połączenie nie przeszło.

Pole "follow_up_required" ustaw na true, gdy z notatek wynika, że handlowiec umówił się na ponowny kontakt lub klient oczekuje kontaktu w przyszłości — niezależnie od tego, czy pada konkretna data. Sygnały wymagające true:
- umówiony telefon/spotkanie/demo na konkretny dzień lub godzinę ("zadzwonię w piątek", "kontakt w poniedziałek", "ponowiona wersja demo w piątek")
- obietnica oddzwonienia lub wysłania informacji ("przekazuje informacje kolezance", "zostajemy w kontakcie", "mamy się odezwać")
- zaplanowane wydarzenie w firmie, po którym klient chce wrócić do tematu ("po wyjeździe", "po decyzji zarządu", "za 2-3 miesiące wrócimy do tematu")
- klient odłożył temat z intencją powrotu ("temat odłożony w czasie", "wrócimy gdy...")
- jakakolwiek inna wzmianka o kontynuacji rozmowy w przyszłości

Pole "follow_up_date_hint" ustaw na krótką frazę opisującą KIEDY nastąpi kolejny kontakt. Data rozmowy jest podana w notatkach jako [CALL_DATE:RRRR-MM-DD] — traktuj ją jako "dziś" przy wyliczaniu terminów względnych. Ważne zasady:
1. SKANUJ OD KOŃCA ROZMOWY WSTECZ — znajdź ostatnią wypowiedź zawierającą ustalenie terminu (kiedy zadzwonić, kiedy się spotkać, kiedy wrócić do tematu). Ta fraza jest wiążąca. Grzecznościowe zakończenia rozmowy ("dziękuję", "do widzenia", "pozdrawiam") nie są frazami terminowymi i należy je pominąć. Wcześniejsze propozycje terminów, które zostały odrzucone lub zastąpione przez późniejsze, są nieważne.
2. Szukaj ostatecznego porozumienia: ostatnie słowo klienta LUB ostatnie potwierdzenie handlowca ("dobrze, to za dwa tygodnie", "umówmy się na koniec miesiąca") to wynik końcowy.
3. Jeśli w rozmowie pada sekwencja negocjacji (np. handlowiec: "przyszły tydzień" → klient: "nie mogę, proszę o dwa tygodnie" → brak odpowiedzi), bierz ostatni niezanegowany termin — tutaj "za dwa tygodnie".
4. Wyraź termin w ustandaryzowanej formie "za X [dni/tygodnie/miesiące]" gdy tylko możliwe. Przykłady przekształceń: "proszę o dwa tygodnie" → "za dwa tygodnie", "po dwóch tygodniach" → "za dwa tygodnie", "nie w przyszłym tygodniu, pod koniec miesiąca" → "koniec miesiąca". WYJĄTEK: gdy pada KONKRETNY DZIEŃ MIESIĄCA ("do 25-tego", "na 25.", "dwudziestego piątego") — zwróć go jako "DD <nazwa miesiąca w dopełniaczu>", np. "25 września". Miesiąc wybierz względem [CALL_DATE]: jeśli podany dzień już minął w bieżącym miesiącu, weź następny miesiąc. Konkretny dzień ma pierwszeństwo przed formą "za X tygodni".
5. Zachowaj liczbę słowem gdy klient tak powiedział: "dwa tygodnie" → "za dwa tygodnie" (nie "za 2 tygodnie").
6. Dla określeń okresu TYGODNIA użyj form kanonicznych: "na początku tygodnia" (poniedziałek), "połowa tygodnia" (środa), "koniec tygodnia" (piątek). Wariacje: "pod koniec tygodnia", "z końcem tygodnia", "w okolicy końca tygodnia" → "koniec tygodnia"; "z początkiem tygodnia", "w okolicy początku tygodnia" → "na początku tygodnia". Dla przyszłego tygodnia dodaj "przyszłego tygodnia" (np. "koniec przyszłego tygodnia"). Dla POŁOWY MIESIĄCA: "pierwsza połowa miesiąca" = przełom 1. i 2. tygodnia; "druga połowa miesiąca" = zaczyna się po 15. (od dnia 16). Wariacje: "w pierwszej połowie miesiąca" → "pierwsza połowa miesiąca", "w drugiej połowie miesiąca" → "druga połowa miesiąca". Gdy podano KONKRETNĄ NAZWĘ MIESIĄCA zamiast "miesiąca": "w drugiej połowie września" → "druga połowa września", "w pierwszej połowie marca" → "pierwsza połowa marca". Dodaj "przyszłego miesiąca" gdy mowa o następnym miesiącu. "Z końcem miesiąca" / "w okolicy końca miesiąca" / "pod koniec miesiąca" → "koniec miesiąca" (oznacza ostatnie dni miesiąca, 2 dni robocze przed końcem).
Przykłady wyników: "za 2 tygodnie", "za dwa tygodnie", "w piątek", "25 września", "10 października", "koniec miesiąca", "koniec tygodnia", "połowa tygodnia", "na początku tygodnia", "pod koniec tygodnia", "z końcem tygodnia", "w marcu", "za 3 miesiące", "przyszły tydzień", "na początku przyszłego miesiąca", "połowa miesiąca", "połowa przyszłego miesiąca", "pierwsza połowa miesiąca", "pierwsza połowa przyszłego miesiąca", "druga połowa miesiąca", "druga połowa przyszłego miesiąca".
Ustaw null gdy follow_up_required=false lub gdy brak jakiejkolwiek wzmianki o terminie.

Zwróć WYŁĄCZNIE poprawny obiekt JSON w dokładnie takim formacie (bez markdown, bez tekstu przed/po):
{"score":<liczba całkowita 0-100>,"summary":"<2-3 zdania po polsku: postawa firmy, kluczowe sygnały, rekomendowane następne kroki>","signals":["<pozytywny sygnał 1>","<pozytywny sygnał 2>"],"objections":["<obiekcja 1>","<obiekcja 2>"],"follow_up_required":<true|false>,"follow_up_date_hint":<"krótka fraza"|null>}`;

let batchRunning = false;
let batchProgress = { total: 0, done: 0, errors: 0, running: false };

// ── Date helpers ───────────────────────────────────────────────────

function nextBusinessDay(date) {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function addBusinessDays(date, n) {
  let d = new Date(date);
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count++;
  }
  return d;
}

// Formatuje datę wg lokalnych składowych (getFullYear/getMonth/getDate), spójnie
// z resztą tego pliku, która liczy na lokalnym czasie (setDate/getDay/setHours).
// d.toISOString() konwertuje do UTC — na serwerze w Europe/Warsaw (UTC+1/+2)
// to zawsze cofa północ lokalną o dzień wstecz (np. lokalna 2.09 00:00 →
// UTC 1.09 22:00 → obcięte do "2026-09-01" zamiast "2026-09-02").
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function subBusinessDays(date, n) {
  let d = new Date(date);
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count++;
  }
  return d;
}

function lastBusinessDayOfMonth(year, month) {
  // day 0 of next month = last day of this month
  const d = new Date(year, month + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

// Zwraca indeks miesiąca (0=styczeń) na podstawie polskiej nazwy miesiąca w hincie, lub -1
function findMonthIndex(h) {
  const monthPatterns = [
    [/stycz[eę][nń]/, 0], [/lut[ey]/, 1], [/marc/, 2], [/kwiet/, 3],
    [/maj[ua]?/, 4], [/czerw/, 5], [/lipi/, 6], [/sierp/, 7],
    [/wrze[sś]/, 8], [/pa[zź]dzier/, 9], [/listop/, 10], [/grudz/, 11],
  ];
  for (const [pat, idx] of monthPatterns) {
    if (pat.test(h)) return idx;
  }
  return -1;
}

// ── Follow-up date computation from AI hint ────────────────────────
// Reguły:
//   "[za/o] X dni"          → today + X dni kalendarzowych
//   "[za/o] X tygodni"      → today + X*7 dni  (X może być cyfrą lub słowem: dwa, trzy…)
//   "[za/o] X miesięcy"     → today + X miesięcy
//   "przyszły tydzień" (bez kwalifikatora) → today + 4 dni robocze
//   "na początku tygodnia"  → najbliższy poniedziałek
//   "na początku miesiąca"  → 3. dnia następnego miesiąca
//   "środek miesiąca"       → 15. tego/następnego miesiąca
//   "koniec miesiąca"       → 29. tego/następnego miesiąca
//   nazwa dnia tygodnia     → najbliższe wystąpienie (ten/następny tydzień)
//   nazwa miesiąca          → 3. dzień następnego wystąpienia
//   konkretna data DD.MM    → dokładna data (następna jeśli przeszła)
//   Wynik: zawsze na dzień roboczy; null jeśli nie rozpoznano

// Polskie liczebniki słowne → cyfry (znormalizowane bez ogonków)
const POLISH_NUM = {
  jeden:1, jedna:1, jedno:1,
  dwa:2, dwie:2,
  trzy:3,
  cztery:4,
  piec:5,        // pięć
  szesc:6,       // sześć
  siedem:7,
  osiem:8,
  dziewiec:9,    // dziewięć
  dziesiec:10,   // dziesięć
  kilka:3,       // kilka → przyjmujemy min.
};

function stripDiacritics(s) {
  return s
    .replace(/ą/g,'a').replace(/ę/g,'e').replace(/ó/g,'o')
    .replace(/ś/g,'s').replace(/ł/g,'l').replace(/ż/g,'z')
    .replace(/ź/g,'z').replace(/ć/g,'c').replace(/ń/g,'n');
}

function parsePolishNum(token) {
  if (!token) return null;
  const n = parseInt(token, 10);
  if (!isNaN(n)) return n;
  return POLISH_NUM[stripDiacritics(token.toLowerCase())] ?? null;
}

// Wzorzec liczby: cyfra lub liczebnik słowny
const NUM_PAT = '(\\d+|jeden|jedna|dwa|dwie|trzy|cztery|pi[eę][cć]|sze[sś][cć]|siedem|osiem|dziewi[eę][cć]|dziesi[eę][cć]|kilka)';
// Opcjonalny prefiks: "za", "o", "po" (proszę za / proszę o / za)
const PRE = '(?:za|o|po)\\s+';

// Nazwy dni tygodnia → numer dnia (1=pon … 5=pt). Kolejność bez znaczenia,
// dopasowanie po fragmencie. Współdzielone przez gałąź "dzień + kwalifikator
// tygodnia" i przez pętlę "sama nazwa dnia" niżej.
const DAY_NAMES = [
  ['poniedzia', 1],
  ['wtorek', 2], ['wt\\.', 2],
  ['[śs]rod', 3],
  ['czwartek', 4], ['czwartku', 4],
  ['pi[aą]tek', 5], ['pi[aą]tku', 5],
];

function computeFollowUpDate(hint, today = new Date()) {
  if (!hint || typeof hint !== 'string') return null;
  const h = hint.toLowerCase().trim();

  const todayDate = new Date(today);
  todayDate.setHours(0, 0, 0, 0);

  let m;

  // Jutro / dzisiaj / pojutrze — brakowało tego w worktrips (fallback tam
  // lądował na "5 dni roboczych od rozmowy" zamiast realnie bliskiego terminu,
  // np. "jutro" dawało follow-up za tydzień zamiast następnego dnia).
  // Granice słowa przez \p{L} (Unicode), nie \b — zwykłe \b w JS opiera się na
  // \w (tylko ASCII), więc łamie się na polskich znakach z ogonkiem: \b tuż
  // po "ś" w "dziś" nigdy nie domykał granicy i cały wzorzec nie łapał.
  if (/(?<![\p{L}\p{N}_])pojutrze(?![\p{L}\p{N}_])/u.test(h)) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + 2);
    return toDateStr(nextBusinessDay(d));
  }
  if (/(?<![\p{L}\p{N}_])jutro(?![\p{L}\p{N}_])/u.test(h)) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + 1);
    return toDateStr(nextBusinessDay(d));
  }
  if (/(?<![\p{L}\p{N}_])(dzisiaj|dziś)(?![\p{L}\p{N}_])/u.test(h)) {
    return toDateStr(nextBusinessDay(todayDate));
  }

  // Konkretna data DD.MM lub DD.MM.YYYY (sprawdź na początku)
  m = h.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?!\d)/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      const year = m[3] ? parseInt(m[3], 10) : todayDate.getFullYear();
      let target = new Date(year, mon - 1, day);
      if (target <= todayDate) target.setFullYear(target.getFullYear() + 1);
      return toDateStr(nextBusinessDay(target));
    }
  }

  // Za/o X dni — cyfrą lub słowem
  m = h.match(new RegExp(`(?:${PRE})?${NUM_PAT}\\s+dni`));
  if (m) {
    const n = parsePolishNum(m[1]);
    if (n) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() + n);
      return toDateStr(nextBusinessDay(d));
    }
  }

  // Nazwa dnia + kwalifikator tygodnia ("za tydzień w czwartek", "za 2 tygodnie
  // we wtorek", "w przyszły czwartek", "następny piątek") → ten dzień w tygodniu
  // przesuniętym o wskazaną liczbę tygodni. MUSI być przed gałęzią "za X
  // tygodni" (inaczej łapie sam offset i gubi dzień) oraz przed pętlą samych
  // nazw dni (która ignoruje "przyszły"/"za tydzień").
  const dayHit = DAY_NAMES.find(([pat]) => new RegExp(pat).test(h));
  if (dayHit) {
    let weekShift = null;
    const wm = h.match(new RegExp(`(?:${PRE})?${NUM_PAT}\\s+tygodni`));
    if (wm)                                      weekShift = parsePolishNum(wm[1]) ?? 1;
    else if (/(?:za|o|po)\s+tydzień/.test(h))    weekShift = 1;
    else if (/przyszł|następn/.test(h))          weekShift = 1;

    if (weekShift !== null) {
      const dow = dayHit[1]; // 1=pon … 5=pt
      const monday = new Date(todayDate);
      const back = monday.getDay() === 0 ? 6 : monday.getDay() - 1; // do poniedziałku bieżącego tygodnia
      monday.setDate(monday.getDate() - back + weekShift * 7);
      monday.setDate(monday.getDate() + (dow - 1));
      return toDateStr(monday);
    }
  }

  // Za/o X tygodni / tydzień — cyfrą lub słowem; prefiks opcjonalny dla plural, wymagany dla singular
  // (singular bez prefiksu mógłby maczować "przyszły tydzień" → błędne +7 dni zamiast +4 robocze)
  m = h.match(new RegExp(`(?:${PRE})?${NUM_PAT}\\s+tygodni`));
  if (!m) m = h.match(/(?:za|o|po)\s+tydzień/);
  if (m) {
    const n = parsePolishNum(m[1]) ?? 1;
    const d = new Date(todayDate);
    d.setDate(d.getDate() + n * 7);
    return toDateStr(nextBusinessDay(d));
  }

  // Pierwsza połowa [konkretna nazwa miesiąca] → 3. dzień roboczy miesiąca
  // Musi być PRZED "pierwsza połowa miesiąca" bo też dopasowuje /pierwsz\w+\s+połow\w+/
  if (/pierwsz\w+\s+połow\w+/.test(h)) {
    const monIdx = findMonthIndex(h);
    if (monIdx >= 0) {
      const d = new Date(todayDate);
      let year = d.getFullYear();
      // Jeśli miesiąc już minął lub jesteśmy po 7., szukaj przyszłego roku
      if (monIdx < d.getMonth() || (monIdx === d.getMonth() && d.getDate() > 7)) year++;
      return toDateStr(addBusinessDays(new Date(year, monIdx, 1), 2));
    }
  }

  // Pierwsza połowa miesiąca → 3. dzień roboczy (musi być PRZED "połowa miesiąca")
  if (/pierwsz\w+\s+połow\w+/.test(h) && /miesiąc/.test(h)) {
    const hasNextM1 = /(przyszłego|następnego)/.test(h);
    const d = new Date(todayDate);
    const target = new Date(d.getFullYear(), d.getMonth() + (hasNextM1 ? 1 : 0), 1);
    if (!hasNextM1 && new Date(d.getFullYear(), d.getMonth(), 7) <= todayDate) target.setMonth(target.getMonth() + 1);
    return toDateStr(addBusinessDays(target, 2));
  }

  // Druga połowa [konkretna nazwa miesiąca] → addBusinessDays(15. dnia, 2)
  // "w drugiej połowie września" → 17.09 (Sep 15 +2 dni robocze)
  // Musi być PRZED "druga połowa miesiąca"
  if (/drug\w+\s+połow\w+/.test(h)) {
    const monIdx = findMonthIndex(h);
    if (monIdx >= 0) {
      const d = new Date(todayDate);
      let year = d.getFullYear();
      if (monIdx < d.getMonth() || (monIdx === d.getMonth() && d.getDate() > 20)) year++;
      return toDateStr(addBusinessDays(new Date(year, monIdx, 15), 2));
    }
  }

  // Druga połowa miesiąca → addBusinessDays(15., 2) (musi być PRZED "połowa miesiąca")
  if (/drug\w+\s+połow\w+/.test(h) && /miesiąc/.test(h)) {
    const hasNextM2 = /(przyszłego|następnego)/.test(h);
    const d = new Date(todayDate);
    const target = new Date(d.getFullYear(), d.getMonth() + (hasNextM2 ? 1 : 0), 15);
    if (!hasNextM2 && target <= todayDate) target.setMonth(target.getMonth() + 1);
    return toDateStr(addBusinessDays(target, 2));
  }

  // Połowa / środek miesiąca (opcjonalnie: przyszłego/następnego) → 15.
  // MUSI być przed catch-allem "miesiąc" bo "połowa przyszłego miesiąca" zawiera słowo "miesiąca"
  if (/po[łl]ow[aię]\s*(przyszłego|następnego)?\s*miesiąca|środek?\s*(przyszłego|następnego)?\s*miesiąca|[śs]rodk[ui]\s*(przyszłego|następnego)?\s*miesiąca/.test(h)) {
    const hasNext = /(przyszłego|następnego)/.test(h);
    const d = new Date(todayDate);
    const target = new Date(d.getFullYear(), d.getMonth() + (hasNext ? 1 : 0), 15);
    if (!hasNext && target <= todayDate) target.setMonth(target.getMonth() + 1);
    return toDateStr(nextBusinessDay(target));
  }

  // Za/o X miesięcy / miesiąc — cyfrą lub słowem.
  // Dla samego "miesiąc" prefiks za/o/po jest WYMAGANY (inaczej "koniec miesiąca" byłoby tu łapane).
  m = h.match(new RegExp(`(?:${PRE})?${NUM_PAT}\\s+miesi`));
  if (!m) m = h.match(/\b(?:za|o|po)\s+miesiąc/);
  if (m) {
    const n = parsePolishNum(m[1]) ?? 1;
    const d = new Date(todayDate);
    d.setMonth(d.getMonth() + n);
    return toDateStr(nextBusinessDay(d));
  }

  // Zakres: "2-3 miesiące", "kilka miesięcy" → górna granica
  m = h.match(/\d+[-–]\s*(\d+)\s+miesi/);
  if (m) {
    const d = new Date(todayDate);
    d.setMonth(d.getMonth() + parseInt(m[1], 10));
    return toDateStr(nextBusinessDay(d));
  }

  // Na początku / z początkiem / w okolicy początku tygodnia → następny poniedziałek
  if (/pocz[aą]tku?\s*(przyszłego|następnego)?\s*tygodnia|pocz[aą]tkiem\s*(przyszłego|następnego)?\s*tygodnia|na\s*pocz[aą]tku\s*tygodnia|w\s*okolicy\s*pocz[aą]tku\s*(przyszłego|następnego)?\s*tygodnia|z\s*pocz[aą]tkiem\s*(przyszłego|następnego)?\s*tygodnia/.test(h)) {
    const d = new Date(todayDate);
    const dow = d.getDay(); // 0=Sun,1=Mon,...6=Sat
    const daysToMon = dow === 1 ? 7 : (8 - dow) % 7 || 7;
    d.setDate(d.getDate() + daysToMon);
    return toDateStr(d); // poniedziałek = dzień roboczy
  }

  // Koniec / pod koniec / z końcem / w okolicy końca tygodnia → najbliższy piątek
  if (/koniec?\s*(tego\s*|przyszłego\s*|następnego\s*)?tygodnia|ko[ńn]cem\s*(przyszłego\s*|następnego\s*)?tygodnia|pod\s*koniec\s*(tego\s*|przyszłego\s*|następnego\s*)?tygodnia|w\s*okolicy\s*ko[ńn]ca\s*(przyszłego\s*|następnego\s*)?tygodnia|z\s*ko[ńn]cem\s*(przyszłego\s*|następnego\s*)?tygodnia/.test(h)) {
    const hasNextW1 = /(przyszłego|następnego)\s*tygodnia|przyszłym\s*tygodniu|następnym\s*tygodniu/.test(h);
    const d = new Date(todayDate);
    const dow = d.getDay();
    let daysToFri = (5 - dow + 7) % 7;
    if (daysToFri === 0) daysToFri = 7;
    if (hasNextW1) daysToFri += 7;
    d.setDate(d.getDate() + daysToFri);
    return toDateStr(d);
  }

  // Połowa / środek tygodnia → najbliższa środa
  if (/po[łl]ow[aię]\s*(przyszłego\s*|następnego\s*)?tygodnia|[śs]rodek?\s*(przyszłego\s*|następnego\s*)?tygodnia|[śs]rodk[ui]\s*(przyszłego\s*|następnego\s*)?tygodnia/.test(h)) {
    const hasNextW2 = /(przyszłego|następnego)\s*tygodnia|przyszłym\s*tygodniu|następnym\s*tygodniu/.test(h);
    const d = new Date(todayDate);
    const dow = d.getDay();
    let daysToWed = (3 - dow + 7) % 7;
    if (daysToWed === 0) daysToWed = 7;
    if (hasNextW2) daysToWed += 7;
    d.setDate(d.getDate() + daysToWed);
    return toDateStr(d);
  }

  // Przyszły tydzień / następny tydzień (bez kwalifikatora "początku") → today + 4 dni robocze
  if (/przyszły\s*tydzień|przyszłym\s*tygodniu|następny\s*tydzień|następnym\s*tygodniu|przyszłego\s*tygodnia|następnego\s*tygodnia/.test(h)) {
    return toDateStr(addBusinessDays(todayDate, 4));
  }

  // Na początku / z początkiem / w okolicy początku miesiąca → 3. następnego miesiąca
  if (/pocz[aą]tku?\s*(przyszłego|następnego)?\s*miesiąca|pocz[aą]tkiem\s*(przyszłego|następnego)?\s*miesiąca|pierwsz\w+\s+dni\w*\s+miesiąca|w\s*okolicy\s*pocz[aą]tku\s*(przyszłego|następnego)?\s*miesiąca|z\s*pocz[aą]tkiem\s*(przyszłego|następnego)?\s*miesiąca/.test(h)) {
    const d = new Date(todayDate);
    d.setMonth(d.getMonth() + 1, 3);
    return toDateStr(nextBusinessDay(d));
  }

  // W przyszłym miesiącu (bez kwalifikatora "początku") → 3. następnego miesiąca
  if (/przyszłym\s*miesiącu|następnym\s*miesiącu|przyszły\s*miesiąc/.test(h)) {
    const d = new Date(todayDate);
    d.setMonth(d.getMonth() + 1, 3);
    return toDateStr(nextBusinessDay(d));
  }

  // Koniec / pod koniec / z końcem / w okolicy końca miesiąca → 2 dni robocze przed ostatnim dniem roboczym miesiąca
  // np. "pod koniec sierpnia" (31-pon) → lastBD=31, subBD(2)=27 (czw)
  if (/koniec?\s*(tego\s*|przyszłego\s*|następnego\s*)?miesiąca|ko[ńn]cem\s*(przyszłego\s*|następnego\s*)?miesiąca|pod\s*koniec\s*(przyszłego\s*|następnego\s*)?miesiąca|w\s*okolicy\s*ko[ńn]ca\s*(przyszłego\s*|następnego\s*)?miesiąca|z\s*ko[ńn]cem\s*(przyszłego\s*|następnego\s*)?miesiąca/.test(h)) {
    const hasNextM3 = /(przyszłego|następnego)\s*miesiąca/.test(h);
    const d = new Date(todayDate);
    let targetMon = d.getMonth() + (hasNextM3 ? 1 : 0);
    let targetYear = d.getFullYear() + (targetMon > 11 ? 1 : 0);
    targetMon = targetMon % 12;
    let lastBD = lastBusinessDayOfMonth(targetYear, targetMon);
    // Jeśli wynikowa data jest w przeszłości (względem ref date) — przesuń do kolejnego miesiąca
    if (!hasNextM3 && subBusinessDays(lastBD, 2) <= todayDate) {
      const nm = (targetMon + 1) % 12;
      const ny = targetMon === 11 ? targetYear + 1 : targetYear;
      lastBD = lastBusinessDayOfMonth(ny, nm);
    }
    return toDateStr(subBusinessDays(lastBD, 2));
  }

  // Sama nazwa dnia (bez kwalifikatora tygodnia — ten przypadek obsłużony wyżej)
  // → najbliższe wystąpienie (jeśli dziś = ten dzień, następny tydzień)
  for (const [pat, dow] of DAY_NAMES) {
    if (new RegExp(pat).test(h)) {
      const d = new Date(todayDate);
      const currentDow = d.getDay();
      let daysUntil = (dow - currentDow + 7) % 7;
      if (daysUntil === 0) daysUntil = 7; // ten sam dzień → następny tydzień
      d.setDate(d.getDate() + daysUntil);
      return toDateStr(d);
    }
  }

  const monthNames = [
    [/stycz[eń]n?/, 1], [/lut[ey]/, 2], [/marc/, 3], [/kwiet/, 4],
    [/maj/, 5], [/czerw/, 6], [/lipi/, 7], [/sierp/, 8],
    [/wrze[sś]/, 9], [/pa[zź]dzier/, 10], [/listop/, 11], [/grudz/, 12],
  ];

  // Konkretny dzień + nazwa miesiąca słownie ("27 września") — MUSI być przed
  // samą "nazwą miesiąca" niżej, bo ta łapałaby też ten przypadek i gubiła
  // podany dzień, lądując zawsze na 3. dniu miesiąca (realny bug, worktrips
  // nigdy nie miał gałęzi na dzień+miesiąc słownie, tylko DD.MM cyfrowo albo
  // sam miesiąc bez dnia).
  m = h.match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthWord = m[2];
    const monthMatch = monthNames.find(([pat]) => pat.test(monthWord));
    if (monthMatch && day >= 1 && day <= 31) {
      const mon = monthMatch[1];
      let year = todayDate.getFullYear();
      let target = new Date(year, mon - 1, day);
      if (target <= todayDate) target.setFullYear(target.getFullYear() + 1);
      return toDateStr(nextBusinessDay(target));
    }
  }

  // Nazwy miesięcy → 3. dzień następnego wystąpienia tego miesiąca
  for (const [pat, mon] of monthNames) {
    if (pat.test(h)) {
      const d = new Date(todayDate);
      let year = d.getFullYear();
      // Jeśli ten miesiąc już minął lub jesteśmy po 3. → następny rok
      if (mon < d.getMonth() + 1 || (mon === d.getMonth() + 1 && d.getDate() > 3)) {
        year++;
      }
      const target = new Date(year, mon - 1, 3);
      return toDateStr(nextBusinessDay(target));
    }
  }

  return null; // nie rozpoznano
}

// ── Activity creation on Lead/Partner ─────────────────────────────
// Notatka bez daty/statusu/przypomnienia — świadome odejście od worktrips
// (tam to zawsze zadanie z terminem, przypisaniem, priorytetem). Zmiana na
// żądanie Angeliki/Adama (mail 26.08): AI-wygenerowane podsumowanie ma nie
// zaśmiecać kalendarza/listy zadań, tylko być widoczne jako kontekst na
// leadzie/partnerze. Sugerowany termin, który AI wykrył, zostaje w treści
// notatki — nic go już automatycznie nie przypomina. Mechanizm przypomnień
// (migracja 0277, crmReminderService.js, jobs/crm-reminders.js, próg 3 dni
// at_due/1d_before) zostaje NIETKNIĘTY i dalej działa dla zadań tworzonych
// ręcznie przez usera w UI (dropdown Przypomnienie na karcie leada/partnera).

async function createAnalysisNote(tenantId, nip, followUpDate, salespersonId, summary) {
  try {
    const digits = String(nip).replace(/\D/g, '');
    if (!digits || digits.length !== 10) return;

    // Partner ma priorytet (konwersja z Leada → Lead jest rekordem historycznym).
    // tenant_id filtrowany wprost (nie tylko odczytany) — inaczej ten sam NIP
    // mógłby trafić na leada/partnera z INNEGO tenanta.
    const { rows: partnerRows } = await db.query(
      `SELECT id FROM crm_partners
       WHERE REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = $1 AND nip IS NOT NULL AND tenant_id = $2
       LIMIT 1`,
      [digits, tenantId]
    );

    const title = 'Podsumowanie rozmowy (AI)';
    const body  = summary
      ? `${summary}\n\nSugerowany termin kontaktu: ${followUpDate}`
      : `Sugerowany termin kontaktu: ${followUpDate}`;

    if (partnerRows.length) {
      await db.query(
        `INSERT INTO crm_partner_activities
           (partner_id, tenant_id, type, title, body, created_by, assigned_to, call_analysis_nip)
         VALUES ($1, $2, 'note', $3, $4, $5::uuid, $5::uuid, $6)`,
        [partnerRows[0].id, tenantId, title, body, salespersonId ?? null, digits]
      );
      logger.info('[CallAnalysis] Analysis note created on partner', { tenantId, nip: digits, followUpDate, partnerId: partnerRows[0].id });
      return;
    }

    const { rows: leadRows } = await db.query(
      `SELECT id FROM crm_leads
       WHERE REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = $1 AND nip IS NOT NULL AND tenant_id = $2
       LIMIT 1`,
      [digits, tenantId]
    );

    if (leadRows.length) {
      await db.query(
        `INSERT INTO crm_lead_activities
           (lead_id, tenant_id, type, title, body, created_by, assigned_to, call_analysis_nip)
         VALUES ($1, $2, 'note', $3, $4, $5::uuid, $5::uuid, $6)`,
        [leadRows[0].id, tenantId, title, body, salespersonId ?? null, digits]
      );
      logger.info('[CallAnalysis] Analysis note created on lead', { tenantId, nip: digits, followUpDate, leadId: leadRows[0].id });
    }
  } catch (err) {
    logger.warn('[CallAnalysis] createAnalysisNote error', { nip, error: err.message });
  }
}

// ── DeepSeek call ──────────────────────────────────────────────────

async function callDeepSeek(notesText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const userMessage =
    'Przeanalizuj poniższe notatki z rozmów telefonicznych z potencjalnym klientem ' +
    'i oceń jego skłonność do zakupu usług CRM:\n\n' +
    notesText;

  const { data } = await axios.post(
    DEEPSEEK_API,
    {
      model:       DEEPSEEK_MODEL,
      max_tokens:  1000,
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
      timeout: 30_000,
    }
  );

  return data?.choices?.[0]?.message?.content || '{}';
}

// ── Analiza pojedynczego NIP ───────────────────────────────────────

async function analyzeOne(tenantId, nip) {
  try {
    await db.query(
      `UPDATE call_analysis_companies SET analysis_status = 'analyzing', updated_at = NOW() WHERE tenant_id = $1 AND nip = $2`,
      [tenantId, nip]
    );

    const { rows } = await db.query(
      `SELECT notes_text, salesperson_id, salesperson_name, last_call_date FROM call_analysis_companies WHERE tenant_id = $1 AND nip = $2`,
      [tenantId, nip]
    );

    if (!rows.length || !rows[0].notes_text?.trim()) {
      await db.query(
        `UPDATE call_analysis_companies SET analysis_status = 'error', analysis_error = 'Brak tekstu notatek', updated_at = NOW() WHERE tenant_id = $1 AND nip = $2`,
        [tenantId, nip]
      );
      return { status: 'error' };
    }

    const { notes_text, salesperson_id, last_call_date } = rows[0];
    // Punkt odniesienia dla dat: data ostatniej rozmowy (jeśli znana), w p.p. dziś.
    // Dzięki temu "pod koniec sierpnia" z rozmowy 11.08 → 27.08, nie data analizy.
    const refDate = last_call_date ? new Date(last_call_date) : new Date();
    const raw = await callDeepSeek(notes_text);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed || typeof parsed.score !== 'number') {
      logger.warn('[CallAnalysis] Unexpected AI response', { nip, raw: raw.slice(0, 200) });
      await db.query(
        `UPDATE call_analysis_companies SET analysis_status = 'error', analysis_error = 'Nieprawidłowa odpowiedź AI', updated_at = NOW() WHERE tenant_id = $1 AND nip = $2`,
        [tenantId, nip]
      );
      return { status: 'error' };
    }

    const score     = Math.max(0, Math.min(100, Math.round(parsed.score)));
    const followUp  = parsed.follow_up_required === true;
    const dateHint  = parsed.follow_up_date_hint || null;

    // Oblicz datę follow-up używając daty ostatniej rozmowy jako punktu odniesienia.
    // Fallback 5 dni roboczych gdy follow_up_required=true, ale albo AI nie dał
    // hinta (np. rozmowa mówi "wyślę ofertę dzisiaj" — to zobowiązanie do
    // wysłania czegoś, nie do oddzwonienia w konkretnym terminie, więc AI
    // słusznie zostawia hint=null), albo hint był ale się nie sparsował.
    // Bez tego fallbacku follow_up_required=true z hint=null nigdy nie tworzył
    // żadnego zadania — cichy, niewidoczny błąd (AI mówi "to wymaga
    // follow-upu", a nic się nie dzieje).
    let followUpDate = null;
    if (followUp) {
      followUpDate = computeFollowUpDate(dateHint, refDate);
      if (!followUpDate) {
        followUpDate = toDateStr(addBusinessDays(refDate, 5));
      }
    }

    // Zapisz wynik tylko jeśli notes_text nie zmienił się od momentu, gdy
    // zaczęliśmy tę analizę (DeepSeek trwa kilka sekund — w tym oknie mogła
    // dojść nowa notatka z upsert-from-call). Bez tego "done" nadpisałoby
    // status ustawiony przez nowszy upsert, gubiąc informację, że świeża
    // notatka nigdy nie została faktycznie przeanalizowana.
    const { rowCount } = await db.query(
      `UPDATE call_analysis_companies SET
         score              = $3,
         ai_summary         = $4,
         ai_signals         = $5::jsonb,
         ai_objections      = $6::jsonb,
         follow_up_required = $7,
         follow_up_date     = $8,
         analysis_status    = 'done',
         analysis_error     = NULL,
         analyzed_at        = NOW(),
         updated_at         = NOW()
       WHERE tenant_id = $1 AND nip = $2 AND notes_text = $9`,
      [
        tenantId,
        nip,
        score,
        parsed.summary || null,
        JSON.stringify(Array.isArray(parsed.signals)    ? parsed.signals    : []),
        JSON.stringify(Array.isArray(parsed.objections) ? parsed.objections : []),
        followUp,
        followUpDate,
        notes_text,
      ]
    );

    if (rowCount === 0) {
      logger.info('[CallAnalysis] Notes changed during analysis, discarding stale result', { tenantId, nip });
      await db.query(
        `UPDATE call_analysis_companies SET analysis_status = 'pending', updated_at = NOW()
         WHERE tenant_id = $1 AND nip = $2 AND analysis_status = 'analyzing'`,
        [tenantId, nip]
      );
      return { status: 'stale' };
    }

    // Utwórz notatkę z podsumowaniem AI na Lead/Partner (jeśli jest data i istnieje encja)
    if (followUpDate) {
      await createAnalysisNote(tenantId, nip, followUpDate, salesperson_id, parsed.summary || null);
    }

    logger.info('[CallAnalysis] Done', { tenantId, nip, score, followUpDate });
    return { status: 'done' };
  } catch (err) {
    logger.warn('[CallAnalysis] analyzeOne error', { nip, error: err.message });
    await db.query(
      `UPDATE call_analysis_companies SET analysis_status = 'error', analysis_error = $3, updated_at = NOW() WHERE tenant_id = $1 AND nip = $2`,
      [tenantId, nip, String(err.message).slice(0, 500)]
    ).catch(() => {});
    return { status: 'error' };
  }
}

// ── Batch ──────────────────────────────────────────────────────────

// batchRunning/batchProgress are process-wide (not per-tenant) — a batch
// triggered by one tenant briefly locks out others from starting their own
// (isBatchRunning() blocks a second start) until it finishes. Not a security
// issue (the SELECT below is tenant-scoped, no cross-tenant data touched),
// just a "wait your turn" UX limit — acceptable for now, not worth a bigger
// per-tenant progress-tracking refactor yet.
async function runBatch(tenantId) {
  if (batchRunning) return { alreadyRunning: true };
  batchRunning = true;

  try {
    const { rows } = await db.query(
      `SELECT nip FROM call_analysis_companies
       WHERE tenant_id = $1 AND analysis_status IN ('pending', 'error')
       ORDER BY imported_at ASC`,
      [tenantId]
    );

    const nips = rows.map(r => r.nip);
    batchProgress = { total: nips.length, done: 0, errors: 0, running: true };

    if (!nips.length) return batchProgress;

    let idx = 0;
    const worker = async () => {
      while (idx < nips.length) {
        const nip = nips[idx++];
        const result = await analyzeOne(tenantId, nip);
        if (result?.status === 'error') batchProgress.errors++;
        else batchProgress.done++;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, nips.length) }, () => worker())
    );
  } finally {
    batchRunning = false;
    batchProgress.running = false;
  }

  return batchProgress;
}

function getBatchProgress() {
  return batchProgress;
}

function isBatchRunning() {
  return batchRunning;
}

function getSystemPrompt() { return SYSTEM_PROMPT; }

module.exports = { runBatch, getBatchProgress, isBatchRunning, analyzeOne, getSystemPrompt, computeFollowUpDate };
