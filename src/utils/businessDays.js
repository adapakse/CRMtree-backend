'use strict';
// src/utils/businessDays.js
//
// Polski kalendarz dni roboczych: sobota, niedziela oraz dni ustawowo wolne od
// pracy (stałe + ruchome zależne od Wielkanocy). Operuje na łańcuchach
// 'YYYY-MM-DD' (data lokalna Warsaw, jak todayWarsaw() w digestService).
// Cała arytmetyka w UTC — łańcuch daty nie ma pory dnia, więc DST nie gra roli.
//
// Port 1:1 z worktrips-doc (src/utils/businessDays.js). Kalendarz jest POLSKI i
// wspólny dla wszystkich tenantów — dzienny raport wychodzi o 09:00 czasu
// Europe/Warsaw niezależnie od języka odbiorcy, bo zespoły pracują w Polsce.
// Gdyby kiedyś doszedł tenant z innym kalendarzem, to jest miejsce do zmiany.

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function parseUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(dateStr, n) {
  return ymd(new Date(parseUTC(dateStr).getTime() + n * 86400000));
}

// Niedziela Wielkanocna — algorytm Gaussa/Meeusa (kalendarz gregoriański).
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mth + 114) / 31); // 3 = marzec, 4 = kwiecień
  const day = ((h + l - 7 * mth + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function polishHolidays(year) {
  const fixed = [
    [1, 1],   // Nowy Rok
    [1, 6],   // Trzech Króli
    [5, 1],   // Święto Pracy
    [5, 3],   // Święto Konstytucji 3 Maja
    [8, 15],  // Wniebowzięcie NMP
    [11, 1],  // Wszystkich Świętych
    [11, 11], // Święto Niepodległości
    [12, 25], // Boże Narodzenie
    [12, 26], // drugi dzień Bożego Narodzenia
  ].map(([m, d]) => ymd(new Date(Date.UTC(year, m - 1, d))));

  const easter = ymd(easterSunday(year));
  const movable = [
    easter,                 // Niedziela Wielkanocna
    addDays(easter, 1),     // Poniedziałek Wielkanocny
    addDays(easter, 49),    // Zielone Świątki
    addDays(easter, 60),    // Boże Ciało
  ];

  return new Set([...fixed, ...movable]);
}

const _cache = new Map();
function holidaysForYear(year) {
  if (!_cache.has(year)) _cache.set(year, polishHolidays(year));
  return _cache.get(year);
}

/** true jeśli 'YYYY-MM-DD' to dzień roboczy (pon–pt i nie dzień ustawowo wolny). */
function isBusinessDay(dateStr) {
  const d = parseUTC(dateStr);
  const dow = d.getUTCDay(); // 0 = niedziela, 6 = sobota
  if (dow === 0 || dow === 6) return false;
  return !holidaysForYear(d.getUTCFullYear()).has(dateStr);
}

/** Ostatni dzień roboczy ściśle przed podaną datą ('YYYY-MM-DD'). */
function previousBusinessDay(dateStr) {
  let cur = addDays(dateStr, -1);
  while (!isBusinessDay(cur)) cur = addDays(cur, -1);
  return cur;
}

module.exports = { isBusinessDay, previousBusinessDay, polishHolidays, addDays };
