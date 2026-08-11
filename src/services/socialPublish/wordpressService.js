'use strict';
// ─────────────────────────────────────────────────────────────────
// services/socialPublish/wordpressService.js — publish full articles to a
// client's own WordPress site (CRMtree keeps its own native blog — this
// connector is for client tenants only, per Adam's product decision,
// 2026-07-19: "nie robimy blog per tenant... dla klientów connector do WP").
//
// Auth: WordPress Application Passwords (native since WP 5.6) — Basic Auth
// over HTTPS, no OAuth app registration needed. The client generates one in
// their own WP admin (Users → Profile → Application Passwords) and gives us
// the username + generated password.
//
// Publish mode (live "publish" vs "draft" awaiting manual publish in WP) is
// a per-tenant SuperAdmin-only setting (tenants.wordpress_publish_mode) —
// a trust decision made after talking to the client, not something the
// tenant's own editor controls. Defaults to 'draft'.
// ─────────────────────────────────────────────────────────────────

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/encrypt');

function authHeader(username, appPassword) {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}

function normalizeSiteUrl(siteUrl) {
  return siteUrl.trim().replace(/\/$/, '');
}

// Node's default fetch UA (or its absence) trips hosting WAFs (ModSecurity on
// cyberfolks.pl etc.) that block requests lacking a browser-like User-Agent —
// confirmed against a real client site, 2026-07-19 (406 "Połączenie zablokowane").
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CRMtree-SEObot/1.0; +https://crmtree.pl)',
  Accept: 'application/json',
};

/** Validates credentials against the site before storing them. Throws on failure. */
async function connect(tenantId, siteUrl, username, appPassword, userId) {
  const base = normalizeSiteUrl(siteUrl);
  let res;
  try {
    res = await fetch(`${base}/wp-json/wp/v2/users/me`, {
      headers: { ...REQUEST_HEADERS, Authorization: authHeader(username, appPassword) },
    });
  } catch (err) {
    // DNS/connection-level failure (site unreachable, wrong URL, etc.) — fetch()
    // throws rather than returning a response, so it needs its own message.
    throw new Error(`Nie udało się zweryfikować danych WordPress — strona nieosiągalna pod adresem ${base}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Nie udało się zweryfikować danych WordPress (${res.status}): ${await res.text()}`);

  await db.query(
    `INSERT INTO tenant_wordpress_connections (tenant_id, site_url, username, app_password, connected_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       site_url = EXCLUDED.site_url, username = EXCLUDED.username, app_password = EXCLUDED.app_password,
       connected_by = EXCLUDED.connected_by, updated_at = now()`,
    [tenantId, base, username, encrypt(appPassword), userId],
  );
}

async function getAccount(tenantId) {
  const { rows } = await db.query(
    `SELECT site_url, username, app_password FROM tenant_wordpress_connections WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return null;
  return { ...rows[0], app_password: decrypt(rows[0].app_password) ?? rows[0].app_password };
}

/** Downloads the image and uploads it to the WP media library. Returns the media ID, or null on any failure (non-fatal — post still publishes without a featured image). */
async function uploadMedia(account, imageUrl, filename) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Nie udało się pobrać zdjęcia (${imgRes.status})`);
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const uploadRes = await fetch(`${account.site_url}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        ...REQUEST_HEADERS,
        Authorization: authHeader(account.username, account.app_password),
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: buffer,
    });
    if (!uploadRes.ok) throw new Error(`Upload do biblioteki mediów nie powiódł się (${uploadRes.status}): ${await uploadRes.text()}`);
    const data = await uploadRes.json();
    return data.id;
  } catch (err) {
    logger.warn('WordPress media upload failed — publishing without featured image', { error: err.message });
    return null;
  }
}

/** Returns { remotePostId, remoteUrl }. */
async function publishPost(tenantId, { title, contentHtml, excerpt, imageUrl, slug }) {
  const account = await getAccount(tenantId);
  if (!account) throw new Error('WordPress nie jest podłączony dla tego tenanta.');

  const { rows: tenantRows } = await db.query(`SELECT wordpress_publish_mode FROM tenants WHERE id = $1`, [tenantId]);
  const status = tenantRows[0]?.wordpress_publish_mode === 'publish' ? 'publish' : 'draft';

  const featuredMediaId = imageUrl ? await uploadMedia(account, imageUrl, `${slug}.jpg`) : null;

  const res = await fetch(`${account.site_url}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      ...REQUEST_HEADERS,
      Authorization: authHeader(account.username, account.app_password),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      content: contentHtml,
      excerpt,
      slug,
      status,
      ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Publikacja na WordPress nie powiodła się (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { remotePostId: String(data.id), remoteUrl: data.link || null };
}

module.exports = { connect, getAccount, publishPost };
