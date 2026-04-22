"use strict";
// src/services/pubsubPoller.js
//
// Pull-based Pub/Sub poller — zastępuje push webhook.
// Aplikacja sama odpytuje subskrypcję Pub/Sub co POLL_INTERVAL ms.
// Nie wymaga publicznego endpointu.
//
// Wymagane env:
//   GOOGLE_PUBSUB_SUBSCRIPTION  — pełna nazwa subskrypcji pull
//                                 format: projects/<project>/subscriptions/<name>
//
// Uwierzytelnienie (jedno z poniższych):
//   GOOGLE_SERVICE_ACCOUNT_JSON  — zawartość JSON service account (env secret)
//   GOOGLE_SERVICE_ACCOUNT_FILE  — ścieżka do pliku JSON service account
//   GOOGLE_APPLICATION_CREDENTIALS — standardowa zmienna ADC (jeśli żadne z powyższych)

const { PubSub }         = require("@google-cloud/pubsub");
const config             = require("../config");
const { processNotification } = require("./gmailProcessor");

const POLL_INTERVAL_MS = parseInt(process.env.PUBSUB_POLL_INTERVAL_MS || "30000", 10);
const MAX_MESSAGES     = parseInt(process.env.PUBSUB_MAX_MESSAGES     || "10",    10);

let pollerTimer = null;
let pubsubClient = null;

// ── Buduj klienta PubSub z dostępnych credentials ─────────────────────────────

function buildPubSubClient() {
  const opts = {};

  if (config.google.serviceAccountJson) {
    try {
      const sa = JSON.parse(config.google.serviceAccountJson);
      opts.projectId   = sa.project_id;
      opts.credentials = sa;
    } catch (e) {
      console.error("[PubSubPoller] Nie można sparsować GOOGLE_SERVICE_ACCOUNT_JSON:", e.message);
    }
  } else if (config.google.serviceAccountFile) {
    opts.keyFilename = config.google.serviceAccountFile;
  }
  // Bez opts — PubSub użyje GOOGLE_APPLICATION_CREDENTIALS (ADC)

  return new PubSub(opts);
}

// ── Jeden cykl pull ────────────────────────────────────────────────────────────

async function pollOnce(subscription) {
  const [messages] = await subscription.pull({ maxMessages: MAX_MESSAGES });
  if (!messages.length) return;

  console.log(`[PubSubPoller] Pobrano ${messages.length} wiadomość(i)`);

  for (const message of messages) {
    try {
      const data = JSON.parse(message.data.toString("utf8"));
      const { emailAddress, historyId } = data;

      if (emailAddress && historyId) {
        await processNotification(emailAddress, historyId);
      }

      message.ack();
    } catch (err) {
      console.error("[PubSubPoller] Błąd przetwarzania wiadomości:", err.message);
      message.nack(); // wróci do kolejki — zostanie ponowiona
    }
  }
}

// ── Start / stop pollera ───────────────────────────────────────────────────────

function start() {
  const subscriptionName = config.google.pubsubSubscription;

  if (!subscriptionName) {
    console.log("[PubSubPoller] GOOGLE_PUBSUB_SUBSCRIPTION nie ustawiony — pull wyłączony");
    return;
  }

  pubsubClient = buildPubSubClient();
  const subscription = pubsubClient.subscription(subscriptionName);

  // Pierwsze odpytanie natychmiast, potem co POLL_INTERVAL_MS
  const runPoll = async () => {
    try {
      await pollOnce(subscription);
    } catch (err) {
      console.error("[PubSubPoller] Błąd cyklu pull:", err.message);
    }
  };

  runPoll();
  pollerTimer = setInterval(runPoll, POLL_INTERVAL_MS);

  console.log(`[PubSubPoller] Uruchomiony — subskrypcja: ${subscriptionName}, interwał: ${POLL_INTERVAL_MS}ms`);
}

function stop() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log("[PubSubPoller] Zatrzymany");
  }
}

module.exports = { start, stop };
