'use strict';
// ─────────────────────────────────────────────────────────────────
// services/socialPublish/metaService.js — publish to the CRMtree Facebook
// Page and, through the same connection, its linked Instagram Business
// account. One OAuth flow (Facebook Login for Business) covers both —
// Instagram Graph API calls are authenticated with the Facebook Page's
// access token, there's no separate Instagram login.
//
// Requires Meta App Review approval for pages_manage_posts,
// pages_read_engagement, instagram_basic, instagram_content_publish —
// until granted, calls here fail with a permissions error from Meta, same
// as any other publish failure (see seoSocialService).
//
// NOTE: Graph API is versioned in the URL (v21.0 below). Bump periodically —
// Meta deprecates old versions on a schedule, check developers.facebook.com.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('../../config/database');
const config = require('../../config');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/encrypt');

const GRAPH_VERSION = 'v21.0'; // verify/bump against current Meta docs
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const AUTH_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];

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
    client_id: config.meta.appId,
    redirect_uri: config.meta.redirectUri,
    state: makeOAuthState(tenantId, userId),
    scope: SCOPES.join(','),
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeAndSave(code, tenantId, userId) {
  // 1) short-lived user token
  const shortRes = await fetch(
    `${GRAPH_BASE}/oauth/access_token?${new URLSearchParams({
      client_id: config.meta.appId,
      redirect_uri: config.meta.redirectUri,
      client_secret: config.meta.appSecret,
      code,
    })}`,
  );
  if (!shortRes.ok) throw new Error(`Meta token exchange failed: ${await shortRes.text()}`);
  const { access_token: shortToken } = await shortRes.json();

  // 2) exchange for a long-lived user token (~60 days)
  const longRes = await fetch(
    `${GRAPH_BASE}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortToken,
    })}`,
  );
  if (!longRes.ok) throw new Error(`Meta long-lived token exchange failed: ${await longRes.text()}`);
  const longData = await longRes.json();

  // 3) pages this user manages — page access tokens derived from a long-lived
  // user token don't expire on their own (only if the user token is revoked).
  const pagesRes = await fetch(`${GRAPH_BASE}/me/accounts?access_token=${longData.access_token}`);
  if (!pagesRes.ok) throw new Error(`Meta pages lookup failed: ${await pagesRes.text()}`);
  const pagesData = await pagesRes.json();
  const pages = pagesData.data || [];
  if (!pages.length) throw new Error('To konto nie zarządza żadną stroną na Facebooku.');
  if (pages.length > 1) logger.warn('Meta: user manages multiple pages, picking the first', { tenantId, count: pages.length });

  const page = pages[0];

  await db.query(
    `INSERT INTO tenant_social_accounts (tenant_id, platform, external_account_id, account_name, access_token, connected_by, updated_at)
     VALUES ($1, 'facebook', $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, platform) DO UPDATE SET
       external_account_id = EXCLUDED.external_account_id, account_name = EXCLUDED.account_name,
       access_token = EXCLUDED.access_token, connected_by = EXCLUDED.connected_by, updated_at = now()`,
    [tenantId, page.id, page.name, encrypt(page.access_token), userId],
  );

  // 4) Instagram Business account linked to this page, if any.
  const igRes = await fetch(`${GRAPH_BASE}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
  const igData = igRes.ok ? await igRes.json() : null;
  const igAccountId = igData?.instagram_business_account?.id;

  if (igAccountId) {
    await db.query(
      `INSERT INTO tenant_social_accounts (tenant_id, platform, external_account_id, account_name, access_token, connected_by, updated_at)
       VALUES ($1, 'instagram', $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, platform) DO UPDATE SET
         external_account_id = EXCLUDED.external_account_id, account_name = EXCLUDED.account_name,
         access_token = EXCLUDED.access_token, connected_by = EXCLUDED.connected_by, updated_at = now()`,
      [tenantId, igAccountId, `${page.name} (Instagram)`, encrypt(page.access_token), userId],
    );
  } else {
    logger.info('Meta: connected page has no linked Instagram Business account', { tenantId, pageId: page.id });
  }
}

async function getAccount(tenantId, platform) {
  const { rows } = await db.query(
    `SELECT external_account_id, access_token FROM tenant_social_accounts WHERE tenant_id = $1 AND platform = $2`,
    [tenantId, platform],
  );
  if (!rows.length) return null;
  return { ...rows[0], access_token: decrypt(rows[0].access_token) ?? rows[0].access_token };
}

/** Returns { remotePostId, remoteUrl }. */
async function publishToFacebook(tenantId, { text, articleUrl }) {
  const account = await getAccount(tenantId, 'facebook');
  if (!account) throw new Error('Facebook nie jest podłączony dla tego tenanta.');

  const res = await fetch(`${GRAPH_BASE}/${account.external_account_id}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: text, link: articleUrl, access_token: account.access_token }),
  });
  if (!res.ok) throw new Error(`Facebook publish failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { remotePostId: data.id, remoteUrl: data.id ? `https://www.facebook.com/${data.id}` : null };
}

/**
 * Instagram publishing is two calls: create a media container, then publish it.
 * Instagram has no text-only posts — imageUrl is required.
 */
async function publishToInstagram(tenantId, { caption, imageUrl }) {
  if (!imageUrl) throw new Error('Instagram wymaga zdjęcia — artykuł nie ma header_image_url.');
  const account = await getAccount(tenantId, 'instagram');
  if (!account) throw new Error('Instagram nie jest podłączony dla tego tenanta.');

  const createRes = await fetch(`${GRAPH_BASE}/${account.external_account_id}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: account.access_token }),
  });
  if (!createRes.ok) throw new Error(`Instagram media create failed (${createRes.status}): ${await createRes.text()}`);
  const { id: creationId } = await createRes.json();

  const publishRes = await fetch(`${GRAPH_BASE}/${account.external_account_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: account.access_token }),
  });
  if (!publishRes.ok) throw new Error(`Instagram publish failed (${publishRes.status}): ${await publishRes.text()}`);
  const { id: mediaId } = await publishRes.json();

  const permalinkRes = await fetch(`${GRAPH_BASE}/${mediaId}?fields=permalink&access_token=${account.access_token}`);
  const permalinkData = permalinkRes.ok ? await permalinkRes.json() : null;

  return { remotePostId: mediaId, remoteUrl: permalinkData?.permalink || null };
}

module.exports = { getAuthUrl, parseOAuthState, exchangeCodeAndSave, publishToFacebook, publishToInstagram, getAccount };
