"use strict";
// src/services/yandexService.js
//
// Yandex Mail provider. Implements the same contract as gmailService /
// outlookService / zohoService — see the header of config/email-providers.js.
//
// STAGE 1 (this file, today): OAuth only — connect, status, disconnect, token
// refresh. Everything that touches mail itself throws NotImplementedError and is
// delivered in stage 2, together with the imapflow/mailparser dependencies.
//
// Why the split: Yandex has no public mail REST API. Gmail, Outlook and Zoho are
// all HTTPS/JSON, so their services need no transport dependency; Yandex needs an
// IMAP client plus a MIME parser. The OAuth half needs neither, so it ships and
// can be tested end to end first.
//
// Two things differ from zohoService and are the reason this is simpler:
//   - No data centre resolution. Zoho stores accounts_server/api_domain per user
//     and maps nine regional hosts; Yandex serves every mailbox, @yandex.by and
//     @yandex.ru included, from one set of endpoints.
//   - The identity call is Yandex ID, not a mail endpoint: the token response
//     carries no address, so the connected mailbox is read from login.yandex.ru.

const crypto   = require("crypto");
const { pool } = require("../config/database");
const config   = require("../config");
const { decrypt } = require("../utils/encrypt");
const yandexDemo = require("./yandexDemo");
const {
  ProviderNotConfiguredError,
  IncompleteProviderConfigError,
  MailboxAlreadyConnectedError,
} = require("../utils/providerErrors");

const ALLOW_ENV_FALLBACK = config.isDev && process.env.ALLOW_ENV_EMAIL_FALLBACK === "true";

// ── Endpoints ────────────────────────────────────────────────────────────────
// One set for every regional mailbox — nothing per-account to resolve.
const OAUTH_AUTHORIZE_URL = "https://oauth.yandex.com/authorize";
const OAUTH_TOKEN_URL     = "https://oauth.yandex.com/token";
const OAUTH_REVOKE_URL    = "https://oauth.yandex.com/revoke_token";
const USER_INFO_URL       = "https://login.yandex.ru/info?format=json";

// Least privilege: CRMtree reads the mailbox and sends, it never deletes, so we
// ask for imap_ro rather than imap_full. Consequence to keep in mind in stage 2:
// read-only IMAP cannot write the \Seen flag back to Yandex. CRMtree tracks read
// state in its own crm_lead_activities.is_read, so nothing needs it today —
// requesting imap_full would only widen what the customer has to consent to.
const OAUTH_SCOPES = ["login:email", "mail:imap_ro", "mail:smtp"].join(" ");

class NotImplementedError extends Error {
  constructor(operation) {
    super(
      `Yandex: ${operation} nie jest jeszcze dostępne — skrzynkę można podłączyć, ` +
      `ale odbieranie i wysyłka poczty zostaną uruchomione w kolejnym etapie.`,
    );
    this.name   = "NotImplementedError";
    this.status = 501;
  }
}

// ── Per-tenant Yandex credentials from DB ────────────────────────────────────
async function getTenantYandexCreds(tenantId) {
  if (!tenantId) return null;
  const { rows } = await pool.query(
    `SELECT client_id, client_secret, redirect_uri
     FROM tenant_email_providers
     WHERE tenant_id = $1 AND provider = 'yandex' AND is_enabled = true`,
    [tenantId],
  );
  if (!rows.length) return null;

  const missing = ["client_id", "client_secret", "redirect_uri"].filter((f) => !rows[0][f]);
  if (missing.length) throw new IncompleteProviderConfigError("yandex", missing);

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

  const db = await getTenantYandexCreds(row.tenant_id);
  if (!db && !ALLOW_ENV_FALLBACK) throw new ProviderNotConfiguredError("yandex");

  return {
    tenantId:     row.tenant_id,
    clientId:     db ? db.client_id     : config.yandex.clientId,
    clientSecret: db ? db.client_secret : config.yandex.clientSecret,
    redirectUri:  db ? db.redirect_uri  : config.yandex.redirectUri,
  };
}

// ── HMAC-signed OAuth state (same pattern as gmail/outlook/zohoService) ───────
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

// ── Demo mode (client_id = "demo", see services/yandexDemo.js) ───────────────
async function isDemoUser(userId) {
  try {
    const creds = await getEffectiveCreds(userId);
    return yandexDemo.isDemoClientId(creds.clientId);
  } catch (_) {
    return false;
  }
}

// ── OAuth2 authorization URL ─────────────────────────────────────────────────
async function getAuthUrl(userId) {
  const creds = await getEffectiveCreds(userId);

  // Demo: there is no Yandex consent screen to send the user to — connect the
  // synthetic mailbox right away and land on the same callback page a real
  // connection ends on.
  if (yandexDemo.isDemoClientId(creds.clientId)) {
    await yandexDemo.connectDemoMailbox(userId, creds.tenantId);
    return `${config.frontendUrl}/crm/yandex/callback?status=connected`;
  }

  const params = new URLSearchParams({
    client_id:     creds.clientId,
    response_type: "code",
    redirect_uri:  creds.redirectUri,
    scope:         OAUTH_SCOPES,
    state:         makeOAuthState(userId),
    // Yandex reuses a previous consent silently; without this a user who
    // connected the wrong mailbox cannot pick another one without revoking the
    // app in their Yandex account first.
    force_confirm: "yes",
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// ── Read the connected address from Yandex ID ────────────────────────────────
// The token response carries no address, so this is a separate call. Needs the
// login:email scope.
async function fetchAccountEmail(accessToken) {
  const res  = await fetch(USER_INFO_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(`Nie udało się pobrać danych konta Yandex: ${res.status}`);
  }
  // default_email is the mailbox the account sends from; emails[] is the full
  // list. Fall back through both before giving up.
  return data.default_email || (Array.isArray(data.emails) ? data.emails[0] : null) || null;
}

// ── Exchange authorization code for tokens and save to DB ────────────────────
async function exchangeCodeAndSave(code, userId) {
  const creds = await getEffectiveCreds(userId);

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri:  creds.redirectUri,
  });

  const tokenRes = await fetch(OAUTH_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) {
    throw new Error(
      `Token exchange failed: ${tokens.error_description || tokens.error || JSON.stringify(tokens)}`,
    );
  }

  const email = await fetchAccountEmail(tokens.access_token);

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  try {
    await pool.query(
      `INSERT INTO user_yandex_tokens
         (user_id, tenant_id, access_token, refresh_token, expires_at, email,
          last_fetched_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         access_token    = EXCLUDED.access_token,
         refresh_token   = COALESCE(EXCLUDED.refresh_token, user_yandex_tokens.refresh_token),
         expires_at      = EXCLUDED.expires_at,
         email           = EXCLUDED.email,
         last_fetched_at = NOW(),
         updated_at      = NOW()`,
      [userId, creds.tenantId, tokens.access_token, tokens.refresh_token || null, expiresAt, email],
    );
  } catch (err) {
    // ON CONFLICT (user_id) only covers "same user reconnecting" — this mailbox
    // may already belong to a DIFFERENT user (user_yandex_tokens_email_unique).
    if (err.code === "23505" && err.constraint === "user_yandex_tokens_email_unique") {
      throw new MailboxAlreadyConnectedError("yandex");
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

  if (!row.refresh_token) throw new Error("Brak refresh_token — połącz konto Yandex ponownie.");

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: row.refresh_token,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const tokens = await res.json();
  if (!res.ok || tokens.error) {
    throw new Error(
      `Token refresh failed: ${tokens.error_description || tokens.error || JSON.stringify(tokens)}`,
    );
  }

  const refreshedExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await pool.query(
    `UPDATE user_yandex_tokens SET
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
// Stage 2 builds the IMAP/SMTP XOAUTH2 string from accessToken + row.email.
async function getTokenRow(userId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at, email, uid_validity,
            last_uid, last_fetched_at
     FROM user_yandex_tokens WHERE user_id = $1`,
    [userId],
  );
  if (!rows.length) throw new Error("Brak połączonego konta Yandex. Zaloguj się przez OAuth.");
  const creds = await getEffectiveCreds(userId);
  const accessToken = await refreshIfNeeded(userId, rows[0], creds);
  return { accessToken, row: rows[0] };
}

// ── Status ───────────────────────────────────────────────────────────────────
async function getStatus(userId) {
  const { rows } = await pool.query(
    "SELECT email FROM user_yandex_tokens WHERE user_id = $1",
    [userId],
  );
  if (!rows.length) return { connected: false };
  return { connected: true, email: rows[0].email };
}

// ── Disconnect — best-effort remote revoke, always delete local token ─────────
async function disconnect(userId) {
  const { rows } = await pool.query(
    "SELECT access_token FROM user_yandex_tokens WHERE user_id = $1",
    [userId],
  );
  // A demo mailbox was never issued by Yandex — nothing to revoke there.
  if (rows.length && rows[0].access_token && !(await isDemoUser(userId))) {
    try {
      const creds = await getEffectiveCreds(userId);
      await fetch(OAUTH_REVOKE_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({
          access_token:  rows[0].access_token,
          client_id:     creds.clientId,
          client_secret: creds.clientSecret,
        }).toString(),
      });
    } catch (_) {
      // Revoking is best effort — a dead remote call must not strand the local
      // row, otherwise the user can never reconnect.
    }
  }
  await pool.query("DELETE FROM user_yandex_tokens WHERE user_id = $1", [userId]);
}

// ── Stage 2: IMAP/SMTP ───────────────────────────────────────────────────────
// Deliberately explicit rather than silently returning empty results, so a
// misconfigured tenant fails loudly instead of looking like an empty mailbox.
async function sendEmail()          { throw new NotImplementedError("wysyłka wiadomości"); }
async function getThread()          { throw new NotImplementedError("pobieranie wątku"); }
async function getMessage()         { throw new NotImplementedError("pobieranie wiadomości"); }
async function getAttachmentBuffer(){ throw new NotImplementedError("pobieranie załącznika"); }
async function getNewMessages()     { throw new NotImplementedError("synchronizacja poczty"); }

module.exports = {
  makeOAuthState,
  parseOAuthState,
  getAuthUrl,
  exchangeCodeAndSave,
  getStatus,
  disconnect,
  isDemoUser,
  getTokenRow,
  sendEmail,
  getThread,
  getMessage,
  getAttachmentBuffer,
  getNewMessages,
  NotImplementedError,
};
