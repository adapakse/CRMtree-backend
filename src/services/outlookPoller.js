"use strict";
// src/services/outlookPoller.js
//
// Interval-based poller replacing Gmail's Pub/Sub push for Outlook. Microsoft
// Graph's delta query is inherently pull/per-mailbox (no webhook, no
// validationToken/clientState subscription lifecycle to manage), so instead
// of one shared subscription (pubsubPoller.js) this iterates every connected
// account and asks each one, in turn, "anything new?" via
// outlookProcessor.processUserNotifications(userId).

const { pool }        = require("../config/database");
const outlookProcessor = require("./outlookProcessor");

const POLL_INTERVAL_MS = parseInt(process.env.OUTLOOK_POLL_INTERVAL_MS || "60000", 10);

let pollerTimer = null;
let polling     = false;

async function pollOnce() {
  const { rows } = await pool.query(
    "SELECT user_id FROM user_outlook_tokens WHERE refresh_token IS NOT NULL",
  );
  if (!rows.length) return;

  for (const { user_id: userId } of rows) {
    try {
      const { processed } = await outlookProcessor.processUserNotifications(userId);
      if (processed) console.log(`[OutlookPoller] user=${userId}: ${processed} nowych wiadomości`);
    } catch (err) {
      console.error(`[OutlookPoller] Błąd dla user=${userId}:`, err.message);
    }
  }
}

function start() {
  const runPoll = async () => {
    if (polling) return; // previous cycle still running — skip this tick
    polling = true;
    try {
      await pollOnce();
    } catch (err) {
      console.error("[OutlookPoller] Błąd cyklu:", err.message);
    } finally {
      polling = false;
    }
  };

  runPoll();
  pollerTimer = setInterval(runPoll, POLL_INTERVAL_MS);

  console.log(`[OutlookPoller] Uruchomiony — interwał: ${POLL_INTERVAL_MS}ms`);
}

function stop() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log("[OutlookPoller] Zatrzymany");
  }
}

module.exports = { start, stop };
