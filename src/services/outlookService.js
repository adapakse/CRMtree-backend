"use strict";
// src/services/outlookService.js
// Microsoft Graph API — OAuth2 per-user (access_token + refresh_token in DB)

const crypto  = require("crypto");
const { load: cheerioLoad } = require("cheerio");
const { pool } = require("../config/database");
const config   = require("../config");
const { decrypt } = require("../utils/encrypt");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const LOGIN_BASE  = "https://login.microsoftonline.com";

// Scopes requested during OAuth — offline_access required for refresh_token
const OAUTH_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
].join(" ");

// ── Per-tenant Outlook credentials from DB ────────────────────────────────────
async function getTenantOutlookCreds(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_secret, redirect_uri, extra_config
     FROM tenant_email_providers
     WHERE tenant_id = $1 AND provider = 'outlook' AND is_enabled = true`,
    [tenantId],
  );
  if (!rows.length) return null;
  return {
    client_id:    rows[0].client_id,
    client_secret: decrypt(rows[0].client_secret),
    redirect_uri:  rows[0].redirect_uri || null,
    azure_tenant:  rows[0].extra_config?.azure_tenant_id || "common",
  };
}

// ── Resolve effective OAuth credentials (tenant DB or env fallback) ───────────
async function getEffectiveCreds(userId) {
  const { rows } = await pool.query(
    `SELECT u.tenant_id,
            ep.client_id, ep.client_secret AS ep_secret_enc,
            ep.redirect_uri, ep.extra_config
     FROM users u
     LEFT JOIN tenant_email_providers ep
       ON ep.tenant_id = u.tenant_id AND ep.provider = 'outlook' AND ep.is_enabled = true
     WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error("Użytkownik nie znaleziony.");

  const hasDbCreds = !!row.client_id;
  return {
    tenantId:      row.tenant_id,
    clientId:      hasDbCreds ? row.client_id      : config.microsoft.clientId,
    clientSecret:  hasDbCreds ? decrypt(row.ep_secret_enc) : config.microsoft.clientSecret,
    redirectUri:   hasDbCreds ? (row.redirect_uri || config.microsoft.redirectUri) : config.microsoft.redirectUri,
    azureTenant:   row.extra_config?.azure_tenant_id || config.microsoft.tenantId || "common",
  };
}

// ── HMAC-signed OAuth state (same pattern as gmailService) ───────────────────
function makeOAuthState(userId) {
  const id  = String(userId);
  const ts  = Date.now();
  const sig = crypto
    .createHmac("sha256", config.jwt.secret || "fallback-secret")
    .update(`${id}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  return `${id}.${ts}.${sig}`;
}

function parseOAuthState(state) {
  if (!state || typeof state !== "string") return null;
  const lastDot       = state.lastIndexOf(".");
  const secondLastDot = state.lastIndexOf(".", lastDot - 1);
  if (lastDot < 0 || secondLastDot < 0) return null;

  const userIdStr = state.slice(0, secondLastDot);
  const tsStr     = state.slice(secondLastDot + 1, lastDot);
  const sig       = state.slice(lastDot + 1);
  if (!userIdStr || !tsStr || !sig) return null;

  const ts = parseInt(tsStr, 10);
  if (!ts || isNaN(ts)) return null;
  if (Date.now() - ts > 30 * 60 * 1000) return null;

  const expected = crypto
    .createHmac("sha256", config.jwt.secret || "fallback-secret")
    .update(`${userIdStr}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  if (sig !== expected) return null;
  return userIdStr;
}

// ── OAuth2 authorization URL ──────────────────────────────────────────────────
async function getAuthUrl(userId, dbTenantId = null) {
  let creds;
  if (dbTenantId) {
    const db = await getTenantOutlookCreds(dbTenantId);
    creds = db
      ? { clientId: db.client_id, clientSecret: db.client_secret, redirectUri: db.redirect_uri, azureTenant: db.azure_tenant }
      : { clientId: config.microsoft.clientId, clientSecret: config.microsoft.clientSecret, redirectUri: config.microsoft.redirectUri, azureTenant: config.microsoft.tenantId || "common" };
  } else {
    creds = { clientId: config.microsoft.clientId, redirectUri: config.microsoft.redirectUri, azureTenant: config.microsoft.tenantId || "common" };
  }

  const state    = makeOAuthState(userId);
  const params   = new URLSearchParams({
    client_id:     creds.clientId,
    response_type: "code",
    redirect_uri:  creds.redirectUri,
    scope:         OAUTH_SCOPES,
    response_mode: "query",
    state,
    prompt:        "select_account",
  });

  return `${LOGIN_BASE}/${creds.azureTenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

// ── Exchange authorization code for tokens and save to DB ────────────────────
async function exchangeCodeAndSave(code, userId) {
  const creds = await getEffectiveCreds(userId);

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  creds.redirectUri,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    scope:         OAUTH_SCOPES,
  });

  const tokenRes = await fetch(`${LOGIN_BASE}/${creds.azureTenant}/oauth2/v2.0/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) {
    throw new Error(`Token exchange failed: ${tokens.error_description || tokens.error}`);
  }

  // Get user email from Graph
  const meRes = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });
  const me    = await meRes.json();
  const email = me.mail || me.userPrincipalName || null;

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await pool.query(
    `INSERT INTO user_outlook_tokens
       (user_id, tenant_id, access_token, refresh_token, expires_at, email, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, user_outlook_tokens.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       email         = EXCLUDED.email,
       updated_at    = NOW()`,
    [userId, creds.tenantId, tokens.access_token, tokens.refresh_token || null, expiresAt, email],
  );

  return { email };
}

// ── Refresh access token if expired ──────────────────────────────────────────
async function refreshIfNeeded(userId, row, creds) {
  if (!row.expires_at) return row.access_token;
  const expiresAtMs = new Date(row.expires_at).getTime();
  // Refresh 60 seconds before actual expiry
  if (Date.now() < expiresAtMs - 60_000) return row.access_token;

  if (!row.refresh_token) throw new Error("Brak refresh_token — połącz konto Outlook ponownie.");

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: row.refresh_token,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    scope:         OAUTH_SCOPES,
  });

  const res = await fetch(`${LOGIN_BASE}/${creds.azureTenant}/oauth2/v2.0/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await res.json();
  if (!res.ok || tokens.error) {
    throw new Error(`Token refresh failed: ${tokens.error_description || tokens.error}`);
  }

  const refreshedExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await pool.query(
    `UPDATE user_outlook_tokens SET
       access_token  = $1,
       refresh_token = COALESCE($2, refresh_token),
       expires_at    = $3,
       updated_at    = NOW()
     WHERE user_id = $4`,
    [tokens.access_token, tokens.refresh_token || null, refreshedExpiresAt, userId],
  );

  return tokens.access_token;
}

// ── Get a valid access token for a user ──────────────────────────────────────
async function getTokenForUser(userId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM user_outlook_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Outlook. Zaloguj się przez OAuth.");

  const creds = await getEffectiveCreds(userId);
  return refreshIfNeeded(userId, rows[0], creds);
}

// ── Status ────────────────────────────────────────────────────────────────────
async function getStatus(userId) {
  const { rows } = await pool.query(
    "SELECT email FROM user_outlook_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) return { connected: false };
  return { connected: true, email: rows[0].email };
}

// ── Disconnect ────────────────────────────────────────────────────────────────
async function disconnect(userId) {
  await pool.query("DELETE FROM user_outlook_tokens WHERE user_id = $1", [userId]);
}

// ── Email signature (mirrored from gmailService) ──────────────────────────────
async function buildSignatureHtml(userId) {
  const [sigRes, settingsRes] = await Promise.all([
    pool.query("SELECT html FROM user_email_signatures WHERE user_id = $1", [userId]),
    pool.query("SELECT key, value FROM app_settings WHERE key IN ('email_signature_banner_url','email_signature_disclaimer')"),
  ]);

  const userHtml   = sigRes.rows[0]?.html || "";
  const settings   = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));
  const bannerUrl  = settings["email_signature_banner_url"] || "";
  const disclaimer = settings["email_signature_disclaimer"] || "";

  if (!userHtml && !bannerUrl && !disclaimer) return "";

  let html = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif">`;
  if (userHtml)   html += userHtml;
  if (bannerUrl)  html += `<div style="margin-top:16px"><img src="${bannerUrl}" alt="" style="max-width:600px;width:100%;display:block;border:0"></div>`;
  if (disclaimer) html += `<div style="margin-top:12px;color:#9ca3af;font-size:8pt;line-height:1.5">${disclaimer}</div>`;
  html += `</div>`;
  return html;
}

// ── Graph API helper ──────────────────────────────────────────────────────────
async function graphFetch(userId, path, options = {}) {
  const token = await getTokenForUser(userId);
  const url   = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  const res   = await fetch(url, {
    ...options,
    headers: {
      Authorization:   `Bearer ${token}`,
      "Content-Type":  "application/json",
      Prefer:          'IdType="ImmutableId"',
      ...(options.headers || {}),
    },
  });
  return res;
}

// ── Send email (draft → send) ─────────────────────────────────────────────────
async function sendEmail({ userId, to, cc, subject, body, inReplyTo = null, references = null }) {
  const signatureHtml = await buildSignatureHtml(userId);
  const fullBody = (body || "") + (signatureHtml || "");

  const messageBody = {
    subject,
    body:          { contentType: "html", content: fullBody },
    toRecipients:  to.split(",").map(a => ({ emailAddress: { address: a.trim() } })),
    ccRecipients:  cc ? cc.split(",").map(a => ({ emailAddress: { address: a.trim() } })) : [],
  };

  // Add threading headers when replying — Exchange uses these to link messages
  // into the correct conversation and set conversationId.
  if (inReplyTo || references) {
    messageBody.internetMessageHeaders = [];
    if (inReplyTo)  messageBody.internetMessageHeaders.push({ name: "In-Reply-To", value: inReplyTo });
    if (references) messageBody.internetMessageHeaders.push({ name: "References",  value: references });
  }

  // Step 1: create draft — response includes id and conversationId
  const draftRes = await graphFetch(userId, "/me/messages", {
    method: "POST",
    body:   JSON.stringify(messageBody),
  });
  if (!draftRes.ok) {
    const err = await draftRes.json().catch(() => ({}));
    throw new Error(`Tworzenie draftu failed: ${err.error?.message || draftRes.status}`);
  }
  const draft = await draftRes.json();
  const draftId       = draft.id;
  const conversationId = draft.conversationId;

  // Step 2: send draft — returns 202 No Content (no body)
  const sendRes = await graphFetch(userId, `/me/messages/${draftId}/send`, { method: "POST" });
  if (!sendRes.ok && sendRes.status !== 202) {
    const err = await sendRes.json().catch(() => ({}));
    throw new Error(`Wysyłka failed: ${err.error?.message || sendRes.status}`);
  }

  return { messageId: draftId, threadId: conversationId };
}

// ── Strip Outlook quoted history from HTML message body ───────────────────────
// Handles three origins of quoted content:
//   1. Gmail replies received in Outlook inbox (.gmail_attr + .gmail_quote)
//   2. OWA replies (#divRplyFwdMsg, preceded by <hr>)
//   3. Outlook Desktop replies (div with border-top style + Od/Wysłano header)
function stripOutlookQuotedContent(html) {
  if (!html) return html;

  if (!html.includes('<')) {
    const sep = html.search(/-----\s*Original Message\s*-----/i);
    return sep > 0 ? html.slice(0, sep).trim() : html;
  }

  const $ = cheerioLoad(html, { decodeEntities: false });

  // 1. Gmail quotes received in Outlook inbox: attribution line + quoted block
  $('blockquote, .gmail_quote, .gmail_attr').remove();

  // 2. OWA: reply header div — remove preceding <hr> only if it directly precedes it
  const owaSep = $('#divRplyFwdMsg').first();
  if (owaSep.length) {
    const prev = owaSep.prev();
    if (prev.is('hr')) prev.remove();
    owaSep.nextAll().remove();
    owaSep.remove();
  }

  // 3. Outlook Desktop: div with border-top style + Od/Wysłano/From/Sent header
  const desktopSep = $('div').filter(function () {
    const style = ($(this).attr('style') || '').toLowerCase();
    return style.includes('border-top') &&
           /From:|Sent:|To:|Subject:|Od:|Wysłano:|Do:|Temat:/i.test($(this).text());
  }).first();
  if (desktopSep.length) {
    desktopSep.nextAll().remove();
    desktopSep.remove();
  }

  return $('body').html() ?? '';
}

// ── Fetch thread messages (all messages in a conversation) ────────────────────
async function getThread(userId, conversationId) {
  const encoded = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const select  = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageId,conversationId,isDraft";
  const res     = await graphFetch(userId,
    `/me/messages?$filter=${encoded}&$select=${select}&$top=50`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Pobieranie wątku failed: ${err.error?.message || res.status}`);
  }
  const data = await res.json();

  return (data.value || [])
    .filter(m => !m.isDraft)
    .sort((a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime())
    .map(m => ({
      id:              m.id,
      threadId:        m.conversationId,
      subject:         m.subject || "",
      from:            m.from?.emailAddress?.address || "",
      to:              (m.toRecipients || []).map(r => r.emailAddress?.address).join(", "),
      cc:              (m.ccRecipients || []).map(r => r.emailAddress?.address).join(", "),
      date:            m.receivedDateTime,
      snippet:         "",
      body:            m.body?.content || "",
      cleanBody:       stripOutlookQuotedContent(m.body?.content || ""),
      messageIdHeader: m.internetMessageId || "",
      attachments:     m.hasAttachments ? [] : [],
    }));
}

// ── Initialize delta link (first run — no inbox import) ──────────────────────
// Sets delta_link to the current state without importing any existing messages.
async function initDeltaLink(userId) {
  const isoNow = new Date().toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${isoNow}`);
  const select  = "id,conversationId,subject,from,toRecipients,receivedDateTime,isDraft";

  const res = await graphFetch(userId,
    `/me/mailFolders/Inbox/messages/delta?$filter=${filter}&$select=${select}&$top=1`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Delta init failed: ${err.error?.message || res.status}`);
  }
  const data = await res.json();

  // Follow all pages until deltaLink — since filter is ≥ now, this resolves immediately
  let deltaLink = data["@odata.deltaLink"] || null;
  let nextLink  = data["@odata.nextLink"]  || null;

  while (nextLink && !deltaLink) {
    const pageRes  = await graphFetch(userId, nextLink);
    const pageData = await pageRes.json();
    deltaLink = pageData["@odata.deltaLink"] || null;
    nextLink  = pageData["@odata.nextLink"]  || null;
  }

  if (!deltaLink) throw new Error("Nie udało się uzyskać deltaLink — spróbuj ponownie.");

  await pool.query(
    "UPDATE user_outlook_tokens SET delta_link = $1, updated_at = NOW() WHERE user_id = $2",
    [deltaLink, userId],
  );

  return { deltaLink, newMessages: [] };
}

// ── Fetch new messages using delta query ─────────────────────────────────────
// On first call (no delta_link): calls initDeltaLink and returns empty list.
// On subsequent calls: returns messages received since last check.
async function getNewMessages(userId) {
  const { rows } = await pool.query(
    "SELECT delta_link FROM user_outlook_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Outlook.");

  const storedDeltaLink = rows[0].delta_link;

  // First run — initialize without importing inbox
  if (!storedDeltaLink) {
    return initDeltaLink(userId);
  }

  // Subsequent runs — use stored deltaLink
  const messages = [];
  let nextUrl   = storedDeltaLink;
  let deltaLink = null;

  while (nextUrl) {
    const res  = await graphFetch(userId, nextUrl);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Delta fetch failed: ${err.error?.message || res.status}`);
    }
    const data = await res.json();

    for (const m of data.value || []) {
      if (!m.isDraft) messages.push(m);
    }

    deltaLink = data["@odata.deltaLink"] || null;
    nextUrl   = data["@odata.nextLink"]  || null;
  }

  // Store updated deltaLink for next call
  if (deltaLink) {
    await pool.query(
      "UPDATE user_outlook_tokens SET delta_link = $1, updated_at = NOW() WHERE user_id = $2",
      [deltaLink, userId],
    );
  }

  return { deltaLink, newMessages: messages };
}

module.exports = {
  makeOAuthState,
  parseOAuthState,
  getAuthUrl,
  exchangeCodeAndSave,
  getStatus,
  disconnect,
  sendEmail,
  getThread,
  getNewMessages,
  initDeltaLink,
};
