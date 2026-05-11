"use strict";
// src/services/gmailService.js
// Gmail API — OAuth2 per-user (access_token + refresh_token w DB)

const { google } = require("googleapis");
const crypto     = require("crypto");
const { pool }   = require("../config/database");
const config     = require("../config");
const { decrypt } = require("../utils/encrypt");

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
    `SELECT t.access_token, t.refresh_token, t.expires_at,
            ep.client_id     AS ep_client_id,
            ep.client_secret AS ep_secret_enc,
            ep.redirect_uri  AS ep_redirect_uri
     FROM user_gmail_tokens t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN tenant_email_providers ep
       ON ep.tenant_id = u.tenant_id AND ep.provider = 'gmail' AND ep.is_enabled = true
     WHERE t.user_id = $1`,
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Gmail. Zaloguj się przez OAuth.");

  const row   = rows[0];
  const creds = row.ep_client_id
    ? { client_id: row.ep_client_id, client_secret: decrypt(row.ep_secret_enc), redirect_uri: row.ep_redirect_uri }
    : null;
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
  const oauth2 = makeOAuth2Client(creds);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
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
  // Look up tenant Gmail config via the user record (one joined query)
  const { rows: uRows } = await pool.query(
    `SELECT u.tenant_id,
            ep.client_id, ep.client_secret AS ep_secret_enc, ep.redirect_uri
     FROM users u
     LEFT JOIN tenant_email_providers ep
       ON ep.tenant_id = u.tenant_id AND ep.provider = 'gmail' AND ep.is_enabled = true
     WHERE u.id = $1`,
    [userId],
  );
  const creds = uRows[0]?.client_id
    ? { client_id: uRows[0].client_id, client_secret: decrypt(uRows[0].ep_secret_enc), redirect_uri: uRows[0].redirect_uri }
    : null;
  const oauth2 = makeOAuth2Client(creds);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Pobierz adres email z profilu
  const gmail   = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email   = profile.data.emailAddress;

  await pool.query(
    `INSERT INTO user_gmail_tokens (user_id, access_token, refresh_token, expires_at, email, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
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

// ── Wyślij email ──────────────────────────────────────────────────────────────
async function sendEmail({ userId, to, cc, subject, body, threadId, attachments = [], inReplyTo = null, references = null }) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  const signatureHtml = await buildSignatureHtml(userId);
  const fullBody = signatureHtml ? (body || '') + signatureHtml : (body || '');

  // Buduj MIME
  const boundary = `boundary_${Date.now()}`;
  const hasAttachments = attachments.length > 0;

  let rawParts = [
    `To: ${to}`,
    ...(cc         ? [`Cc: ${cc}`]                 : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    ...(inReplyTo  ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `MIME-Version: 1.0`,
  ];

  if (hasAttachments) {
    rawParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    rawParts.push("");
    rawParts.push(`--${boundary}`);
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push("");
    rawParts.push(fullBody);
    for (const att of attachments) {
      rawParts.push(`--${boundary}`);
      rawParts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      rawParts.push(`Content-Transfer-Encoding: base64`);
      rawParts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      rawParts.push("");
      rawParts.push(att.data); // base64
    }
    rawParts.push(`--${boundary}--`);
  } else {
    rawParts.push(`Content-Type: text/html; charset="UTF-8"`);
    rawParts.push("");
    rawParts.push(fullBody);
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
      console.warn(`[GmailService] history.list 404 — historyId ${startHistoryId} zbyt stary. Brak wiadomości do pobrania.`);
      return { messageIds: [], historyId: startHistoryId };
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

// ── Zwraca świeży access_token dla Drive API ──────────────────────────────────
async function getFreshAccessToken(userId) {
  const oauth2 = await getAuthForUser(userId);
  const { token } = await oauth2.getAccessToken();
  return token;
}

module.exports = {
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
  renewAllWatches,
  getCurrentHistoryId,
  getFreshAccessToken,
};
