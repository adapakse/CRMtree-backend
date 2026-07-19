"use strict";
// src/services/outlookService.js
// Microsoft Graph API — OAuth2 per-user (access_token + refresh_token in DB)

const crypto  = require("crypto");
const { pool } = require("../config/database");
const config   = require("../config");
const { decrypt } = require("../utils/encrypt");
const { ProviderNotConfiguredError, IncompleteProviderConfigError, MailboxAlreadyConnectedError } = require("../utils/providerErrors");
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

  // OAuth2 needs all four, unconditionally, for every Outlook operation once
  // a tenant row exists — no silent per-field fallback to a global .env
  // value or to Microsoft's "common" multi-tenant endpoint.
  const azureTenantId = rows[0].extra_config?.azure_tenant_id;
  const missing = ["client_id", "client_secret", "redirect_uri"].filter((f) => !rows[0][f]);
  if (!azureTenantId) missing.push("azure_tenant_id");
  if (missing.length) throw new IncompleteProviderConfigError("outlook", missing);

  return {
    client_id:    rows[0].client_id,
    client_secret: decrypt(rows[0].client_secret),
    redirect_uri:  rows[0].redirect_uri,
    azure_tenant:  azureTenantId,
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
    redirectUri:   db ? db.redirect_uri  : config.microsoft.redirectUri,
    azureTenant:   db ? db.azure_tenant  : (config.microsoft.tenantId || "common"),
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

  try {
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
  } catch (err) {
    // ON CONFLICT (user_id) only covers "same user reconnecting" — this account's
    // email may already belong to a DIFFERENT user (unique index, migration 0209).
    if (err.code === "23505" && err.constraint === "user_outlook_tokens_email_unique") {
      throw new MailboxAlreadyConnectedError("outlook");
    }
    throw err;
  }

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

// Resolves the RFC 5322 Message-ID of the message being replied to (as
// supplied by the frontend/crm-outlook.js routes — a previous thread
// message's messageIdHeader) to Microsoft Graph's own internal message id.
// createReply (and every Graph endpoint that addresses a message) needs the
// latter; the two are different identifiers and Graph has no way to accept
// the former directly. Returns null if it can't be resolved — callers must
// then send a plain new message, never fabricate threading another way.
async function resolveGraphMessageIdForUser(userId, internetMessageId) {
  if (!internetMessageId) return null;
  const filter = `internetMessageId eq '${String(internetMessageId).replace(/'/g, "''")}'`;
  const res = await graphFetch(userId, `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.value?.[0]?.id || null;
}

function toGraphAttachments(attachments = []) {
  return attachments.map(a => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name:          a.filename,
    contentType:   a.mimeType || "application/octet-stream",
    contentBytes:  a.data,
  }));
}

// ── Send email (new message or reply, with optional attachments) ─────────────
// inReplyTo (optional) — RFC 5322 Message-ID of the message being replied to.
// Microsoft Graph does NOT accept the standard In-Reply-To/References headers
// via internetMessageHeaders — only custom "x-*" headers are allowed there,
// so setting them manually makes Graph reject the whole draft. Correct
// threading instead requires resolving this to Graph's own message id and
// calling POST /me/messages/{id}/createReply, which sets conversationId and
// the threading headers itself; the resulting draft is then filled in with
// the CRM's actual subject/body/recipients/attachments. When no Graph id can
// be resolved, a plain new message is sent — never forcing a thread via
// manually-set headers.
async function sendEmail({ userId, to, cc, subject, body, inReplyTo = null, references = null, attachments = [] }) {
  const signatureHtml = await buildSignatureHtml(userId);
  const fullBody = (body || "") + (signatureHtml || "");

  const toRecipients = to.split(",").map(a => ({ emailAddress: { address: a.trim() } }));
  const ccRecipients = cc ? cc.split(",").map(a => ({ emailAddress: { address: a.trim() } })) : [];
  const graphAttachments = toGraphAttachments(attachments);

  const replyToMessageId = await resolveGraphMessageIdForUser(userId, inReplyTo);

  let draftId, conversationId;

  if (replyToMessageId) {
    const replyRes = await graphFetch(userId, `/me/messages/${replyToMessageId}/createReply`, {
      method: "POST",
      body:   JSON.stringify({}),
    });
    if (!replyRes.ok) {
      const err = await replyRes.json().catch(() => ({}));
      throw new Error(`Tworzenie odpowiedzi failed: ${err.error?.message || replyRes.status}`);
    }
    const draft = await replyRes.json();
    draftId        = draft.id;
    conversationId = draft.conversationId;

    const patchRes = await graphFetch(userId, `/me/messages/${draftId}`, {
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

    // Graph silently ignores an "attachments" array sent via PATCH on an
    // existing draft (only accepted inline on the initial create POST, which
    // createReply doesn't take a body for) — each attachment has to be added
    // with its own POST to the draft's /attachments sub-resource before send.
    for (const att of graphAttachments) {
      const attRes = await graphFetch(userId, `/me/messages/${draftId}/attachments`, {
        method: "POST",
        body:   JSON.stringify(att),
      });
      if (!attRes.ok) {
        const err = await attRes.json().catch(() => ({}));
        throw new Error(`Dodawanie załącznika failed: ${err.error?.message || attRes.status}`);
      }
    }
  } else {
    const messageBody = {
      subject,
      body: { contentType: "html", content: fullBody },
      toRecipients,
      ccRecipients,
      ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
    };

    const draftRes = await graphFetch(userId, "/me/messages", {
      method: "POST",
      body:   JSON.stringify(messageBody),
    });
    if (!draftRes.ok) {
      const err = await draftRes.json().catch(() => ({}));
      throw new Error(`Tworzenie draftu failed: ${err.error?.message || draftRes.status}`);
    }
    const draft = await draftRes.json();
    draftId        = draft.id;
    conversationId = draft.conversationId;
  }

  // Send draft — returns 202 No Content (no body)
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

// ── List non-inline attachment metadata for a single message ─────────────────
// Excludes inline attachments (signature banners, tracking pixels embedded in
// received mail) — mirrors gmailService's Content-Disposition:inline skip.
async function listMessageAttachments(userId, messageId) {
  const res = await graphFetch(userId, `/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.value || [])
    .filter(a => !a.isInline)
    .map(a => ({
      filename:     a.name,
      mimeType:     a.contentType,
      attachmentId: a.id,
      size:         a.size,
    }));
}

async function mapGraphMessage(userId, m) {
  const bodyContent = m.body?.content || "";
  const { cleanBody, quotedBody } = stripOutlookQuotedContent(bodyContent);
  const attachments = m.hasAttachments ? await listMessageAttachments(userId, m.id) : [];
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
    attachments,
  };
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

  const messages = (data.value || [])
    .filter(m => !m.isDraft)
    .sort((a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime());

  return Promise.all(messages.map(m => mapGraphMessage(userId, m)));
}

// ── Fetch a single message (parsed) ───────────────────────────────────────────
async function getMessage(userId, messageId) {
  const select = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageId,conversationId,isDraft";
  const res    = await graphFetch(userId, `/me/messages/${messageId}?$select=${select}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Pobieranie wiadomości failed: ${err.error?.message || res.status}`);
  }
  const m = await res.json();
  return mapGraphMessage(userId, m);
}

// ── Download attachment content ───────────────────────────────────────────────
async function getAttachmentBuffer(userId, messageId, attachmentId) {
  const res = await graphFetch(userId, `/me/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Pobieranie załącznika failed: ${err.error?.message || res.status}`);
  }
  const data = await res.json();
  if (!data.contentBytes) throw new Error("Załącznik nie zawiera danych (możliwy referenceAttachment).");
  return Buffer.from(data.contentBytes, "base64");
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
    if (res.status === 410) {
      // Graph invalidated the delta token (resyncRequired) — messages missed
      // during the outage can't be recovered from delta alone, so we just
      // re-anchor to "now" rather than throwing on every subsequent poll.
      console.warn(`[outlookService] Delta link expired (410) for user=${userId} — reinitializing`);
      return initDeltaLink(userId);
    }
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
  getMessage,
  getAttachmentBuffer,
  getNewMessages,
  initDeltaLink,
};
