"use strict";
// src/services/gmailService.js
// Gmail API — OAuth2 per-user (access_token + refresh_token w DB)

const { google } = require("googleapis");
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

// ── URL autoryzacji OAuth2 ────────────────────────────────────────────────────
function getAuthUrl() {
  const oauth2 = makeOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
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
async function sendEmail({ userId, to, subject, body, threadId, attachments = [] }) {
  const oauth2 = await getAuthForUser(userId);
  const gmail  = google.gmail({ version: "v1", auth: oauth2 });

  // Buduj MIME
  const boundary = `boundary_${Date.now()}`;
  const hasAttachments = attachments.length > 0;

  let rawParts = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
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
    id:          msg.id,
    threadId:    msg.threadId,
    subject:     headers["subject"] || "",
    from:        headers["from"]    || "",
    to:          headers["to"]      || "",
    date:        headers["date"]    ? new Date(headers["date"]).toISOString() : new Date().toISOString(),
    snippet:     msg.snippet        || "",
    body,
    attachments,
  };
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

module.exports = {
  getAuthUrl,
  exchangeCodeAndSave,
  getStatus,
  disconnect,
  sendEmail,
  getThread,
  registerWatch,
  getAuthForUser,
};
