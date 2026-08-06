"use strict";
// src/services/gmailService.js
// Gmail API — OAuth2 per-user (access_token + refresh_token w DB)

const { google } = require("googleapis");
const crypto     = require("crypto");
const { pool }   = require("../config/database");
const config     = require("../config");
const { decrypt } = require("../utils/encrypt");
const { ProviderNotConfiguredError } = require("../utils/providerErrors");
const emailQuote  = require("../utils/emailQuote");

// Dev-only escape hatch for the old "fall back to global .env app" behavior.
// Never active in production — must be explicitly opted into locally.
const ALLOW_ENV_FALLBACK = config.isDev && process.env.ALLOW_ENV_EMAIL_FALLBACK === "true";

// ── OAuth2 client factory (accepts optional per-tenant credential override) ───
function makeOAuth2Client(creds = null) {
  return new google.auth.OAuth2(
    creds?.client_id     || config.google.clientId,
    creds?.client_secret || config.google.clientSecret,
    creds?.redirect_uri  || config.google.redirectUri,
  );
}

// ── Pobierz konfigurację Gmail tenanta (z DB) ─────────────────────────────────
async function getTenantGmailCreds(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_secret, redirect_uri, extra_config
     FROM tenant_email_providers
     WHERE tenant_id = $1 AND provider = 'gmail' AND is_enabled = true`,
    [tenantId]
  );
  if (!rows.length) return null;
  return {
    client_id:    rows[0].client_id,
    client_secret: decrypt(rows[0].client_secret),
    redirect_uri:  rows[0].redirect_uri || null,
    extra_config:  rows[0].extra_config || {},
  };
}

// ── Pobierz / odśwież token usera (+ konfiguracja tenanta w jednym zapytaniu) ──
async function getAuthForUser(userId) {
  const { rows } = await pool.query(
    `SELECT t.access_token, t.refresh_token, t.expires_at, u.tenant_id
     FROM user_gmail_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.user_id = $1`,
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Gmail. Zaloguj się przez OAuth.");

  const row   = rows[0];
  const creds = await getTenantGmailCreds(row.tenant_id);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  oauth2.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expires_at ? new Date(row.expires_at).getTime() : null,
  });

  // Auto-refresh jeśli token wygasł
  oauth2.on("tokens", async (tokens) => {
    const updates = ["access_token = $1", "updated_at = NOW()"];
    const params  = [tokens.access_token];
    if (tokens.refresh_token) { updates.push(`refresh_token = $${params.length + 1}`); params.push(tokens.refresh_token); }
    if (tokens.expiry_date)   { updates.push(`expires_at = $${params.length + 1}`);    params.push(new Date(tokens.expiry_date).toISOString()); }
    params.push(userId);
    await pool.query(`UPDATE user_gmail_tokens SET ${updates.join(", ")} WHERE user_id = $${params.length}`, params);
  });

  return oauth2;
}

// ── State OAuth2: HMAC-podpisany token z userId + timestamp ──────────────────
// Format: "<userId>.<timestamp>.<hmac12>" — tylko cyfry, kropki i hex, bezpieczny w URL
function makeOAuthState(userId) {
  const id  = String(userId);
  const ts  = Date.now();
  const sig = crypto
    .createHmac("sha256", config.jwtSecret || "fallback-secret")
    .update(`${id}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  return `${id}.${ts}.${sig}`;
}

function parseOAuthState(state) {
  if (!state || typeof state !== "string") return null;
  // Format: "<userId>.<timestamp>.<hmac16>"
  // userId może być UUID lub liczbą — szukamy ostatnich dwóch kropek
  const lastDot       = state.lastIndexOf(".");
  const secondLastDot = state.lastIndexOf(".", lastDot - 1);
  if (lastDot < 0 || secondLastDot < 0) return null;

  const userIdStr = state.slice(0, secondLastDot);
  const tsStr     = state.slice(secondLastDot + 1, lastDot);
  const sig       = state.slice(lastDot + 1);

  if (!userIdStr || !tsStr || !sig) return null;
  const ts = parseInt(tsStr, 10);
  if (!ts || isNaN(ts)) return null;
  // Token ważny 30 minut
  if (Date.now() - ts > 30 * 60 * 1000) return null;
  const expected = crypto
    .createHmac("sha256", config.jwtSecret || "fallback-secret")
    .update(`${userIdStr}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  if (sig !== expected) return null;
  return userIdStr;  // zwraca string (UUID lub liczba jako string)
}

// ── URL autoryzacji OAuth2 ────────────────────────────────────────────────────
// userId zakodowany w `state` — callback nie wymaga headera Authorization
// tenantId opcjonalne: jeśli podane, używa konfiguracji tenanta z DB
async function getAuthUrl(userId, tenantId = null) {
  const creds  = await getTenantGmailCreds(tenantId);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "select_account consent",
    state:       makeOAuthState(userId),
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

// ── Wymiana code → tokeny i zapis do DB ───────────────────────────────────────
async function exchangeCodeAndSave(code, userId) {
  const { rows: uRows } = await pool.query(`SELECT tenant_id FROM users WHERE id = $1`, [userId]);
  const tenantId = uRows[0]?.tenant_id ?? null;
  const creds = await getTenantGmailCreds(tenantId);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Pobierz adres email z profilu
  const gmail   = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email   = profile.data.emailAddress;

  await pool.query(
    `INSERT INTO user_gmail_tokens (user_id, access_token, refresh_token, expires_at, email, updated_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, user_gmail_tokens.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       email         = EXCLUDED.email,
       updated_at    = NOW()`,
    [
      userId,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      email,
      tenantId,
    ],
  );

  return { email };
}

// ── Status połączenia ─────────────────────────────────────────────────────────
async function getStatus(userId) {
  const { rows } = await pool.query(
    "SELECT email FROM user_gmail_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) return { connected: false };
  return { connected: true, email: rows[0].email };
}

// ── Rozłącz ───────────────────────────────────────────────────────────────────
async function disconnect(userId) {
  await pool.query("DELETE FROM user_gmail_tokens WHERE user_id = $1", [userId]);
}

// ── Pobierz stopkę (HTML usera + banner + klauzula admina) ───────────────────
async function buildSignatureHtml(userId) {
  const [sigRes, settingsRes] = await Promise.all([
    pool.query('SELECT html FROM user_email_signatures WHERE user_id = $1', [userId]),
    pool.query("SELECT key, value FROM app_settings WHERE key IN ('email_signature_banner_url','email_signature_disclaimer')"),
  ]);

  const userHtml   = sigRes.rows[0]?.html || '';
  const settings   = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));
  const bannerUrl  = settings['email_signature_banner_url'] || '';
  const disclaimer = settings['email_signature_disclaimer'] || '';

  if (!userHtml && !bannerUrl && !disclaimer) return '';

  let html = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif">`;

  if (userHtml) html += userHtml;

  if (bannerUrl) {
    html += `<div style="margin-top:16px"><img src="${bannerUrl}" alt="" style="max-width:600px;width:100%;display:block;border:0"></div>`;
  }

  if (disclaimer) {
    html += `<div style="margin-top:12px;color:#9ca3af;font-size:8pt;line-height:1.5">${disclaimer}</div>`;
  }

  html += `</div>`;
  return html;
}

// ── Helpers RFC 2047 / RFC 2045 ──────────────────────────────────────────────

// RFC 2047: enkoduje display name gdy zawiera znaki spoza ASCII
function encodeRfc2047(str) {
  if (!str || !/[^\x00-\x7F]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

// RFC 2045: base64 body musi być zawijane co max 76 znaków
function wrapBase64(b64) {
  return b64.match(/.{1,76}/g).join("\r\n");
}

// ── Wyślij email ──────────────────────────────────────────────────────────────
async function sendEmail({ userId, to, cc, subject, body, threadId, attachments = [], inReplyTo = null, references = null }) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  // Pobierz dane nadawcy do nagłówka From (RFC 2047 dla polskich znaków)
  const { rows: userRows } = await pool.query(
    "SELECT display_name, email FROM users WHERE id = $1",
    [userId],
  );
  const senderName  = userRows[0]?.display_name || "";
  const senderEmail = userRows[0]?.email || "";
  const encodedName = encodeRfc2047(senderName);
  const fromHeader  = encodedName
    ? `${encodedName} <${senderEmail}>`
    : senderEmail;

  const signatureHtml = await buildSignatureHtml(userId);
  const fullBody = signatureHtml ? (body || "") + signatureHtml : (body || "");

  // Buduj MIME
  const boundary = `boundary_${Date.now()}`;
  const hasAttachments = attachments.length > 0;
  const htmlBase64 = wrapBase64(Buffer.from(fullBody, "utf8").toString("base64"));

  let rawParts = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    ...(cc         ? [`Cc: ${cc}`]                 : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    ...(inReplyTo  ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `MIME-Version: 1.0`,
  ];

  if (hasAttachments) {
    rawParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    rawParts.push("");
    rawParts.push(`--${boundary}`);
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push(`Content-Transfer-Encoding: base64`);
    rawParts.push("");
    rawParts.push(htmlBase64);
    for (const att of attachments) {
      rawParts.push(`--${boundary}`);
      rawParts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      rawParts.push(`Content-Transfer-Encoding: base64`);
      rawParts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      rawParts.push("");
      rawParts.push(wrapBase64(att.data));
    }
    rawParts.push(`--${boundary}--`);
  } else {
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push(`Content-Transfer-Encoding: base64`);
    rawParts.push("");
    rawParts.push(htmlBase64);
  }

  const raw = Buffer.from(rawParts.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const params = { userId: "me", requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const response = await gmail.users.messages.send(params);
  return {
    messageId: response.data.id,
    threadId:  response.data.threadId,
  };
}

// ── Pobierz wątek ─────────────────────────────────────────────────────────────
async function getThread(userId, threadId) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  const thread = await gmail.users.threads.get({
    userId: "me",
    id:     threadId,
    format: "full",
  });

  return (thread.data.messages || []).map(parseMessage);
}

// Splits a message body into { cleanBody, quotedBody } — shared with
// outlookService/zohoService via src/utils/emailQuote.js so all three
// providers use the same marker-detection and edge-trimming rules instead of
// three independently-drifting copies. Gmail needs no provider-specific hook
// beyond the common blockquote/.gmail_quote/.gmail_attr removal already
// built into the shared splitter.
function stripQuotedContent(html) {
  return emailQuote.split(html);
}

// ── Parser wiadomości MIME ─────────────────────────────────────────────────────
function parseMessage(msg) {
  const headers = {};
  (msg.payload?.headers || []).forEach((h) => { headers[h.name.toLowerCase()] = h.value; });

  let body = "";
  const attachments = [];

  function extractParts(parts = []) {
    for (const part of parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf8");
      } else if (part.mimeType === "text/plain" && !body && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf8");
      } else if (part.filename && part.body?.attachmentId) {
        // Pomijaj inline images (logo podpisu, pixel trackery) — mają Content-Disposition: inline
        const disposition = (part.headers || [])
          .find((h) => h.name.toLowerCase() === "content-disposition")?.value || "";
        if (disposition.toLowerCase().startsWith("inline")) continue;

        attachments.push({
          filename:     part.filename,
          mimeType:     part.mimeType,
          attachmentId: part.body.attachmentId,
        });
      }
      if (part.parts) extractParts(part.parts);
    }
  }

  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, "base64").toString("utf8");
  }
  extractParts(msg.payload?.parts);

  const { cleanBody, quotedBody } = stripQuotedContent(body);

  return {
    id:               msg.id,
    threadId:         msg.threadId,
    subject:          headers["subject"]    || "",
    from:             headers["from"]       || "",
    to:               headers["to"]         || "",
    cc:               headers["cc"]         || "",
    date:             headers["date"]       ? new Date(headers["date"]).toISOString() : new Date().toISOString(),
    snippet:          msg.snippet           || "",
    body,
    cleanBody,
    quotedBody,
    attachments,
    messageIdHeader:  headers["message-id"] || "",
    referencesHeader: headers["references"] || "",
  };
}

// ── Pobierz zawartość załącznika z Gmail API ──────────────────────────────────
async function getAttachmentBuffer(userId, messageId, attachmentId) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  // Gmail zwraca URL-safe base64 (- zamiast +, _ zamiast /)
  const base64 = res.data.data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

// ── Pobierz pojedynczą wiadomość Gmail (sparsowaną) ───────────────────────────
async function getMessage(userId, messageId) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.get({
    userId:   "me",
    id:       messageId,
    format:   "full",
  });
  return parseMessage(res.data);
}

// ── Pobierz nowe wiadomości od danego historyId (dla Pub/Sub) ─────────────────
async function getNewMessages(userId, startHistoryId) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  try {
    const res = await gmail.users.history.list({
      userId:         "me",
      startHistoryId: String(startHistoryId),
      historyTypes:   ["messageAdded"],
      labelId:        "INBOX",
    });
    const history    = res.data.history || [];
    const messageIds = new Set();
    for (const h of history) {
      for (const ma of h.messagesAdded || []) {
        messageIds.add(ma.message.id);
      }
    }
    return {
      messageIds: [...messageIds],
      historyId:  res.data.historyId || startHistoryId,
    };
  } catch (e) {
    // 404 = historyId zbyt stary (historia wyczyszczona przez Google, max ~7 dni)
    if (e.code === 404 || e.status === 404) {
      console.warn(`[GmailService] history.list 404 — historyId ${startHistoryId} wygasł. Wymagany recovery sync.`);
      return { messageIds: [], historyId: null, needsRecovery: true };
    }
    throw e;
  }
}

// ── Odnów watch dla wszystkich połączonych userów ─────────────────────────────
async function renewAllWatches(pool) {
  if (!config.google.pubsubTopic) return;
  try {
    const { rows } = await pool.query(
      "SELECT user_id FROM user_gmail_tokens WHERE refresh_token IS NOT NULL",
    );
    for (const row of rows) {
      try {
        await registerWatch(row.user_id);
      } catch (e) {
        console.warn("[Gmail] Watch renewal failed for user", row.user_id, e.message);
      }
    }
    console.log(`[Gmail] Watch renewal completed for ${rows.length} user(s)`);
  } catch (e) {
    console.error("[Gmail] renewAllWatches error:", e.message);
  }
}

// ── Rejestracja Pub/Sub watch ─────────────────────────────────────────────────
async function registerWatch(userId) {
  // Resolve pubsub topic: tenant's extra_config takes precedence over global config
  const { rows: tRows } = await pool.query(
    `SELECT ep.extra_config
     FROM users u
     LEFT JOIN tenant_email_providers ep
       ON ep.tenant_id = u.tenant_id AND ep.provider = 'gmail' AND ep.is_enabled = true
     WHERE u.id = $1`,
    [userId],
  );
  const pubsubTopic = tRows[0]?.extra_config?.pubsub_topic || config.google.pubsubTopic;
  if (!pubsubTopic) return null;

  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: pubsubTopic,
      labelIds:  ["INBOX"],
    },
  });
  // Zapisz historyId
  await pool.query(
    "UPDATE user_gmail_tokens SET history_id = $1, updated_at = NOW() WHERE user_id = $2",
    [String(res.data.historyId), userId],
  );
  return res.data;
}

async function getCurrentHistoryId(userId) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.getProfile({ userId: "me" });
  return String(res.data.historyId);
}

// Returns the IDs of the `maxResults` most recent INBOX messages (newest first).
// Used by recovery sync when historyId has expired.
async function listRecentInboxMessages(userId, maxResults = 50) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.list({
    userId:     "me",
    labelIds:   ["INBOX"],
    maxResults,
  });
  return (res.data.messages || []).map(m => m.id);
}

// ── Zwraca świeży access_token dla Drive API ──────────────────────────────────
async function getFreshAccessToken(userId) {
  const oauth2 = await getAuthForUser(userId);
  const { token } = await oauth2.getAccessToken();
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT-OWNED COMPANY MAILBOX — current model: one shared Gmail mailbox per
// tenant (tenant_gmail_tokens), used by every CRM user of that tenant. Mirrors
// the per-user functions above exactly, just resolving credentials by
// tenant_id instead of user_id. The per-user functions above are left
// completely untouched and are no longer called by any route — kept only so
// existing user_gmail_tokens rows remain readable for rollback.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Pobierz / odśwież token skrzynki firmowej tenanta ─────────────────────────
async function getAuthForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM tenant_gmail_tokens WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) throw new Error("Brak podłączonej skrzynki firmowej Gmail. Poproś administratora o połączenie w panelu tenanta.");

  const row   = rows[0];
  const creds = await getTenantGmailCreds(tenantId);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  oauth2.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expires_at ? new Date(row.expires_at).getTime() : null,
  });

  oauth2.on("tokens", async (tokens) => {
    const updates = ["access_token = $1", "updated_at = NOW()"];
    const params  = [tokens.access_token];
    if (tokens.refresh_token) { updates.push(`refresh_token = $${params.length + 1}`); params.push(tokens.refresh_token); }
    if (tokens.expiry_date)   { updates.push(`expires_at = $${params.length + 1}`);    params.push(new Date(tokens.expiry_date).toISOString()); }
    params.push(tenantId);
    await pool.query(`UPDATE tenant_gmail_tokens SET ${updates.join(", ")} WHERE tenant_id = $${params.length}`, params);
  });

  return oauth2;
}

// ── State OAuth2 dla flow tenantowego: tenantId + opcjonalny initiatingUserId
// (tylko do audytu w logu — nigdy nie determinuje właściciela tokenu) ─────────
function makeTenantOAuthState(tenantId, initiatingUserId = null) {
  const tid = String(tenantId);
  const uid = initiatingUserId ? String(initiatingUserId) : "-";
  const ts  = Date.now();
  const sig = crypto
    .createHmac("sha256", config.jwtSecret || "fallback-secret")
    .update(`tenant:${tid}:${uid}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  return `${tid}.${uid}.${ts}.${sig}`;
}

function parseTenantOAuthState(state) {
  if (!state || typeof state !== "string") return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [tenantId, uid, tsStr, sig] = parts;
  if (!tenantId || !tsStr || !sig) return null;
  const ts = parseInt(tsStr, 10);
  if (!ts || isNaN(ts)) return null;
  if (Date.now() - ts > 30 * 60 * 1000) return null;
  const expected = crypto
    .createHmac("sha256", config.jwtSecret || "fallback-secret")
    .update(`tenant:${tenantId}:${uid}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  if (sig !== expected) return null;
  return { tenantId, initiatingUserId: uid === "-" ? null : uid };
}

// ── URL autoryzacji OAuth2 dla skrzynki firmowej tenanta ──────────────────────
async function getTenantAuthUrl(tenantId, initiatingUserId = null) {
  const creds  = await getTenantGmailCreds(tenantId);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "select_account consent",
    state:       makeTenantOAuthState(tenantId, initiatingUserId),
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

// ── Wymiana code → tokeny skrzynki firmowej i zapis do DB ─────────────────────
async function exchangeTenantCodeAndSave(code, tenantId, initiatingUserId = null) {
  const creds = await getTenantGmailCreds(tenantId);
  if (!creds && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("gmail");
  const oauth2 = makeOAuth2Client(creds);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const gmail   = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email   = profile.data.emailAddress;

  await pool.query(
    `INSERT INTO tenant_gmail_tokens (tenant_id, access_token, refresh_token, expires_at, email, connected_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       access_token         = EXCLUDED.access_token,
       refresh_token        = COALESCE(EXCLUDED.refresh_token, tenant_gmail_tokens.refresh_token),
       expires_at           = EXCLUDED.expires_at,
       email                = EXCLUDED.email,
       connected_by_user_id = EXCLUDED.connected_by_user_id,
       updated_at           = NOW()`,
    [tenantId, tokens.access_token, tokens.refresh_token || null,
     tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
     email, initiatingUserId],
  );

  return { email };
}

// ── Status / rozłączenie skrzynki firmowej ────────────────────────────────────
async function getTenantMailboxStatus(tenantId) {
  const { rows } = await pool.query(
    "SELECT email FROM tenant_gmail_tokens WHERE tenant_id = $1",
    [tenantId],
  );
  if (!rows.length) return { connected: false };
  return { connected: true, email: rows[0].email };
}

async function disconnectTenantMailbox(tenantId) {
  await pool.query("DELETE FROM tenant_gmail_tokens WHERE tenant_id = $1", [tenantId]);
}

// ── Wyślij email ze skrzynki firmowej tenanta ─────────────────────────────────
// userId (opcjonalne) — tylko do osobistego podpisu. Autorstwo aktywności CRM
// (created_by) zapisuje wołający route osobno, nie ta funkcja.
async function sendTenantEmail({ tenantId, userId = null, to, cc, subject, body, threadId, attachments = [], inReplyTo = null, references = null }) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  const { rows: mbRows } = await pool.query("SELECT email FROM tenant_gmail_tokens WHERE tenant_id = $1", [tenantId]);
  const fromHeader = mbRows[0]?.email || "";

  const signatureHtml = userId ? await buildSignatureHtml(userId) : "";
  const fullBody = signatureHtml ? (body || "") + signatureHtml : (body || "");

  const boundary = `boundary_${Date.now()}`;
  const hasAttachments = attachments.length > 0;
  const htmlBase64 = wrapBase64(Buffer.from(fullBody, "utf8").toString("base64"));

  let rawParts = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    ...(cc         ? [`Cc: ${cc}`]                 : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    ...(inReplyTo  ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `MIME-Version: 1.0`,
  ];

  if (hasAttachments) {
    rawParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    rawParts.push("");
    rawParts.push(`--${boundary}`);
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push(`Content-Transfer-Encoding: base64`);
    rawParts.push("");
    rawParts.push(htmlBase64);
    for (const att of attachments) {
      rawParts.push(`--${boundary}`);
      rawParts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      rawParts.push(`Content-Transfer-Encoding: base64`);
      rawParts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      rawParts.push("");
      rawParts.push(wrapBase64(att.data));
    }
    rawParts.push(`--${boundary}--`);
  } else {
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push(`Content-Transfer-Encoding: base64`);
    rawParts.push("");
    rawParts.push(htmlBase64);
  }

  const raw = Buffer.from(rawParts.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const params = { userId: "me", requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const response = await gmail.users.messages.send(params);
  return {
    messageId: response.data.id,
    threadId:  response.data.threadId,
  };
}

// ── Pobierz wątek ze skrzynki firmowej ────────────────────────────────────────
async function getTenantThread(tenantId, threadId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  const thread = await gmail.users.threads.get({
    userId: "me",
    id:     threadId,
    format: "full",
  });

  return (thread.data.messages || []).map(parseMessage);
}

async function getTenantAttachmentBuffer(tenantId, messageId, attachmentId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const base64 = res.data.data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

async function getTenantMessage(tenantId, messageId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.get({
    userId:   "me",
    id:       messageId,
    format:   "full",
  });
  return parseMessage(res.data);
}

async function getTenantNewMessages(tenantId, startHistoryId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  try {
    const res = await gmail.users.history.list({
      userId:         "me",
      startHistoryId: String(startHistoryId),
      historyTypes:   ["messageAdded"],
      labelId:        "INBOX",
    });
    const history    = res.data.history || [];
    const messageIds = new Set();
    for (const h of history) {
      for (const ma of h.messagesAdded || []) {
        messageIds.add(ma.message.id);
      }
    }
    return {
      messageIds: [...messageIds],
      historyId:  res.data.historyId || startHistoryId,
    };
  } catch (e) {
    if (e.code === 404 || e.status === 404) {
      console.warn(`[GmailService] history.list 404 — historyId ${startHistoryId} wygasł (tenant=${tenantId}). Wymagany recovery sync.`);
      return { messageIds: [], historyId: null, needsRecovery: true };
    }
    throw e;
  }
}

async function renewAllTenantWatches() {
  if (!config.google.pubsubTopic) return;
  try {
    const { rows } = await pool.query(
      "SELECT tenant_id FROM tenant_gmail_tokens WHERE refresh_token IS NOT NULL",
    );
    for (const row of rows) {
      try {
        await registerTenantWatch(row.tenant_id);
      } catch (e) {
        console.warn("[Gmail] Watch renewal failed for tenant", row.tenant_id, e.message);
      }
    }
    console.log(`[Gmail] Watch renewal completed for ${rows.length} tenant(s)`);
  } catch (e) {
    console.error("[Gmail] renewAllTenantWatches error:", e.message);
  }
}

async function registerTenantWatch(tenantId) {
  const creds = await getTenantGmailCreds(tenantId);
  const pubsubTopic = creds?.extra_config?.pubsub_topic || config.google.pubsubTopic;
  if (!pubsubTopic) return null;

  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: pubsubTopic,
      labelIds:  ["INBOX"],
    },
  });
  await pool.query(
    "UPDATE tenant_gmail_tokens SET history_id = $1, updated_at = NOW() WHERE tenant_id = $2",
    [String(res.data.historyId), tenantId],
  );
  return res.data;
}

async function getTenantCurrentHistoryId(tenantId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.getProfile({ userId: "me" });
  return String(res.data.historyId);
}

async function listTenantRecentInboxMessages(tenantId, maxResults = 50) {
  const oauth2 = await getAuthForTenant(tenantId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.messages.list({
    userId:     "me",
    labelIds:   ["INBOX"],
    maxResults,
  });
  return (res.data.messages || []).map(m => m.id);
}

async function getTenantFreshAccessToken(tenantId) {
  const oauth2 = await getAuthForTenant(tenantId);
  const { token } = await oauth2.getAccessToken();
  return token;
}

module.exports = {
  // Tenant-owned company mailbox — current model, used by all routes.
  getAuthForTenant,
  parseTenantOAuthState,
  getTenantAuthUrl,
  exchangeTenantCodeAndSave,
  getTenantMailboxStatus,
  disconnectTenantMailbox,
  sendTenantEmail,
  getTenantThread,
  getTenantAttachmentBuffer,
  getTenantMessage,
  getTenantNewMessages,
  registerTenantWatch,
  renewAllTenantWatches,
  getTenantCurrentHistoryId,
  listTenantRecentInboxMessages,
  getTenantFreshAccessToken,

  // Legacy per-user (kept for rollback only — no route calls these anymore).
  getAuthUrl,
  parseOAuthState,
  exchangeCodeAndSave,
  getStatus,
  disconnect,
  sendEmail,
  getThread,
  registerWatch,
  getAuthForUser,
  getAttachmentBuffer,
  getMessage,
  getNewMessages,
  listRecentInboxMessages,
  renewAllWatches,
  getCurrentHistoryId,
  getFreshAccessToken,
};
