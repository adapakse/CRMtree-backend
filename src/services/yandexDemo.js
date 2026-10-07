"use strict";
// src/services/yandexDemo.js
//
// Yandex Mail — DEMO mode. Lets a prospective customer click through the whole
// Yandex flow on the test environment (INT) before CRMtree has a real Yandex
// OAuth app and before stage 2 (IMAP/SMTP) exists.
//
// How it is switched on: the tenant admin saves the Yandex provider with
// client_id = "demo" (Tenant → Email). Nothing else changes — real client
// credentials keep using the real OAuth flow in yandexService.
//
// What it does:
//   - "Połącz z Yandex" connects a synthetic mailbox (<login>@yandex.ru) without
//     leaving CRMtree, and drops a few unread sample emails into the user's leads;
//   - sending from CRM records the email and a simulated customer reply arrives
//     ~45 s later (same mechanism as crm_training_mode);
//   - "check mail" (debug/process) delivers one more sample email.
//
// Every thread id starts with TRAINING_THREAD_PREFIX, so the thread view is
// rebuilt from our own DB by utils/trainingThread.js — no provider is ever
// called, in this file or downstream.

const crypto   = require("crypto");
const { pool } = require("../config/database");
const { TRAINING_THREAD_PREFIX } = require("../utils/trainingThread");
const { MailboxAlreadyConnectedError } = require("../utils/providerErrors");

const DEMO_CLIENT_ID      = "demo";
const DEMO_ACCESS_TOKEN   = "demo";
const DEMO_MESSAGE_PREFIX = "training_yandex_";
const DEMO_REPLY_DELAY_MS = 45_000;

// Shown as the sender of inbound demo mail in the thread view.
const DEMO_COUNTERPARTY = "Klient (demo Yandex Mail)";

const SAMPLE_EMAILS = [
  {
    subject: "Zapytanie o ofertę",
    body: `Dzień dobry,

trafiliśmy na Państwa ofertę i chcielibyśmy poznać szczegóły współpracy.
Czy mogą Państwo przesłać cennik oraz przykładowy harmonogram wdrożenia?

Pozdrawiam`,
  },
  {
    subject: "Re: Spotkanie w przyszłym tygodniu",
    body: `Dzień dobry,

potwierdzam spotkanie we wtorek o 10:00. Po naszej stronie będzie również
dyrektor finansowy — prosimy o przygotowanie krótkiej prezentacji.

Do zobaczenia`,
  },
  {
    subject: "Pytanie o warunki umowy",
    body: `Dzień dobry,

przeanalizowaliśmy przesłane materiały. Mamy pytanie o okres wypowiedzenia
i możliwość rozszerzenia licencji w trakcie trwania umowy.

Z poważaniem`,
  },
  {
    subject: "Prośba o kontakt telefoniczny",
    body: `Dzień dobry,

proszę o telefon w dogodnym terminie — chcielibyśmy omówić kolejne kroki
i ewentualny start pilotażu jeszcze w tym miesiącu.

Pozdrawiam serdecznie`,
  },
];

const DEMO_REPLY_BODY = `Dzień dobry,

dziękuję za wiadomość. Zapoznałem się z przesłanymi informacjami i jestem
zainteresowany dalszą rozmową. Proszę o propozycję terminu spotkania.

Z poważaniem`;

const randomId = () => crypto.randomBytes(12).toString("hex");
const newThreadId  = () => `${TRAINING_THREAD_PREFIX}yandex_${randomId()}`;
const newMessageId = () => `${DEMO_MESSAGE_PREFIX}${randomId()}`;

function isDemoClientId(clientId) {
  return String(clientId || "").trim().toLowerCase() === DEMO_CLIENT_ID;
}

// ── Inbound sample mail ──────────────────────────────────────────────────────

// Leads the demo mail is "from": the user's own open leads with an e-mail
// address first, any of the tenant's leads as a fallback (e.g. an admin who
// owns no leads).
async function pickDemoLeads(userId, tenantId, limit) {
  const { rows } = await pool.query(
    `SELECT id, contact_name, email
     FROM crm_leads
     WHERE tenant_id = $1
       AND email IS NOT NULL AND email <> ''
       AND stage NOT IN ('closed_lost', 'archived')
     ORDER BY (assigned_to = $2) DESC NULLS LAST, updated_at DESC NULLS LAST
     LIMIT $3`,
    [tenantId, userId, limit],
  );
  return rows;
}

async function insertInboundDemoEmail({ leadId, userId, tenantId, sample, threadId, minutesAgo = 0 }) {
  const messageId = newMessageId();
  await pool.query(
    `INSERT INTO crm_lead_activities
       (lead_id, type, title, body, activity_at, gmail_thread_id, gmail_message_id,
        email_provider, is_read, status, created_by, mailbox_user_id, tenant_id)
     VALUES ($1, 'email', $2, $3, NOW() - make_interval(mins => $4), $5, $6,
             'yandex', false, 'new', NULL, $7, $8)`,
    [leadId, sample.subject, sample.body, minutesAgo, threadId, messageId, userId, tenantId],
  );
  await pool.query(
    `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read, tenant_id)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [messageId, threadId, tenantId],
  );
}

// Seeds the sample inbox once per user — reconnecting must not pile up copies.
async function seedDemoInbox(userId, tenantId) {
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM crm_lead_activities
     WHERE mailbox_user_id = $1 AND gmail_message_id LIKE $2 LIMIT 1`,
    [userId, `${DEMO_MESSAGE_PREFIX}%`],
  );
  if (existing.length) return 0;

  const leads = await pickDemoLeads(userId, tenantId, 3);
  for (const [i, lead] of leads.entries()) {
    await insertInboundDemoEmail({
      leadId: lead.id, userId, tenantId,
      sample: SAMPLE_EMAILS[i % SAMPLE_EMAILS.length],
      threadId: newThreadId(),
      minutesAgo: (i + 1) * 47,
    });
  }
  return leads.length;
}

// "Check mail" in demo mode: one new sample email on one of the user's leads.
async function deliverDemoEmail(userId, tenantId) {
  const leads = await pickDemoLeads(userId, tenantId, 5);
  if (!leads.length) return 0;
  const lead   = leads[Math.floor(Math.random() * leads.length)];
  const sample = SAMPLE_EMAILS[Math.floor(Math.random() * SAMPLE_EMAILS.length)];
  await insertInboundDemoEmail({ leadId: lead.id, userId, tenantId, sample, threadId: newThreadId() });
  return 1;
}

// ── Connect ──────────────────────────────────────────────────────────────────

async function connectDemoMailbox(userId, tenantId) {
  const { rows } = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
  const login = String(rows[0]?.email || "demo").split("@")[0].toLowerCase();

  // user_yandex_tokens_email_unique is global, so the same login in another
  // tenant (admin@a.pl / admin@b.pl) falls back to a user-specific address.
  const candidates = [`${login}@yandex.ru`, `${login}.${String(userId).slice(0, 6)}@yandex.ru`];
  let email = null;
  for (const candidate of candidates) {
    try {
      await pool.query(
        `INSERT INTO user_yandex_tokens
           (user_id, tenant_id, access_token, refresh_token, expires_at, email, last_fetched_at, updated_at)
         VALUES ($1, $2, $3, NULL, NULL, $4, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           access_token = EXCLUDED.access_token, refresh_token = NULL, expires_at = NULL,
           email = EXCLUDED.email, last_fetched_at = NOW(), updated_at = NOW()`,
        [userId, tenantId, DEMO_ACCESS_TOKEN, candidate],
      );
      email = candidate;
      break;
    } catch (err) {
      if (err.code !== "23505" || err.constraint !== "user_yandex_tokens_email_unique") throw err;
    }
  }
  if (!email) throw new MailboxAlreadyConnectedError("yandex");

  await seedDemoInbox(userId, tenantId);
  return { email };
}

// ── Outbound ─────────────────────────────────────────────────────────────────

// Mirrors scheduleTrainingReplyLead/Partner in the provider routes.
function scheduleDemoReply({ table, idCol, recordId, subject, threadId, userId, tenantId }) {
  setTimeout(async () => {
    try {
      const messageId = newMessageId();
      await pool.query(
        `INSERT INTO ${table}
           (${idCol}, type, title, body, activity_at, gmail_thread_id, gmail_message_id,
            email_provider, is_read, mailbox_user_id, tenant_id)
         VALUES ($1, 'email', $2, $3, NOW(), $4, $5, 'yandex', false, $6, $7)`,
        [recordId, `Re: ${subject}`, DEMO_REPLY_BODY, threadId, messageId, userId, tenantId],
      );
      await pool.query(
        `INSERT INTO crm_email_message_reads (gmail_message_id, gmail_thread_id, is_read, tenant_id)
         VALUES ($1, $2, false, $3)
         ON CONFLICT (gmail_message_id) DO NOTHING`,
        [messageId, threadId, tenantId],
      );
    } catch (e) {
      console.warn("[YandexDemo] scheduleDemoReply failed:", e.message);
    }
  }, DEMO_REPLY_DELAY_MS);
}

module.exports = {
  DEMO_COUNTERPARTY,
  isDemoClientId,
  connectDemoMailbox,
  deliverDemoEmail,
  scheduleDemoReply,
  newThreadId,
  newMessageId,
};
