'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoBacklinkService.js — cross-tenant backlink matching
// (requirements §7): opt-in, industry_vertical-gated, topical-relevance-only,
// capped per tenant pair, no forced reciprocity (tenant A linking to B does
// not require B to link back).
//
// Matching only produces something once at least two real tenants have both
// opted in and share an industry_vertical — with a single dogfooding tenant
// (CRMtree itself) this always returns an empty list, which is the correct,
// honest behavior rather than fabricated pairings.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const logger = require('../utils/logger');

const MAX_LINKS_PER_TENANT_PAIR = 3;
const MAX_SUGGESTIONS_PER_RUN = 10;

/**
 * Finds and persists (status='suggested') new cross-tenant backlink candidates
 * for a tenant: other opted-in tenants sharing the same industry_vertical,
 * matched by content pillar/category (topical relevance only — no keyword
 * overlap requirement), respecting the per-pair cap.
 */
async function findCandidates(tenantId) {
  const { rows: selfRows } = await db.query(
    `SELECT industry_vertical, seo_backlinks_opt_in FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const self = selfRows[0];
  if (!self?.seo_backlinks_opt_in) throw new Error('Tenant nie wyraził zgody na wymianę backlinków (seo_backlinks_opt_in).');
  if (!self.industry_vertical) throw new Error('Tenant nie ma ustawionego industry_vertical — wymagane do dopasowania backlinków.');

  const { rows: partners } = await db.query(
    `SELECT id FROM tenants
      WHERE id <> $1 AND seo_backlinks_opt_in = true AND industry_vertical = $2`,
    [tenantId, self.industry_vertical],
  );
  if (!partners.length) return [];

  const { rows: ownArticles } = await db.query(
    `SELECT id, category FROM seo_content_pieces WHERE tenant_id = $1 AND status = 'published'`,
    [tenantId],
  );
  if (!ownArticles.length) return [];

  const suggestions = [];
  for (const partner of partners) {
    if (suggestions.length >= MAX_SUGGESTIONS_PER_RUN) break;

    const { rows: pairCount } = await db.query(
      `SELECT COUNT(*)::int AS n FROM seo_backlinks
        WHERE (tenant_id = $1 AND partner_tenant_id = $2) OR (tenant_id = $2 AND partner_tenant_id = $1)`,
      [tenantId, partner.id],
    );
    let remaining = MAX_LINKS_PER_TENANT_PAIR - pairCount[0].n;
    if (remaining <= 0) continue;

    const { rows: partnerArticles } = await db.query(
      `SELECT id, category FROM seo_content_pieces WHERE tenant_id = $1 AND status = 'published'`,
      [partner.id],
    );

    for (const own of ownArticles) {
      if (remaining <= 0 || suggestions.length >= MAX_SUGGESTIONS_PER_RUN) break;
      const match = partnerArticles.find((p) => p.category && p.category === own.category);
      if (!match) continue;

      const { rows: exists } = await db.query(
        `SELECT 1 FROM seo_backlinks WHERE from_content_id = $1 AND to_content_id = $2`,
        [own.id, match.id],
      );
      if (exists.length) continue;

      const { rows: inserted } = await db.query(
        `INSERT INTO seo_backlinks (tenant_id, partner_tenant_id, from_content_id, to_content_id, status)
         VALUES ($1, $2, $3, $4, 'suggested') RETURNING id, from_content_id, to_content_id, status`,
        [tenantId, partner.id, own.id, match.id],
      );
      suggestions.push(inserted[0]);
      remaining--;
    }
  }

  logger.info('SEO backlink candidates found', { tenantId, count: suggestions.length });
  return suggestions;
}

module.exports = { findCandidates, MAX_LINKS_PER_TENANT_PAIR };
