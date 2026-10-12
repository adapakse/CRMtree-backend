'use strict';
// jobs/daily-digest.js
//
// Dzienny raport zadań o 09:00 czasu Europe/Warsaw, wyłącznie w dni robocze
// (pon–pt bez polskich dni ustawowo wolnych). Port harmonogramu z worktrips-doc
// (followUpScheduler.js).
//
// DLACZEGO REKURENCYJNY setTimeout, A NIE setInterval JAK POZOSTAŁE JOBY:
// reszta jobów CRMtree chodzi co X minut i nie obchodzi ich pora dnia. Tu pora
// jest całą treścią reguły — raport ma trafić do ludzi rano, zanim zaczną
// pracę. setInterval(24h) rozjechałby się przy każdym restarcie backendu i przy
// zmianie czasu; liczenie odstępu do najbliższej 09:00 za każdym razem jest
// odporne na jedno i drugie.
//
// Zdublowanej wysyłki przy wielu replikach pilnuje dailyDigestService
// (notification_digest_runs), a nie ten plik — każda replika może spokojnie
// odpalić tick, wyśle tylko ta, która zajmie dzień.

const logger = require('../utils/logger');
const digestService = require('../services/dailyDigestService');
const { isBusinessDay } = require('../utils/businessDays');

const SEND_HOUR = 9;
const TIME_ZONE = 'Europe/Warsaw';

let timer = null;

/** Milisekundy do najbliższej 09:00 czasu Europe/Warsaw. */
function msUntilNextSendHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parseInt(parts.find((part) => part.type === type).value, 10);

  let hoursUntil = SEND_HOUR - (get('hour') + get('minute') / 60 + get('second') / 3600);
  if (hoursUntil <= 0) hoursUntil += 24; // już po 09:00 — celujemy w jutro
  return Math.round(hoursUntil * 3600 * 1000);
}

function scheduleNext() {
  const ms = msUntilNextSendHour();
  logger.info('[Digest] Kolejna wysyłka za', { minutes: Math.round(ms / 60000) });

  timer = setTimeout(async () => {
    const today = digestService.todayWarsaw();
    if (!isBusinessDay(today)) {
      logger.info('[Digest] Dzień wolny — pomijam', { today });
    } else {
      try {
        const sent = await digestService.sendDailyDigests();
        logger.info('[Digest] Zakończono', { today, sent });
      } catch (err) {
        // Job nie może się wyłożyć na stałe — kolejny dzień ma dojść do skutku.
        logger.error('[Digest] Błąd wysyłki', { error: err.message });
      }
    }
    scheduleNext();
  }, ms);

  if (typeof timer.unref === 'function') timer.unref();
}

function startDailyDigestJob() {
  if (timer) return;
  scheduleNext();
}

function stopDailyDigestJob() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { startDailyDigestJob, stopDailyDigestJob };
