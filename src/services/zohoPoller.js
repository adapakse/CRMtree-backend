"use strict";
// src/services/zohoPoller.js
//
// Interval-based poller, mirrors outlookPoller.js. Zoho Mail has no push
// mechanism in this integration either (see zohoService.getNewMessages —
// manual poll via last_fetched_at, no webhook), so this iterates every
// connected account and asks each one, in turn, "anything new?" via
// zohoProcessor.processUserNotifications(userId).

const { pool }        = require("../config/database");
const zohoProcessor    = require("./zohoProcessor");

const POLL_INTERVAL_MS = parseInt(process.env.ZOHO_POLL_INTERVAL_MS || "60000", 10);

let pollerTimer = null;
let polling     = false;

async function pollOnce() {
  const { rows } = await pool.query(
    "SELECT user_id FROM user_zoho_tokens WHERE refresh_token IS NOT NULL",
  );
  if (!rows.length) return;

  for (const { user_id: userId } of rows) {
    try {
      const { processed } = await zohoProcessor.processUserNotifications(userId);
      if (processed) console.log(`[ZohoPoller] user=${userId}: ${processed} nowych wiadomości`);
    } catch (err) {
      console.error(`[ZohoPoller] Błąd dla user=${userId}:`, err.message);
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
      console.error("[ZohoPoller] Błąd cyklu:", err.message);
    } finally {
      polling = false;
    }
  };

  runPoll();
  pollerTimer = setInterval(runPoll, POLL_INTERVAL_MS);

  console.log(`[ZohoPoller] Uruchomiony — interwał: ${POLL_INTERVAL_MS}ms`);
}

function stop() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log("[ZohoPoller] Zatrzymany");
  }
}

module.exports = { start, stop };
