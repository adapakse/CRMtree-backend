"use strict";
// src/services/outlookService.js
// Microsoft Graph API — OAuth2 per-user (access_token + refresh_token in DB)

const crypto  = require("crypto");
const { pool } = require("../config/database");
const config   = require("../config");
const { decrypt } = require("../utils/encrypt");
const { ProviderNotConfiguredError } = require("../utils/providerErrors");
const emailQuote = require("../utils/emailQuote");

// Dev-only escape hatch for the old "fall back to global .env app" behavior.
// Never active in production — must be explicitly opted into locally.
const ALLOW_ENV_FALLBACK = config.isDev && process.env.ALLOW_ENV_EMAIL_FALLBACK === "true";

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

// ── Resolve effective OAuth credentials (tenant DB, dev-only env fallback) ────
async function getEffectiveCreds(userId) {
  const { rows } = await pool.query(`SELECT tenant_id FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row) throw new Error("Użytkownik nie znaleziony.");

  const db = await getTenantOutlookCreds(row.tenant_id);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("outlook");

  return {
    tenantId:      row.tenant_id,
    clientId:      db ? db.client_id     : config.microsoft.clientId,
    clientSecret:  db ? db.client_secret : config.microsoft.clientSecret,
    redirectUri:   db ? (db.redirect_uri || config.microsoft.redirectUri) : config.microsoft.redirectUri,
    azureTenant:   db?.azure_tenant || config.microsoft.tenantId || "common",
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
  const db = await getTenantOutlookCreds(dbTenantId);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("outlook");

  const creds = db
    ? { clientId: db.client_id, redirectUri: db.redirect_uri, azureTenant: db.azure_tenant }
    : { clientId: config.microsoft.clientId, redirectUri: config.microsoft.redirectUri, azureTenant: config.microsoft.tenantId || "common" };

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
  const email = me.mail || null;

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

// Outlook-specific structural pre-removal, run by the shared splitter before
// its text-marker fallback: OWA's #divRplyFwdMsg reply-header marker and
// Outlook Desktop's border-top reply-header div. Both pinpoint the quote
// boundary directly (more reliable than guessing from visible text), and
// capture what they remove so the quoted history is preserved as
// quotedBody, not discarded. Gmail-origin quotes received in an Outlook
// inbox (.gmail_attr/.gmail_quote) are handled by the common removal already
// built into emailQuote.split() — no Outlook-specific code needed for those.
function removeExtraOutlookQuote($) {
  const owaSep = $('#divRplyFwdMsg').first();
  if (owaSep.length) {
    const prev = owaSep.prev();
    if (prev.is('hr')) prev.remove();
    const $wrap = $('<div></div>');
    $wrap.append(owaSep.clone());
    $wrap.append(owaSep.nextAll().clone());
    const captured = $wrap.html();
    owaSep.nextAll().remove();
    owaSep.remove();
    return captured;
  }

  const desktopSep = $('div').filter(function () {
    const style = ($(this).attr('style') || '').toLowerCase();
    return style.includes('border-top') &&
           /From:|Sent:|To:|Subject:|Od:|Wysłano:|Do:|Temat:/i.test($(this).text());
  }).first();
  if (desktopSep.length) {
    const $wrap = $('<div></div>');
    $wrap.append(desktopSep.clone());
    $wrap.append(desktopSep.nextAll().clone());
    const captured = $wrap.html();
    desktopSep.nextAll().remove();
    desktopSep.remove();
    return captured;
  }

  return null;
}

// Splits an Outlook message body into { cleanBody, quotedBody } — shared
// with gmailService/zohoService via src/utils/emailQuote.js so all three
// providers use the same marker-detection and edge-trimming rules instead of
// three independently-drifting copies.
function stripOutlookQuotedContent(html) {
  return emailQuote.split(html, { removeExtra: removeExtraOutlookQuote });
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
    .map(m => {
      const bodyContent = m.body?.content || "";
      const { cleanBody, quotedBody } = stripOutlookQuotedContent(bodyContent);
      return {
        id:              m.id,
        threadId:        m.conversationId,
        subject:         m.subject || "",
        from:            m.from?.emailAddress?.address || "",
        to:              (m.toRecipients || []).map(r => r.emailAddress?.address).join(", "),
        cc:              (m.ccRecipients || []).map(r => r.emailAddress?.address).join(", "),
        date:            m.receivedDateTime,
        snippet:         "",
        body:            bodyContent,
        cleanBody,
        quotedBody,
        messageIdHeader: m.internetMessageId || "",
        attachments:     m.hasAttachments ? [] : [],
      };
    });
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

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT-OWNED COMPANY MAILBOX — current model: one shared Outlook mailbox per
// tenant (tenant_outlook_tokens), used by every CRM user of that tenant.
// Mirrors the per-user functions above exactly, resolving credentials by
// tenant_id instead of user_id. The per-user functions above are left
// completely untouched and are no longer called by any route — kept only so
// existing user_outlook_tokens rows remain readable for rollback.
// ═══════════════════════════════════════════════════════════════════════════════

async function getEffectiveCredsForTenant(tenantId) {
  const db = await getTenantOutlookCreds(tenantId);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("outlook");
  return {
    tenantId,
    clientId:     db ? db.client_id     : config.microsoft.clientId,
    clientSecret: db ? db.client_secret : config.microsoft.clientSecret,
    redirectUri:  db ? (db.redirect_uri || config.microsoft.redirectUri) : config.microsoft.redirectUri,
    azureTenant:  db?.azure_tenant || config.microsoft.tenantId || "common",
  };
}

// ── State OAuth2 dla flow tenantowego: tenantId + opcjonalny initiatingUserId
// (tylko do audytu w logu — nigdy nie determinuje właściciela tokenu) ─────────
function makeTenantOAuthState(tenantId, initiatingUserId = null) {
  const tid = String(tenantId);
  const uid = initiatingUserId ? String(initiatingUserId) : "-";
  const ts  = Date.now();
  const sig = crypto
    .createHmac("sha256", config.jwt.secret || "fallback-secret")
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
    .createHmac("sha256", config.jwt.secret || "fallback-secret")
    .update(`tenant:${tenantId}:${uid}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  if (sig !== expected) return null;
  return { tenantId, initiatingUserId: uid === "-" ? null : uid };
}

async function getTenantAuthUrl(tenantId, initiatingUserId = null) {
  const db = await getTenantOutlookCreds(tenantId);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("outlook");

  const creds = db
    ? { clientId: db.client_id, redirectUri: db.redirect_uri, azureTenant: db.azure_tenant }
    : { clientId: config.microsoft.clientId, redirectUri: config.microsoft.redirectUri, azureTenant: config.microsoft.tenantId || "common" };

  const state  = makeTenantOAuthState(tenantId, initiatingUserId);
  const params = new URLSearchParams({
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

// Basic email shape check — enough to reject non-address strings (like an
// "...#EXT#@tenant.onmicrosoft.com" UPN) without pretending to fully validate
// RFC 5322. Never treats a "#EXT#" value as valid, no matter which field it
// came from.
function looksLikeRealEmail(value) {
  return typeof value === "string"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    && !value.includes("#EXT#");
}

// Picks the account's real, deliverable address from a Microsoft Graph /me
// response. `mail` is preferred (the canonical mailbox address for
// work/school accounts). For external/personal Microsoft accounts
// (outlook.com, hotmail.com, ...) invited as guests, `mail` is often empty —
// Graph then carries the real address in `otherMails` or, less commonly, in
// `identities`. `userPrincipalName` is never a candidate: for guest/B2B
// accounts it is always the unusable "...#EXT#@tenant.onmicrosoft.com"
// sign-in identifier, not a mailbox address — it is never inspected here.
function pickMailboxEmail(me) {
  if (looksLikeRealEmail(me.mail)) return me.mail;

  const otherMail = (me.otherMails || []).find(looksLikeRealEmail);
  if (otherMail) return otherMail;

  const identityEmail = (me.identities || [])
    .map((i) => i.issuerAssignedId)
    .find(looksLikeRealEmail);
  if (identityEmail) return identityEmail;

  return null;
}

async function exchangeTenantCodeAndSave(code, tenantId, initiatingUserId = null) {
  const creds = await getEffectiveCredsForTenant(tenantId);

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

  const meRes = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName,otherMails,identities`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });
  const me    = await meRes.json();
  // No real address in mail/otherMails/identities (common for personal/test
  // Microsoft accounts) is NOT a reason to refuse the connection — OAuth
  // already succeeded and the account is usable via Graph. `email` is simply
  // stored as NULL (column is nullable); it is never backfilled with
  // userPrincipalName, so a "#EXT#" identifier can never end up here.
  const email = pickMailboxEmail(me);

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await pool.query(
    `INSERT INTO tenant_outlook_tokens
       (tenant_id, access_token, refresh_token, expires_at, email, connected_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       access_token         = EXCLUDED.access_token,
       refresh_token        = COALESCE(EXCLUDED.refresh_token, tenant_outlook_tokens.refresh_token),
       expires_at           = EXCLUDED.expires_at,
       email                = EXCLUDED.email,
       connected_by_user_id = EXCLUDED.connected_by_user_id,
       updated_at           = NOW()`,
    [tenantId, tokens.access_token, tokens.refresh_token || null, expiresAt, email, initiatingUserId],
  );

  return { email };
}

async function refreshTenantTokenIfNeeded(tenantId, row, creds) {
  if (!row.expires_at) return row.access_token;
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAtMs - 60_000) return row.access_token;

  if (!row.refresh_token) throw new Error("Brak refresh_token — połącz skrzynkę Outlook ponownie w panelu tenanta.");

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
    `UPDATE tenant_outlook_tokens SET
       access_token  = $1,
       refresh_token = COALESCE($2, refresh_token),
       expires_at    = $3,
       updated_at    = NOW()
     WHERE tenant_id = $4`,
    [tokens.access_token, tokens.refresh_token || null, refreshedExpiresAt, tenantId],
  );

  return tokens.access_token;
}

async function getTokenForTenant(tenantId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM tenant_outlook_tokens WHERE tenant_id = $1",
    [tenantId],
  );
  if (!rows.length) throw new Error("Brak podłączonej skrzynki firmowej Outlook. Poproś administratora o połączenie w panelu tenanta.");

  const creds = await getEffectiveCredsForTenant(tenantId);
  return refreshTenantTokenIfNeeded(tenantId, rows[0], creds);
}

async function getTenantMailboxStatus(tenantId) {
  const { rows } = await pool.query(
    "SELECT email FROM tenant_outlook_tokens WHERE tenant_id = $1",
    [tenantId],
  );
  if (!rows.length) return { connected: false };
  // email can be NULL (see exchangeTenantCodeAndSave) when Graph exposed no
  // real address for the connected account — never surface that as a blank
  // value or (worse) a "#EXT#" identifier; show a neutral, honest label instead.
  return { connected: true, email: rows[0].email || "Skrzynka Outlook podłączona" };
}

async function disconnectTenantMailbox(tenantId) {
  await pool.query("DELETE FROM tenant_outlook_tokens WHERE tenant_id = $1", [tenantId]);
}

async function graphFetchForTenant(tenantId, path, options = {}) {
  const token = await getTokenForTenant(tenantId);
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

// Resolves the RFC 5322 Message-ID of the message being replied to (as
// already supplied by the frontend/crm-outlook.js routes — e.g. a previous
// thread message's messageIdHeader) to Microsoft Graph's own internal
// message id. createReply (and every Graph endpoint that addresses a
// message) needs the latter; the two are different identifiers and Graph has
// no way to accept the former directly. Returns null if it can't be
// resolved — callers must then send a plain new message, never fabricate
// threading another way.
async function resolveGraphMessageId(tenantId, internetMessageId) {
  if (!internetMessageId) return null;
  const filter = `internetMessageId eq '${String(internetMessageId).replace(/'/g, "''")}'`;
  const res = await graphFetchForTenant(
    tenantId,
    `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`,
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.value?.[0]?.id || null;
}

// ── Send email from the tenant's shared mailbox (draft → send) ───────────────
// userId (optional) — personal signature only; Graph always sends "as" the
// authenticated (tenant) mailbox regardless of any header here.
//
// inReplyTo (optional) — RFC 5322 Message-ID of the message being replied
// to. Microsoft Graph does NOT accept the standard In-Reply-To/References
// headers via internetMessageHeaders — only custom "x-*" headers are allowed
// there, so setting them manually makes Graph reject the whole draft.
// Correct threading instead requires resolving this to Graph's own message
// id and calling POST /me/messages/{id}/createReply, which sets
// conversationId and the threading headers itself; the resulting draft is
// then filled in with the CRM's actual subject/body/recipients. When no
// Graph id can be resolved, a plain new message is sent — never forcing a
// thread via manually-set headers.
async function sendTenantEmail({ tenantId, userId = null, to, cc, subject, body, inReplyTo = null }) {
  const signatureHtml = userId ? await buildSignatureHtml(userId) : "";
  const fullBody = (body || "") + (signatureHtml || "");

  const toRecipients = to.split(",").map(a => ({ emailAddress: { address: a.trim() } }));
  const ccRecipients = cc ? cc.split(",").map(a => ({ emailAddress: { address: a.trim() } })) : [];

  const replyToMessageId = await resolveGraphMessageId(tenantId, inReplyTo);

  let draftId, conversationId;

  if (replyToMessageId) {
    const replyRes = await graphFetchForTenant(tenantId, `/me/messages/${replyToMessageId}/createReply`, {
      method: "POST",
      body:   JSON.stringify({}),
    });
    if (!replyRes.ok) {
      const err = await replyRes.json().catch(() => ({}));
      console.error("[Outlook] createReply failed", {
        status:          replyRes.status,
        code:            err.error?.code    || null,
        message:         err.error?.message || null,
        wwwAuthenticate: replyRes.headers.get("www-authenticate") || null,
        requestId:       replyRes.headers.get("request-id") || replyRes.headers.get("client-request-id") || null,
      });
      throw new Error(`Tworzenie odpowiedzi failed: ${err.error?.message || replyRes.status}`);
    }
    const draft = await replyRes.json();
    draftId        = draft.id;
    conversationId  = draft.conversationId;

    const patchRes = await graphFetchForTenant(tenantId, `/me/messages/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({
        subject,
        body: { contentType: "html", content: fullBody },
        toRecipients,
        ccRecipients,
      }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.json().catch(() => ({}));
      throw new Error(`Uzupełnianie odpowiedzi failed: ${err.error?.message || patchRes.status}`);
    }
  } else {
    const messageBody = {
      subject,
      body:         { contentType: "html", content: fullBody },
      toRecipients,
      ccRecipients,
    };

    const draftRes = await graphFetchForTenant(tenantId, "/me/messages", {
      method: "POST",
      body:   JSON.stringify(messageBody),
    });
    if (!draftRes.ok) {
      const err = await draftRes.json().catch(() => ({}));
      // Diagnostic only — status/error body/headers from Graph's *response*,
      // never the request's Authorization header or the access/refresh token.
      console.error("[Outlook] draft creation failed", {
        status:          draftRes.status,
        code:            err.error?.code    || null,
        message:         err.error?.message || null,
        wwwAuthenticate: draftRes.headers.get("www-authenticate") || null,
        requestId:       draftRes.headers.get("request-id") || draftRes.headers.get("client-request-id") || null,
      });
      throw new Error(`Tworzenie draftu failed: ${err.error?.message || draftRes.status}`);
    }
    const draft = await draftRes.json();
    draftId        = draft.id;
    conversationId  = draft.conversationId;
  }

  const sendRes = await graphFetchForTenant(tenantId, `/me/messages/${draftId}/send`, { method: "POST" });
  if (!sendRes.ok && sendRes.status !== 202) {
    const err = await sendRes.json().catch(() => ({}));
    throw new Error(`Wysyłka failed: ${err.error?.message || sendRes.status}`);
  }

  return { messageId: draftId, threadId: conversationId };
}

async function getTenantThread(tenantId, conversationId) {
  const encoded = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const select  = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageId,conversationId,isDraft";
  const res     = await graphFetchForTenant(tenantId,
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
    .map(m => {
      const bodyContent = m.body?.content || "";
      const { cleanBody, quotedBody } = stripOutlookQuotedContent(bodyContent);
      return {
        id:              m.id,
        threadId:        m.conversationId,
        subject:         m.subject || "",
        from:            m.from?.emailAddress?.address || "",
        to:              (m.toRecipients || []).map(r => r.emailAddress?.address).join(", "),
        cc:              (m.ccRecipients || []).map(r => r.emailAddress?.address).join(", "),
        date:            m.receivedDateTime,
        snippet:         "",
        body:            bodyContent,
        cleanBody,
        quotedBody,
        messageIdHeader: m.internetMessageId || "",
        attachments:     m.hasAttachments ? [] : [],
      };
    });
}

async function initTenantDeltaLink(tenantId) {
  const isoNow = new Date().toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${isoNow}`);
  const select  = "id,conversationId,subject,from,toRecipients,receivedDateTime,isDraft";

  const res = await graphFetchForTenant(tenantId,
    `/me/mailFolders/Inbox/messages/delta?$filter=${filter}&$select=${select}&$top=1`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Delta init failed: ${err.error?.message || res.status}`);
  }
  const data = await res.json();

  let deltaLink = data["@odata.deltaLink"] || null;
  let nextLink  = data["@odata.nextLink"]  || null;

  while (nextLink && !deltaLink) {
    const pageRes  = await graphFetchForTenant(tenantId, nextLink);
    const pageData = await pageRes.json();
    deltaLink = pageData["@odata.deltaLink"] || null;
    nextLink  = pageData["@odata.nextLink"]  || null;
  }

  if (!deltaLink) throw new Error("Nie udało się uzyskać deltaLink — spróbuj ponownie.");

  await pool.query(
    "UPDATE tenant_outlook_tokens SET delta_link = $1, updated_at = NOW() WHERE tenant_id = $2",
    [deltaLink, tenantId],
  );

  return { deltaLink, newMessages: [] };
}

async function getTenantNewMessages(tenantId) {
  const { rows } = await pool.query(
    "SELECT delta_link FROM tenant_outlook_tokens WHERE tenant_id = $1",
    [tenantId],
  );
  if (!rows.length) throw new Error("Brak podłączonej skrzynki firmowej Outlook.");

  const storedDeltaLink = rows[0].delta_link;

  if (!storedDeltaLink) {
    return initTenantDeltaLink(tenantId);
  }

  const messages = [];
  let nextUrl   = storedDeltaLink;
  let deltaLink = null;

  while (nextUrl) {
    const res  = await graphFetchForTenant(tenantId, nextUrl);
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

  if (deltaLink) {
    await pool.query(
      "UPDATE tenant_outlook_tokens SET delta_link = $1, updated_at = NOW() WHERE tenant_id = $2",
      [deltaLink, tenantId],
    );
  }

  return { deltaLink, newMessages: messages };
}

module.exports = {
  // Tenant-owned company mailbox — current model, used by all routes.
  parseTenantOAuthState,
  getTenantAuthUrl,
  exchangeTenantCodeAndSave,
  getTenantMailboxStatus,
  disconnectTenantMailbox,
  sendTenantEmail,
  getTenantThread,
  getTenantNewMessages,
  initTenantDeltaLink,

  // Legacy per-user (kept for rollback only — no route calls these anymore).
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
