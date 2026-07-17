"use strict";
// src/services/gscService.js
// Google Search Console — OAuth2 per-tenant (property ownership belongs to the
// business/domain, not an individual salesperson, unlike Gmail's per-user tokens).
// Mirrors the OAuth pattern in services/gmailService.js.

const { google } = require("googleapis");
const crypto = require("crypto");
const { pool } = require("../config/database");
const config = require("../config");

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.gscRedirectUri,
  );
}

// ── State: HMAC-signed "<tenantId>.<userId>.<timestamp>.<hmac>" ──────────────
function makeOAuthState(tenantId, userId) {
  const ts = Date.now();
  const sig = crypto
    .createHmac("sha256", config.jwt.secret)
    .update(`${tenantId}:${userId}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  return `${tenantId}.${userId}.${ts}.${sig}`;
}

function parseOAuthState(state) {
  if (!state || typeof state !== "string") return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [tenantId, userId, tsStr, sig] = parts;
  const ts = parseInt(tsStr, 10);
  if (!ts || isNaN(ts) || Date.now() - ts > 30 * 60 * 1000) return null;
  const expected = crypto
    .createHmac("sha256", config.jwt.secret)
    .update(`${tenantId}:${userId}:${ts}`)
    .digest("hex")
    .slice(0, 16);
  if (sig !== expected) return null;
  return { tenantId, userId };
}

function getAuthUrl(tenantId, userId) {
  const oauth2 = makeOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: makeOAuthState(tenantId, userId),
    scope: [SCOPE],
  });
}

async function exchangeCodeAndSave(code, tenantId, userId, siteUrl) {
  const oauth2 = makeOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  await pool.query(
    `INSERT INTO tenant_gsc_tokens (tenant_id, site_url, access_token, refresh_token, token_expiry, connected_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       site_url      = EXCLUDED.site_url,
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, tenant_gsc_tokens.refresh_token),
       token_expiry  = EXCLUDED.token_expiry,
       connected_by  = EXCLUDED.connected_by,
       updated_at    = now()`,
    [
      tenantId,
      siteUrl,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      userId,
    ],
  );
}

async function getAuthForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, token_expiry, site_url FROM tenant_gsc_tokens WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) throw new Error("Search Console nie jest podłączony dla tego tenanta.");

  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({
    access_token: rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date: rows[0].token_expiry ? new Date(rows[0].token_expiry).getTime() : null,
  });

  oauth2.on("tokens", async (tokens) => {
    const updates = ["access_token = $1", "updated_at = now()"];
    const params = [tokens.access_token];
    if (tokens.refresh_token) { updates.push(`refresh_token = $${params.length + 1}`); params.push(tokens.refresh_token); }
    if (tokens.expiry_date) { updates.push(`token_expiry = $${params.length + 1}`); params.push(new Date(tokens.expiry_date).toISOString()); }
    params.push(tenantId);
    await pool.query(`UPDATE tenant_gsc_tokens SET ${updates.join(", ")} WHERE tenant_id = $${params.length}`, params);
  });

  return { oauth2, siteUrl: rows[0].site_url };
}

// ── Search analytics for a single URL, stored into seo_metrics ──────────────
async function syncMetricsForContent(tenantId, contentId, pageUrl, date) {
  const { oauth2, siteUrl } = await getAuthForTenant(tenantId);
  const searchconsole = google.searchconsole({ version: "v1", auth: oauth2 });

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: date,
      endDate: date,
      dimensions: ["page"],
      dimensionFilterGroups: [{ filters: [{ dimension: "page", expression: pageUrl }] }],
    },
  });

  const row = data.rows?.[0];
  await pool.query(
    `INSERT INTO seo_metrics (tenant_id, content_id, date, impressions, clicks, avg_position)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (content_id, date) DO UPDATE SET
       impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, avg_position = EXCLUDED.avg_position`,
    [tenantId, contentId, date, row?.impressions ?? 0, row?.clicks ?? 0, row?.position ?? null],
  );
}

// ── Content-gap queries: real searches with meaningful impressions but a
// weak position — signals for what to write about next, fed into keyword
// research as real-world context alongside Claude's own suggestions ─────────
async function getContentGapQueries(tenantId, { days = 28, minImpressions = 5, minPosition = 10, limit = 20 } = {}) {
  const { oauth2, siteUrl } = await getAuthForTenant(tenantId);
  const searchconsole = google.searchconsole({ version: "v1", auth: oauth2 });

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const { data } = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ["query"],
      rowLimit: 250,
    },
  });

  return (data.rows || [])
    .filter((r) => r.impressions >= minImpressions && r.position >= minPosition)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((r) => ({ phrase: r.keys[0], impressions: r.impressions, position: Math.round(r.position * 10) / 10 }));
}

module.exports = {
  getAuthUrl,
  parseOAuthState,
  exchangeCodeAndSave,
  getAuthForTenant,
  syncMetricsForContent,
  getContentGapQueries,
};
