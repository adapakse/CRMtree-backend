'use strict';
// src/utils/isoWeek.js
//
// Small date helpers shared between jobs/seo-calendar-scheduler.js and the
// SEObot calendar routes (routes/crm-seo.js) — both need to reason about
// "which Monday does this date belong to" using plain calendar dates (no
// time-of-day), so they agree on week boundaries without either one owning
// the other's logic.

function mondayOf(date) {
  const d = new Date(date);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { mondayOf, addDays, toDateStr };
