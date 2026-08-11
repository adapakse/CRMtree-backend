"use strict";
// src/services/zohoService.js
// Zoho Mail API — OAuth2 per-user (access_token + refresh_token in DB)

const crypto = require("crypto");
const { load: cheerioLoad } = require("cheerio");
const { pool } = require("../config/database");
const config   = require("../config");
const { decrypt } = require("../utils/encrypt");
const { ProviderNotConfiguredError, IncompleteProviderConfigError, MailboxAlreadyConnectedError } = require("../utils/providerErrors");
const emailQuote = require("../utils/emailQuote");

// Dev-only escape hatch for the old "fall back to global .env app" behavior.
// Never active in production — must be explicitly opted into locally.
const ALLOW_ENV_FALLBACK = config.isDev && process.env.ALLOW_ENV_EMAIL_FALLBACK === "true";

// Strips "Name <addr>" or "addr" down to a lowercase bare address for comparison.
function normalizeEmailAddr(addr) {
  if (!addr) return '';
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).trim().toLowerCase();
}

// Removes lines/elements whose full (trimmed) text is exactly the Zoho
// "Sent using Zoho Mail" signature, plus the blank lines left behind.
// Never touches the phrase when it appears inside a longer sentence. This is
// pure noise (not history), so it is only ever discarded, never preserved
// into quotedBody.
const ZOHO_FOOTER_TEXT = 'sent using zoho mail';

function stripZohoFooterText(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().toLowerCase() !== ZOHO_FOOTER_TEXT)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeZohoFooterElement($) {
  $('*').filter(function () {
    return $(this).children().length === 0 &&
           $(this).text().trim().toLowerCase() === ZOHO_FOOTER_TEXT;
  }).remove();
  return null; // noise removal only — never treated as quotedBody
}

// Strips only visual noise from the *already-decided* quotedBody HTML —
// never changes what counts as clean vs. quoted (that split happens earlier,
// in emailQuote.split()). Zoho's own quoted-message wrappers sometimes carry
// inline border/background styling (e.g. a black border) that clashes with
// the CRM's own "Pokaż/Ukryj cytowaną historię" styling, unlike Gmail's/
// Outlook's native quote markup — so the toggle content doesn't look the
// same across providers. Content and the show/hide behavior are untouched.
function sanitizeZohoQuoteHtml(html) {
  if (!html) return html;
  const $ = cheerioLoad(html, { decodeEntities: false });

  // Some Zoho exports wrap quoted content in <details>/<summary> — unwrap
  // them (keep the content, drop the tag) so no native disclosure triangle
  // renders alongside the CRM's own toggle button.
  $('details, summary').each(function () {
    $(this).replaceWith($(this).contents());
  });

  // Drop only layout/decoration properties that visually clash with the
  // CRM's own wrapper (border/background/shadow/outline) — everything else
  // (color, font-size, text formatting) is left as-is.
  $('*').each(function () {
    const style = $(this).attr('style');
    if (!style) return;
    const kept = style
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl && !/^(border|background|box-shadow|outline)/i.test(decl));
    if (kept.length) $(this).attr('style', kept.join('; '));
    else $(this).removeAttr('style');
  });

  return $('body').html() ?? '';
}

// Splits a Zoho message body into { cleanBody, quotedBody } — shared with
// gmailService/outlookService via src/utils/emailQuote.js so all three
// providers use the same marker-detection and edge-trimming rules instead of
// three independently-drifting copies. Zoho's own "Sent using Zoho Mail"
// footer removal is the only genuinely Zoho-specific step needed on top of
// that (Zoho's "On [weekday] ... wrote" / "napisał(a):" / "Od:/Do:/Temat:"
// quote citations are handled by the shared text-marker fallback). The
// resulting quotedBody is then style-sanitized so it renders the same as
// Gmail's/Outlook's — cleanBody and the clean/quoted split itself are
// untouched.
function stripZohoQuotedContent(html) {
  const result = emailQuote.split(html, {
    removeExtra: removeZohoFooterElement,
    filterVisibleText: stripZohoFooterText,
  });
  return {
    cleanBody:  result.cleanBody,
    quotedBody: result.quotedBody ? sanitizeZohoQuoteHtml(result.quotedBody) : result.quotedBody,
  };
}

// Static mapping of accounts_server → Zoho Mail API host.
// Source: https://www.zoho.com/mail/help/api/getting-started-with-api.html
const ZOHO_MAIL_HOSTS = {
  "https://accounts.zoho.com":     "https://mail.zoho.com",
  "https://accounts.zoho.eu":      "https://mail.zoho.eu",
  "https://accounts.zoho.in":      "https://mail.zoho.in",
  "https://accounts.zoho.com.au":  "https://mail.zoho.com.au",
  "https://accounts.zoho.jp":      "https://mail.zoho.jp",
  "https://accounts.zohocloud.ca": "https://mail.zohocloud.ca",
  "https://accounts.zoho.com.cn":  "https://mail.zoho.com.cn",
  "https://accounts.zoho.ae":      "https://mail.zoho.ae",
  "https://accounts.zoho.sa":      "https://mail.zoho.sa",
};

function getMailBase(accountsServer) {
  const host = ZOHO_MAIL_HOSTS[accountsServer];
  if (!host) throw new Error(`Nieznany Zoho DC: ${accountsServer}`);
  return `${host}/api`;
}

// Returns the folderId of the Inbox folder for the given account.
// folderType is a string 'Inbox' per Zoho Mail API v1.
async function getInboxFolderId(mailBase, accountId, accessToken) {
  const res = await fetch(
    `${mailBase}/accounts/${accountId}/folders`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );

  if (!res.ok) {
    let desc = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      desc = err.data?.errorMessage || err.status?.description || desc;
    } catch (_) {}
    throw new Error(`Zoho folders API error: ${desc}`);
  }

  const data = await res.json();

  if (data.status?.code && data.status.code !== 200) {
    throw new Error(`Zoho folders API error: ${data.status.description || data.data?.errorMessage || `code ${data.status.code}`}`);
  }

  const folders = data.data || [];
  const inbox   = folders.find(f => f.folderType === "Inbox");

  if (!inbox) {
    const known = folders.map(f => `${f.folderName}(${f.folderType})`).join(", ") || "(brak)";
    throw new Error(`Nie znaleziono folderu Inbox w koncie Zoho. Dostępne foldery: ${known}`);
  }

  return String(inbox.folderId);
}

const OAUTH_SCOPES = "ZohoMail.accounts.READ,ZohoMail.messages.ALL,ZohoMail.folders.READ";

// ── Per-tenant Zoho credentials from DB ──────────────────────────────────────
async function getTenantZohoCreds(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_secret, redirect_uri
     FROM tenant_email_providers
     WHERE tenant_id = $1 AND provider = 'zoho' AND is_enabled = true`,
    [tenantId],
  );
  if (!rows.length) return null;

  // OAuth2 needs all three, unconditionally, for every Zoho operation once a
  // tenant row exists — no silent per-field fallback to a global .env value.
  const missing = ["client_id", "client_secret", "redirect_uri"].filter((f) => !rows[0][f]);
  if (missing.length) throw new IncompleteProviderConfigError("zoho", missing);

  return {
    client_id:     rows[0].client_id,
    client_secret: decrypt(rows[0].client_secret),
    redirect_uri:  rows[0].redirect_uri,
  };
}

async function getEffectiveCreds(userId) {
  const { rows } = await pool.query(`SELECT tenant_id FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row) throw new Error("Użytkownik nie znaleziony.");

  const db = await getTenantZohoCreds(row.tenant_id);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("zoho");

  return {
    tenantId:     row.tenant_id,
    clientId:     db ? db.client_id     : config.zoho.clientId,
    clientSecret: db ? db.client_secret : config.zoho.clientSecret,
    redirectUri:  db ? db.redirect_uri  : config.zoho.redirectUri,
  };
}

// ── HMAC-signed OAuth state (same pattern as gmail/outlookService) ────────────
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
// Targets EU DC by default; accounts_server in callback confirms actual DC.
async function getAuthUrl(userId) {
  const creds = await getEffectiveCreds(userId);
  const state = makeOAuthState(userId);
  const params = new URLSearchParams({
    client_id:     creds.clientId,
    response_type: "code",
    redirect_uri:  creds.redirectUri,
    scope:         OAUTH_SCOPES,
    access_type:   "offline",
    state,
    prompt:        "consent",
  });
  return `https://accounts.zoho.eu/oauth/v2/auth?${params.toString()}`;
}

// ── Exchange authorization code for tokens and save to DB ────────────────────
// accountsServer: raw value of accounts-server param from Zoho callback.
async function exchangeCodeAndSave(code, userId, accountsServer) {
  // Normalize to origin to strip any trailing path/query
  const normalizedAccountsServer = new URL(accountsServer).origin;

  const creds = await getEffectiveCreds(userId);

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  creds.redirectUri,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  });

  const tokenRes = await fetch(`${normalizedAccountsServer}/oauth/v2/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) {
    throw new Error(`Token exchange failed: ${tokens.error || JSON.stringify(tokens)}`);
  }

  const apiDomain = tokens.api_domain;
  if (!apiDomain) throw new Error("Zoho token response missing api_domain");

  const mailBase = getMailBase(normalizedAccountsServer);

  // Fetch Zoho account ID and email address
  const accountsRes = await fetch(`${mailBase}/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${tokens.access_token}` },
  });
  const accountsData = await accountsRes.json();
  if (!accountsRes.ok || !accountsData.data?.length) {
    throw new Error("Failed to fetch Zoho account info: " + JSON.stringify(accountsData));
  }

  const zohoAccountId = String(accountsData.data[0].accountId);
  const email         = accountsData.data[0].emailAddress?.[0]?.mailId || null;

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  try {
    await pool.query(
      `INSERT INTO user_zoho_tokens
         (user_id, tenant_id, access_token, refresh_token, expires_at, email,
          api_domain, accounts_server, zoho_account_id, last_fetched_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         access_token    = EXCLUDED.access_token,
         refresh_token   = COALESCE(EXCLUDED.refresh_token, user_zoho_tokens.refresh_token),
         expires_at      = EXCLUDED.expires_at,
         email           = EXCLUDED.email,
         api_domain      = EXCLUDED.api_domain,
         accounts_server = EXCLUDED.accounts_server,
         zoho_account_id = EXCLUDED.zoho_account_id,
         last_fetched_at = NOW(),
         updated_at      = NOW()`,
      [userId, creds.tenantId, tokens.access_token, tokens.refresh_token || null,
       expiresAt, email, apiDomain, normalizedAccountsServer, zohoAccountId],
    );
  } catch (err) {
    // ON CONFLICT (user_id) only covers "same user reconnecting" — this account's
    // email may already belong to a DIFFERENT user (unique index, migration 0210).
    if (err.code === "23505" && err.constraint === "user_zoho_tokens_email_unique") {
      throw new MailboxAlreadyConnectedError("zoho");
    }
    throw err;
  }

  return { email };
}

// ── Refresh access token if expired ──────────────────────────────────────────
async function refreshIfNeeded(userId, row, creds) {
  if (!row.expires_at) return row.access_token;
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAtMs - 60_000) return row.access_token;

  if (!row.refresh_token) throw new Error("Brak refresh_token — połącz konto Zoho ponownie.");

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: row.refresh_token,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await fetch(`${row.accounts_server}/oauth/v2/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await res.json();
  if (!res.ok || tokens.error) {
    throw new Error(`Token refresh failed: ${tokens.error || JSON.stringify(tokens)}`);
  }

  const refreshedExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await pool.query(
    `UPDATE user_zoho_tokens SET
       access_token  = $1,
       refresh_token = COALESCE($2, refresh_token),
       expires_at    = $3,
       updated_at    = NOW()
     WHERE user_id = $4`,
    [tokens.access_token, tokens.refresh_token || null, refreshedExpiresAt, userId],
  );

  return tokens.access_token;
}

// ── Get a valid access token + account info for a user ───────────────────────
async function getTokenRow(userId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at, accounts_server,
            zoho_account_id, email
     FROM user_zoho_tokens WHERE user_id = $1`,
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Zoho. Zaloguj się przez OAuth.");
  const creds = await getEffectiveCreds(userId);
  const accessToken = await refreshIfNeeded(userId, rows[0], creds);
  return { accessToken, row: rows[0] };
}

// ── Status ────────────────────────────────────────────────────────────────────
async function getStatus(userId) {
  const { rows } = await pool.query(
    "SELECT email FROM user_zoho_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) return { connected: false };
  return { connected: true, email: rows[0].email };
}

// ── Disconnect — best-effort remote revoke, always delete local token ─────────
async function disconnect(userId) {
  const { rows } = await pool.query(
    "SELECT refresh_token, accounts_server FROM user_zoho_tokens WHERE user_id = $1",
    [userId],
  );
  if (rows.length && rows[0].refresh_token) {
    try {
      await fetch(
        `${rows[0].accounts_server}/oauth/v2/token/revoke?token=${encodeURIComponent(rows[0].refresh_token)}`,
        { method: "POST" },
      );
    } catch (_) {}
  }
  await pool.query("DELETE FROM user_zoho_tokens WHERE user_id = $1", [userId]);
}

// ── Email signature (mirrors gmailService / outlookService) ──────────────────
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

// ── Upload one attachment ahead of send ───────────────────────────────────────
// Zoho Mail requires attachments to be uploaded separately first — the send/
// reply endpoints don't take raw file bytes, only a reference to an already-
// uploaded file (storeName/attachmentName/attachmentPath). Same reference
// shape works for both new messages and replies (confirmed against the live
// API — unlike Outlook, Zoho's reply endpoint accepts attachments directly,
// no separate post-creation step needed).
async function uploadAttachment(accessToken, mailBase, accountId, filename, buffer) {
  const res = await fetch(
    `${mailBase}/accounts/${accountId}/messages/attachments?fileName=${encodeURIComponent(filename)}&isInline=false`,
    {
      method:  "POST",
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/octet-stream" },
      body:    buffer,
    },
  );
  const data = await res.json();
  if (!res.ok || (data.status?.code && data.status.code !== 200)) {
    throw new Error(`Zoho attachment upload failed: ${data.data?.errorMessage || data.status?.description || res.status}`);
  }
  return data.data; // { storeName, attachmentName, attachmentPath }
}

// ── Send email (new message or reply, with optional attachments) ────────────
// inReplyTo: Zoho numeric messageId of the message being replied to.
//   When present → POST .../messages/{messageId} with action=Reply.
//   When absent  → POST .../messages (new thread).
async function sendEmail({ userId, to, cc, subject, body, inReplyTo = null, attachments = [] }) {
  const signatureHtml = await buildSignatureHtml(userId);
  const fullBody = (body || "") + (signatureHtml || "");

  const { accessToken, row } = await getTokenRow(userId);
  const mailBase = getMailBase(row.accounts_server);
  const accountId = row.zoho_account_id;
  const fromAddress = row.email;

  const uploadedAttachments = [];
  for (const att of attachments) {
    uploadedAttachments.push(await uploadAttachment(accessToken, mailBase, accountId, att.filename, Buffer.from(att.data, "base64")));
  }

  let url, reqBody;

  if (inReplyTo) {
    url = `${mailBase}/accounts/${accountId}/messages/${inReplyTo}`;
    reqBody = {
      action:     "reply",
      fromAddress,
      toAddress:  to,
      subject,
      content:    fullBody,
      mailFormat: "html",
    };
  } else {
    url = `${mailBase}/accounts/${accountId}/messages`;
    reqBody = {
      fromAddress,
      toAddress:  to,
      subject,
      content:    fullBody,
      mailFormat: "html",
    };
  }

  if (cc?.trim()) reqBody.ccAddress = cc;
  if (uploadedAttachments.length) reqBody.attachments = uploadedAttachments;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      Authorization:  `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  const data = await res.json();
  if (!res.ok || (data.status?.code && data.status.code !== 200)) {
    const parts = [
      `HTTP ${res.status}`,
      data.status?.code        != null ? `code=${data.status.code}`               : null,
      data.status?.description          ? `desc="${data.status.description}"`      : null,
      data.data?.errorCode              ? `errorCode=${data.data.errorCode}`       : null,
      data.data?.errorMessage           ? `msg="${data.data.errorMessage}"`        : null,
      data.data?.moreInfo               ? `moreInfo="${data.data.moreInfo}"`       : null,
    ].filter(Boolean).join(" | ");
    throw new Error(`Zoho send failed: ${parts}`);
  }

  const messageId = String(data.data?.messageId || data.data?.msgId || "");
  // For replies Zoho does not always return threadId — never use messageId as threadId fallback
  // because they are different identifiers. Return null so the route can use the verified
  // canonical threadId passed by the caller.
  const threadId = data.data?.threadId
    ? String(data.data.threadId)
    : inReplyTo ? null : messageId;

  return { messageId, threadId };
}

// ── List non-inline attachment metadata for a single message ─────────────────
// Zoho's attachmentinfo response has no MIME type field — default applied,
// same fallback other providers use when a type can't be determined.
async function listMessageAttachments(accessToken, mailBase, accountId, folderId, messageId) {
  const res = await fetch(
    `${mailBase}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.data?.attachments || []).map(a => ({
    filename:     a.attachmentName,
    mimeType:     "application/octet-stream",
    attachmentId: a.attachmentId,
    size:         a.attachmentSize,
  }));
}

// ── Download attachment content ───────────────────────────────────────────────
// Unlike Gmail/Outlook, Zoho's download URL is scoped by folder — folderId is
// not tracked in crm_email_attachments (generic across all three providers),
// so it defaults to Inbox when not supplied, same fallback getThread already
// uses per-message. Received attachments (the only ones ever fetched through
// this path — sent ones are served from our own blob storage) are always
// there in practice.
async function getAttachmentBuffer(userId, messageId, attachmentId, folderId = null) {
  const { accessToken, row } = await getTokenRow(userId);
  const mailBase  = getMailBase(row.accounts_server);
  const accountId = row.zoho_account_id;
  const resolvedFolderId = folderId || await getInboxFolderId(mailBase, accountId, accessToken);

  const res = await fetch(
    `${mailBase}/accounts/${accountId}/folders/${resolvedFolderId}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Pobieranie załącznika Zoho failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Fetch a single message (parsed) ───────────────────────────────────────────
// Used by zohoProcessor.js — messages/view (used by getNewMessages) only
// returns summaries, so full content/attachments need this separate fetch.
async function getMessage(userId, messageId, folderId = null) {
  const { accessToken, row } = await getTokenRow(userId);
  const mailBase  = getMailBase(row.accounts_server);
  const accountId = row.zoho_account_id;
  const resolvedFolderId = folderId || await getInboxFolderId(mailBase, accountId, accessToken);

  const detailsRes = await fetch(
    `${mailBase}/accounts/${accountId}/folders/${resolvedFolderId}/messages/${messageId}/details`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );
  if (!detailsRes.ok) {
    const err = await detailsRes.json().catch(() => ({}));
    throw new Error(`Pobieranie wiadomości Zoho failed: ${err.data?.errorMessage || detailsRes.status}`);
  }
  const details = (await detailsRes.json()).data || {};

  const contentRes = await fetch(
    `${mailBase}/accounts/${accountId}/folders/${resolvedFolderId}/messages/${messageId}/content`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );
  const contentJson  = await contentRes.json().catch(() => ({}));
  const fullContent  = contentJson.data?.content || details.summary || "";
  const { cleanBody, quotedBody } = stripZohoQuotedContent(fullContent);

  const userEmail    = normalizeEmailAddr(row.email || '');
  const attachments  = (details.hasAttachment === "1" || details.hasAttachment === 1)
    ? await listMessageAttachments(accessToken, mailBase, accountId, resolvedFolderId, messageId)
    : [];

  return {
    id:              String(details.messageId || messageId),
    threadId:        String(details.threadId || messageId),
    subject:         details.subject || "",
    from:            details.fromAddress || "",
    to:              details.toAddress || "",
    cc:              details.ccAddress && details.ccAddress !== "Not Provided" ? details.ccAddress : "",
    date:            new Date(parseInt(details.receivedTime, 10) || Date.now()).toISOString(),
    snippet:         details.summary || "",
    body:            fullContent,
    cleanBody,
    quotedBody,
    isOutgoing:      userEmail !== '' && normalizeEmailAddr(details.fromAddress) === userEmail,
    messageIdHeader: String(details.messageId || messageId),
    attachments,
  };
}

// ── Fetch thread messages ─────────────────────────────────────────────────────
// Uses messages/view with threadId + includesent=true so sent messages appear too.
// Content is fetched per-message using the message's own folderId.
// receivedTime comes from messages/view (camelCase T).
async function getThread(userId, threadId) {
  const { accessToken, row } = await getTokenRow(userId);
  const mailBase  = getMailBase(row.accounts_server);
  const accountId = row.zoho_account_id;

  const inboxFolderId = await getInboxFolderId(mailBase, accountId, accessToken);

  const threadRes = await fetch(
    `${mailBase}/accounts/${accountId}/messages/view?threadId=${encodeURIComponent(threadId)}&folderId=${encodeURIComponent(inboxFolderId)}&includesent=true&limit=50`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
  );

  if (!threadRes.ok) {
    const err = await threadRes.json().catch(() => ({}));
    throw new Error(`Pobieranie wątku Zoho failed: ${err.data?.errorMessage || threadRes.status}`);
  }

  const threadData = await threadRes.json();
  const messages   = threadData.data || [];

  // Fetch full content (and attachment metadata, if any) per message using
  // its own folderId; fall back to summary on error.
  const withContent = await Promise.all(messages.map(async (msg) => {
    const msgFolderId = msg.folderId || inboxFolderId;
    let fullContent = msg.summary || "";
    try {
      const contentRes = await fetch(
        `${mailBase}/accounts/${accountId}/folders/${encodeURIComponent(msgFolderId)}/messages/${encodeURIComponent(msg.messageId)}/content`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
      );
      const contentData = await contentRes.json();
      fullContent = contentData.data?.content || fullContent;
    } catch (_) { /* fall back to summary already set above */ }

    let attachmentList = [];
    if (msg.hasAttachment === "1" || msg.hasAttachment === 1) {
      attachmentList = await listMessageAttachments(accessToken, mailBase, accountId, msgFolderId, msg.messageId).catch(() => []);
    }

    return { ...msg, fullContent, attachmentList };
  }));

  const userEmail = normalizeEmailAddr(row.email || '');

  // messages/view returns receivedTime (camelCase T)
  return withContent
    .sort((a, b) => parseInt(a.receivedTime, 10) - parseInt(b.receivedTime, 10))
    .map(m => {
      const fullContent = m.fullContent || '';
      const { cleanBody, quotedBody } = stripZohoQuotedContent(fullContent);

      return {
        id:              String(m.messageId),
        threadId:        String(m.threadId || threadId),
        subject:         m.subject || "",
        from:            m.fromAddress || "",
        to:              m.toAddress || "",
        cc:              m.ccAddress || "",
        date:            new Date(parseInt(m.receivedTime, 10)).toISOString(),
        snippet:         m.summary || "",
        body:            fullContent,
        cleanBody,
        quotedBody,
        isOutgoing:      userEmail !== '' && normalizeEmailAddr(m.fromAddress) === userEmail,
        // Zoho numeric messageId stored here so the frontend can pass it as inReplyTo
        messageIdHeader: String(m.messageId),
        attachments:     m.attachmentList || [],
      };
    });
}

// ── Manual sync — fetch new messages since last_fetched_at ───────────────────
// Paginates messages/view newest-first and stops when hitting older messages.
// Deduplication is done by caller (crm_lead_activities.gmail_message_id).
// last_fetched_at is set to pollStart (before first API call) to avoid race window.
async function getNewMessages(userId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at, accounts_server,
            zoho_account_id, last_fetched_at
     FROM user_zoho_tokens WHERE user_id = $1`,
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Zoho.");

  const row = rows[0];
  const creds = await getEffectiveCreds(userId);
  const accessToken = await refreshIfNeeded(userId, row, creds);
  const mailBase  = getMailBase(row.accounts_server);
  const accountId = row.zoho_account_id;

  const lastFetchedAtMs = row.last_fetched_at
    ? new Date(row.last_fetched_at).getTime()
    : null;

  // Safety net: if last_fetched_at somehow wasn't set during OAuth, set it now
  if (!lastFetchedAtMs) {
    await pool.query(
      "UPDATE user_zoho_tokens SET last_fetched_at = NOW(), updated_at = NOW() WHERE user_id = $1",
      [userId],
    );
    return { newMessages: [] };
  }

  // Fetch INBOX folder ID dynamically; folderType is a string 'Inbox' per Zoho API v1.
  const inboxFolderId = await getInboxFolderId(mailBase, accountId, accessToken);

  const pollStart  = Date.now();
  const newMessages = [];
  let start = 1;
  let done  = false;

  while (!done) {
    const res = await fetch(
      `${mailBase}/accounts/${accountId}/messages/view?folderId=${encodeURIComponent(inboxFolderId)}&sortBy=date&sortorder=false&limit=200&start=${start}`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Zoho messages/view failed: ${err.data?.errorMessage || res.status}`);
    }

    const data  = await res.json();
    const page  = data.data || [];

    if (!page.length) break;

    for (const msg of page) {
      // messages/view returns receivedTime (camelCase T)
      const msgTimeMs = parseInt(msg.receivedTime, 10);
      if (msgTimeMs <= lastFetchedAtMs) {
        done = true;
        break;
      }
      newMessages.push(msg);
    }

    if (!done && page.length === 200) {
      start += 200;
    } else {
      done = true;
    }
  }

  await pool.query(
    "UPDATE user_zoho_tokens SET last_fetched_at = $1, updated_at = NOW() WHERE user_id = $2",
    [new Date(pollStart), userId],
  );

  return { newMessages };
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
};
