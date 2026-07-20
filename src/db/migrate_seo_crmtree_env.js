'use strict';
/**
 * One-off SEO data promotion for the 'crmtree' tenant (id fixed across every
 * environment: 4a299a1b-9e33-43d7-b649-ead5a17d61fc) between two separate
 * databases — NOT a merge between tenants (crmtree-gold is untouched, it's
 * the template tenant for future client environments).
 *
 * The tenant row itself, its feature flag, and the SEO permission group
 * already exist identically in every environment (seeded by migrations
 * 0199-0210). What does NOT exist anywhere but where you actually used the
 * panel is runtime data: business_description/settings edits made via the
 * tenant settings UI, custom pillars, generated articles (+ header image
 * URLs), keywords, competitors, internal links, metrics, backlinks and
 * social posts. That's what this script promotes from one environment's DB
 * to another's.
 *
 * Deliberately NOT migrated: tenant_gsc_tokens, tenant_social_accounts,
 * tenant_wordpress_connections. Those are OAuth credentials / a WordPress
 * site target tied to a specific environment's callback URL and, in the
 * WordPress case, potentially a test site — carrying them over could
 * silently misconnect the new environment (or worse, let a stale test
 * connection publish somewhere unintended). Reconnect each of these by hand
 * per environment via the SEO settings panel after running this script.
 *
 * Usage (dry run by default — reports counts, writes nothing):
 *   SRC_DB_HOST=localhost SRC_DB_NAME=crmtree SRC_DB_USER=postgres SRC_DB_PASSWORD=... \
 *   DST_DB_HOST=crmtree-db.postgres.database.azure.com DST_DB_NAME=<int_or_prod_db> \
 *   DST_DB_USER=crmtreeadmin DST_DB_PASSWORD=... DST_DB_SSL=true \
 *   node src/db/migrate_seo_crmtree_env.js
 *
 * Add --apply to actually write. Same script, same tenant id, run it twice:
 * once local->int, once (later, after verifying int) int->prod — just swap
 * which env vars point at SRC vs DST.
 *
 * Safe to re-run: every write is an upsert keyed on the table's natural
 * identity (slug, name, url, content+platform, etc.), so running it again
 * after adding more local content just promotes the delta.
 */

require('dotenv').config();
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env.local'),
  override: true,
});

const { Pool } = require('pg');

const TENANT_ID = '4a299a1b-9e33-43d7-b649-ead5a17d61fc'; // 'crmtree' tenant — same id in every environment

const APPLY = process.argv.includes('--apply');

function buildPool(prefix) {
  const host = process.env[`${prefix}_DB_HOST`];
  const database = process.env[`${prefix}_DB_NAME`];
  const user = process.env[`${prefix}_DB_USER`];
  if (!host || !database || !user) {
    throw new Error(
      `Missing ${prefix}_DB_HOST/${prefix}_DB_NAME/${prefix}_DB_USER env vars`,
    );
  }
  return new Pool({
    host,
    port: parseInt(process.env[`${prefix}_DB_PORT`] || '5432', 10),
    database,
    user,
    password: process.env[`${prefix}_DB_PASSWORD`],
    ssl: process.env[`${prefix}_DB_SSL`] === 'true' ? { rejectUnauthorized: false } : false,
  });
}

async function assertTenantExists(pool, label) {
  const { rows } = await pool.query('SELECT slug FROM tenants WHERE id = $1', [TENANT_ID]);
  if (rows.length === 0) {
    throw new Error(
      `${label}: tenant ${TENANT_ID} ('crmtree') not found. Deploy the backend ` +
      `(migrations 0199-0210) to this environment first, so the tenant + seo_* ` +
      `schema exist, then re-run.`,
    );
  }
  return rows[0].slug;
}

async function migrateTenantSettings(src, dst, stats) {
  const { rows } = await src.query(
    `SELECT business_description, industry_vertical, seo_daily_article_limit,
            seo_backlinks_opt_in, wordpress_publish_mode
       FROM tenants WHERE id = $1`,
    [TENANT_ID],
  );
  const s = rows[0];
  stats.tenantSettings = 1;
  if (!APPLY) return;
  await dst.query(
    `UPDATE tenants
        SET business_description = $1, industry_vertical = $2, seo_daily_article_limit = $3,
            seo_backlinks_opt_in = $4, wordpress_publish_mode = $5
      WHERE id = $6`,
    [s.business_description, s.industry_vertical, s.seo_daily_article_limit,
     s.seo_backlinks_opt_in, s.wordpress_publish_mode, TENANT_ID],
  );
}

async function migratePillars(src, dst, stats) {
  const { rows } = await src.query(
    `SELECT id, name, description, target_keyword_theme, priority, generated_at
       FROM seo_content_pillars WHERE tenant_id = $1 ORDER BY id`,
    [TENANT_ID],
  );
  const idMap = new Map(); // src pillar id -> dst pillar id
  stats.pillars = rows.length;
  for (const p of rows) {
    const existing = await dst.query(
      'SELECT id FROM seo_content_pillars WHERE tenant_id = $1 AND name = $2',
      [TENANT_ID, p.name],
    );
    if (existing.rows.length > 0) {
      idMap.set(p.id, existing.rows[0].id);
      if (APPLY) {
        await dst.query(
          `UPDATE seo_content_pillars
              SET description = $1, target_keyword_theme = $2, priority = $3, generated_at = $4
            WHERE id = $5`,
          [p.description, p.target_keyword_theme, p.priority, p.generated_at, existing.rows[0].id],
        );
      }
    } else if (APPLY) {
      const inserted = await dst.query(
        `INSERT INTO seo_content_pillars (tenant_id, name, description, target_keyword_theme, priority, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [TENANT_ID, p.name, p.description, p.target_keyword_theme, p.priority, p.generated_at],
      );
      idMap.set(p.id, inserted.rows[0].id);
    }
  }
  return idMap;
}

async function migrateContentPieces(src, dst, stats) {
  const { rows } = await src.query(
    `SELECT id, locale, title, slug, body, meta_description, status, target_keyword, category,
            header_image_url, scheduled_at, published_at, generation_cost_usd, created_at, updated_at
       FROM seo_content_pieces WHERE tenant_id = $1 ORDER BY id`,
    [TENANT_ID],
  );
  const idMap = new Map(); // src content id -> dst content id
  stats.contentPieces = rows.length;
  for (const c of rows) {
    if (!APPLY) continue;
    const result = await dst.query(
      `INSERT INTO seo_content_pieces
         (tenant_id, locale, title, slug, body, meta_description, status, target_keyword, category,
          header_image_url, scheduled_at, published_at, generation_cost_usd, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant_id, locale, slug) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body, meta_description = EXCLUDED.meta_description,
             status = EXCLUDED.status, target_keyword = EXCLUDED.target_keyword, category = EXCLUDED.category,
             header_image_url = EXCLUDED.header_image_url, scheduled_at = EXCLUDED.scheduled_at,
             published_at = EXCLUDED.published_at, generation_cost_usd = EXCLUDED.generation_cost_usd,
             updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [TENANT_ID, c.locale, c.title, c.slug, c.body, c.meta_description, c.status, c.target_keyword,
       c.category, c.header_image_url, c.scheduled_at, c.published_at, c.generation_cost_usd,
       c.created_at, c.updated_at],
    );
    idMap.set(c.id, result.rows[0].id);
  }
  if (!APPLY) {
    // Dry run still needs a best-effort map (by slug+locale) so dependent-table counts are meaningful.
    for (const c of rows) {
      const existing = await dst.query(
        'SELECT id FROM seo_content_pieces WHERE tenant_id = $1 AND locale = $2 AND slug = $3',
        [TENANT_ID, c.locale, c.slug],
      );
      idMap.set(c.id, existing.rows[0]?.id ?? null);
    }
  }
  return idMap;
}

async function migrateKeywords(src, dst, contentIdMap, pillarIdMap, stats) {
  const { rows } = await src.query(
    `SELECT phrase, source, content_id, priority, pillar_id
       FROM seo_keywords WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  stats.keywords = { total: rows.length, applied: 0 };
  for (const k of rows) {
    const contentId = k.content_id != null ? (contentIdMap.get(k.content_id) ?? null) : null;
    const pillarId = k.pillar_id != null ? (pillarIdMap.get(k.pillar_id) ?? null) : null;
    const existing = await dst.query(
      `SELECT id FROM seo_keywords
        WHERE tenant_id = $1 AND phrase = $2 AND source = $3
          AND content_id IS NOT DISTINCT FROM $4`,
      [TENANT_ID, k.phrase, k.source, contentId],
    );
    if (existing.rows.length > 0 || !APPLY) continue;
    await dst.query(
      `INSERT INTO seo_keywords (tenant_id, phrase, source, content_id, priority, pillar_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [TENANT_ID, k.phrase, k.source, contentId, k.priority, pillarId],
    );
    stats.keywords.applied++;
  }
}

async function migrateCompetitors(src, dst, stats) {
  const { rows } = await src.query('SELECT url, notes FROM seo_competitors WHERE tenant_id = $1', [TENANT_ID]);
  stats.competitors = rows.length;
  for (const c of rows) {
    const existing = await dst.query(
      'SELECT id FROM seo_competitors WHERE tenant_id = $1 AND url = $2',
      [TENANT_ID, c.url],
    );
    if (existing.rows.length > 0) {
      if (APPLY) await dst.query('UPDATE seo_competitors SET notes = $1 WHERE id = $2', [c.notes, existing.rows[0].id]);
    } else if (APPLY) {
      await dst.query('INSERT INTO seo_competitors (tenant_id, url, notes) VALUES ($1,$2,$3)', [TENANT_ID, c.url, c.notes]);
    }
  }
}

async function migrateInternalLinks(src, dst, contentIdMap, stats) {
  const { rows } = await src.query(
    'SELECT from_content_id, to_content_id, status FROM seo_internal_links WHERE tenant_id = $1',
    [TENANT_ID],
  );
  stats.internalLinks = { total: rows.length, applied: 0 };
  for (const l of rows) {
    const fromId = contentIdMap.get(l.from_content_id);
    const toId = contentIdMap.get(l.to_content_id);
    if (!fromId || !toId) continue; // referenced article wasn't migrated (shouldn't happen, but stay safe)
    const existing = await dst.query(
      'SELECT id FROM seo_internal_links WHERE tenant_id = $1 AND from_content_id = $2 AND to_content_id = $3',
      [TENANT_ID, fromId, toId],
    );
    if (existing.rows.length > 0 || !APPLY) continue;
    await dst.query(
      'INSERT INTO seo_internal_links (tenant_id, from_content_id, to_content_id, status) VALUES ($1,$2,$3,$4)',
      [TENANT_ID, fromId, toId, l.status],
    );
    stats.internalLinks.applied++;
  }
}

async function migrateMetrics(src, dst, contentIdMap, stats) {
  const { rows } = await src.query(
    'SELECT content_id, date, impressions, clicks, avg_position FROM seo_metrics WHERE tenant_id = $1',
    [TENANT_ID],
  );
  stats.metrics = { total: rows.length, applied: 0 };
  for (const m of rows) {
    const contentId = contentIdMap.get(m.content_id);
    if (!contentId || !APPLY) continue;
    await dst.query(
      `INSERT INTO seo_metrics (tenant_id, content_id, date, impressions, clicks, avg_position)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (content_id, date) DO UPDATE
         SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, avg_position = EXCLUDED.avg_position`,
      [TENANT_ID, contentId, m.date, m.impressions, m.clicks, m.avg_position],
    );
    stats.metrics.applied++;
  }
}

async function migrateSocialPosts(src, dst, contentIdMap, stats) {
  const { rows } = await src.query(
    `SELECT content_id, platform, status, body, remote_post_id, remote_url, error_message, published_at
       FROM seo_social_posts WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  stats.socialPosts = { total: rows.length, applied: 0 };
  for (const p of rows) {
    const contentId = contentIdMap.get(p.content_id);
    if (!contentId || !APPLY) continue;
    await dst.query(
      `INSERT INTO seo_social_posts
         (tenant_id, content_id, platform, status, body, remote_post_id, remote_url, error_message, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (content_id, platform) DO UPDATE
         SET status = EXCLUDED.status, body = EXCLUDED.body, remote_post_id = EXCLUDED.remote_post_id,
             remote_url = EXCLUDED.remote_url, error_message = EXCLUDED.error_message,
             published_at = EXCLUDED.published_at`,
      [TENANT_ID, contentId, p.platform, p.status, p.body, p.remote_post_id, p.remote_url,
       p.error_message, p.published_at],
    );
    stats.socialPosts.applied++;
  }
}

async function migrateBacklinks(src, dst, contentIdMap, stats) {
  const { rows } = await src.query(
    `SELECT partner_tenant_id, from_content_id, to_content_id, status
       FROM seo_backlinks WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  stats.backlinks = { total: rows.length, applied: 0, skippedMissingPartner: 0 };
  for (const b of rows) {
    const fromId = contentIdMap.get(b.from_content_id);
    const toId = contentIdMap.get(b.to_content_id);
    if (!fromId || !toId) continue;
    const partnerExists = await dst.query('SELECT 1 FROM tenants WHERE id = $1', [b.partner_tenant_id]);
    if (partnerExists.rows.length === 0) {
      stats.backlinks.skippedMissingPartner++;
      continue; // partner tenant doesn't exist in this environment — nothing sane to link to
    }
    const existing = await dst.query(
      `SELECT id FROM seo_backlinks
        WHERE tenant_id = $1 AND partner_tenant_id = $2 AND from_content_id = $3 AND to_content_id = $4`,
      [TENANT_ID, b.partner_tenant_id, fromId, toId],
    );
    if (existing.rows.length > 0 || !APPLY) continue;
    await dst.query(
      `INSERT INTO seo_backlinks (tenant_id, partner_tenant_id, from_content_id, to_content_id, status)
       VALUES ($1,$2,$3,$4,$5)`,
      [TENANT_ID, b.partner_tenant_id, fromId, toId, b.status],
    );
    stats.backlinks.applied++;
  }
}

async function main() {
  const src = buildPool('SRC');
  const dst = buildPool('DST');

  const srcSlug = await assertTenantExists(src, 'SRC');
  const dstSlug = await assertTenantExists(dst, 'DST');

  console.log(`SRC: ${process.env.SRC_DB_HOST}/${process.env.SRC_DB_NAME} (tenant slug '${srcSlug}')`);
  console.log(`DST: ${process.env.DST_DB_HOST}/${process.env.DST_DB_NAME} (tenant slug '${dstSlug}')`);
  console.log(APPLY ? 'Mode: APPLY (writing)' : 'Mode: DRY RUN (no writes — pass --apply to commit)');
  console.log('Skipping (reconnect manually per environment): tenant_gsc_tokens, tenant_social_accounts, tenant_wordpress_connections\n');

  const client = APPLY ? await dst.connect() : dst;
  const stats = {};
  try {
    if (APPLY) await client.query('BEGIN');

    await migrateTenantSettings(src, client, stats);
    const pillarIdMap = await migratePillars(src, client, stats);
    const contentIdMap = await migrateContentPieces(src, client, stats);
    await migrateKeywords(src, client, contentIdMap, pillarIdMap, stats);
    await migrateCompetitors(src, client, stats);
    await migrateInternalLinks(src, client, contentIdMap, stats);
    await migrateMetrics(src, client, contentIdMap, stats);
    await migrateSocialPosts(src, client, contentIdMap, stats);
    await migrateBacklinks(src, client, contentIdMap, stats);

    if (APPLY) await client.query('COMMIT');
    console.log(JSON.stringify(stats, null, 2));
    console.log(APPLY ? '\nDone — committed.' : '\nDry run complete — re-run with --apply to write.');
  } catch (err) {
    if (APPLY) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (APPLY) client.release();
    await src.end();
    await dst.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
