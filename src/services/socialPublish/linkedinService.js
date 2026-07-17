'use strict';
// ─────────────────────────────────────────────────────────────────
// services/socialPublish/linkedinService.js — publish as the CRMtree
// LinkedIn Company Page via the Community Management API (Posts API).
//
// Requires LinkedIn approval for the Community Management API product on
// the developer app (Adam is applying for this separately) — until that's
// granted, publishPost() will fail with a 403 from LinkedIn, which is
// expected and handled the same as any other publish failure (see
// seoSocialService.publishToConnectedPlatforms).
//
// NOTE: LinkedIn versions its REST API by a "LinkedIn-Version" header
// (YYYYMM). LINKEDIN_API_VERSION below should be bumped periodically —
// check developer.linkedin.com for the current supported version before
// going live.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('../../config/database');
const config = require('../../config');
const logger = require('../../utils/logger');

const AUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com';
const LINKEDIN_API_VERSION = '202502'; // verify/bump against current LinkedIn docs
const SCOPES = ['w_organization_social', 'r_organization_admin'];

function makeOAuthState(tenantId, userId) {
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', config.jwt.secret).update(`${tenantId}:${userId}:${ts}`).digest('hex').slice(0, 16);
  return `${tenantId}.${userId}.${ts}.${sig}`;
}

function parseOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const [tenantId, userId, tsStr, sig] = state.split('.');
  const ts = parseInt(tsStr, 10);
  if (!ts || Date.now() - ts > 30 * 60 * 1000) return null;
  const expected = crypto.createHmac('sha256', config.jwt.secret).update(`${tenantId}:${userId}:${ts}`).digest('hex').slice(0, 16);
  if (sig !== expected) return null;
  return { tenantId, userId };
}

function getAuthUrl(tenantId, userId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedin.clientId,
    redirect_uri: config.linkedin.redirectUri,
    state: makeOAuthState(tenantId, userId),
    scope: SCOPES.join(' '),
  });
  return `${AUTH_BASE}/authorization?${params.toString()}`;
}

async function exchangeCodeAndSave(code, tenantId, userId) {
  const tokenRes = await fetch(`${AUTH_BASE}/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.linkedin.redirectUri,
      client_id: config.linkedin.clientId,
      client_secret: config.linkedin.clientSecret,
    }),
  });
  if (!tokenRes.ok) throw new Error(`LinkedIn token exchange failed: ${await tokenRes.text()}`);
  const tokens = await tokenRes.json();

  // Find organizations this user administers — auto-pick if there's exactly one
  // (expected case: CRMtree's own single company page). With more than one,
  // the first is used and a warning logged — a picker UI is a follow-up if
  // that ever becomes a real scenario.
  const orgsRes = await fetch(
    `${API_BASE}/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(*,organization~(localizedName)))`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!orgsRes.ok) throw new Error(`LinkedIn org lookup failed: ${await orgsRes.text()}`);
  const orgsData = await orgsRes.json();
  const orgs = orgsData.elements || [];
  if (!orgs.length) throw new Error('To konto LinkedIn nie administruje żadną firmową stroną.');
  if (orgs.length > 1) logger.warn('LinkedIn: user administers multiple orgs, picking the first', { tenantId, count: orgs.length });

  const org = orgs[0];
  const orgUrn = org.organization; // "urn:li:organization:12345"
  const orgName = org['organization~']?.localizedName ?? null;

  await db.query(
    `INSERT INTO tenant_social_accounts (tenant_id, platform, external_account_id, account_name, access_token, refresh_token, token_expires_at, connected_by, updated_at)
     VALUES ($1, 'linkedin', $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (tenant_id, platform) DO UPDATE SET
       external_account_id = EXCLUDED.external_account_id,
       account_name         = EXCLUDED.account_name,
       access_token          = EXCLUDED.access_token,
       refresh_token         = COALESCE(EXCLUDED.refresh_token, tenant_social_accounts.refresh_token),
       token_expires_at      = EXCLUDED.token_expires_at,
       connected_by          = EXCLUDED.connected_by,
       updated_at            = now()`,
    [
      tenantId,
      orgUrn,
      orgName,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      userId,
    ],
  );
}

async function getAccount(tenantId) {
  const { rows } = await db.query(
    `SELECT external_account_id, access_token FROM tenant_social_accounts WHERE tenant_id = $1 AND platform = 'linkedin'`,
    [tenantId],
  );
  if (!rows.length) return null;
  return rows[0];
}

/** Publishes as the connected Company Page. Returns { remotePostId, remoteUrl }. */
async function publishPost(tenantId, { text, articleUrl, articleTitle, articleDescription }) {
  const account = await getAccount(tenantId);
  if (!account) throw new Error('LinkedIn nie jest podłączony dla tego tenanta.');

  const body = {
    author: account.external_account_id,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { article: { source: articleUrl, title: articleTitle, description: articleDescription } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch(`${API_BASE}/rest/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LinkedIn publish failed (${res.status}): ${await res.text()}`);

  const postUrn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  const remotePostId = postUrn || null;
  const remoteUrl = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : null;
  return { remotePostId, remoteUrl };
}

module.exports = { getAuthUrl, parseOAuthState, exchangeCodeAndSave, publishPost, getAccount };
