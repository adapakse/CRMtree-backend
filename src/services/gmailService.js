"use strict";
// src/services/gmailService.js
// Gmail API — OAuth2 per-user (access_token + refresh_token w DB)

const { google } = require("googleapis");
const crypto     = require("crypto");
const { pool }   = require("../config/database");
const config     = require("../config");

// ── OAuth2 client factory ─────────────────────────────────────────────────────
function makeOAuth2Client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

// ── Pobierz / odśwież token usera ────────────────────────────────────────────
async function getAuthForUser(userId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM user_gmail_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Gmail. Zaloguj się przez OAuth.");

  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({
    access_token:  rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date:   rows[0].expires_at ? new Date(rows[0].expires_at).getTime() : null,
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
function getAuthUrl(userId) {
  const oauth2 = makeOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    state:       makeOAuthState(userId),
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://mail.google.com/",
    ],
  });
}

// ── Wymiana code → tokeny i zapis do DB ───────────────────────────────────────
async function exchangeCodeAndSave(code, userId) {
  const oauth2 = makeOAuth2Client();
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

// ── Wyślij email ──────────────────────────────────────────────────────────────
async function sendEmail({ userId, to, cc, subject, body, threadId, attachments = [], inReplyTo = null, references = null }) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

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
    rawParts.push(body || "");
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
    rawParts.push(body || "");
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
  if (!config.google.pubsubTopic) return null;
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });
  const res    = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName:  config.google.pubsubTopic,
      labelIds:   ["INBOX"],
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
};
