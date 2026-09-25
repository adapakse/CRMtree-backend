'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoStrategyService.js — content strategy map (topic pillars).
//
// Modeled on AutoSEO's "Content Strategy Mindmap" (pillars → supporting
// articles), but generated up front from the tenant's own business
// description at onboarding time, instead of rendered after the fact from
// whatever articles happen to already exist. seoContentService picks the
// least-covered pillar before researching each new article's keyword, so
// generation follows a coherent strategy rather than one-off keywords.
// ─────────────────────────────────────────────────────────────────

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { slugify } = require('../utils/slugify');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Cheaper model — strategy is a one-time (or rarely-refreshed) step, not
// per-article, and doesn't need Opus-level writing quality.
const STRATEGY_MODEL = 'claude-sonnet-5';

const PillarsSchema = z.object({
  pillars: z
    .array(
      z.object({
        name: z.string().describe('Krótka nazwa filaru tematycznego, po polsku'),
        description: z
          .string()
          .describe('1-2 zdania: co ten filar obejmuje i dlaczego jest istotny dla tej grupy odbiorców'),
        target_keyword_theme: z
          .string()
          .describe('Krótkie określenie rodziny fraz kluczowych, które ten filar ma pokrywać'),
      }),
    )
    .min(4)
    .max(8),
});

const SYSTEM_PROMPT = `You are an SEO content strategist building a content strategy map (topic pillars) for a B2B company's blog.
Given the company's business description, industry vertical, and known competitors, produce 4-8 distinct, non-overlapping topic pillars that comprehensively cover the company's product and its audience's real problems.
Do not invent topics unrelated to the described business. Avoid generic filler pillars ("company news", "industry trends") unless clearly grounded in the business description.
Write all pillar names, descriptions, and keyword themes in Polish — the target audience reads Polish.`;

async function getPillars(tenantId) {
  const { rows } = await db.query(
    `SELECT id, name, description, target_keyword_theme, priority, slug
       FROM seo_content_pillars WHERE tenant_id = $1 ORDER BY priority`,
    [tenantId],
  );
  return backfillSlugs(tenantId, rows);
}

// Pillars created before the slug column existed (0298) get one lazily on
// first read, instead of a one-off backfill migration — same self-healing
// pattern the rest of this file already uses for on-demand generation.
async function backfillSlugs(tenantId, pillars) {
  const used = new Set(pillars.map((p) => p.slug).filter(Boolean));
  for (const pillar of pillars) {
    if (pillar.slug) continue;
    let slug = slugify(pillar.name) || `filar-${pillar.id}`;
    if (used.has(slug)) slug = `${slug}-${pillar.id}`;
    used.add(slug);
    await db.query(`UPDATE seo_content_pillars SET slug = $1 WHERE id = $2`, [slug, pillar.id]);
    pillar.slug = slug;
  }
  return pillars;
}

/** Public hub page lookup — returns null if no pillar matches (including tenants where slugs haven't been backfilled yet, which getPillars()/ensurePillars() handles on the editorial side). */
async function getPillarBySlug(tenantId, slug) {
  const { rows } = await db.query(
    `SELECT id, name, description, target_keyword_theme, slug
       FROM seo_content_pillars WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug],
  );
  return rows[0] || null;
}

/** Returns existing pillars, generating them on first use. Tenants without a business_description yet
 * (fresh onboarding, not interviewed) get an empty list instead of a hard failure — they can still add
 * pillars manually until the description is filled in and auto-generation becomes available. */
async function ensurePillars(tenantId) {
  const existing = await getPillars(tenantId);
  if (existing.length) return existing;
  const { rows: tenantRows } = await db.query(`SELECT business_description FROM tenants WHERE id = $1`, [tenantId]);
  if (!tenantRows[0]?.business_description) return [];
  return generatePillars(tenantId);
}

async function generatePillars(tenantId) {
  const { rows: tenantRows } = await db.query(
    `SELECT business_description, industry_vertical FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = tenantRows[0];
  if (!tenant?.business_description) {
    throw new Error('Tenant has no business_description set — cannot generate a content strategy map.');
  }

  const { rows: competitors } = await db.query(
    `SELECT url, notes FROM seo_competitors WHERE tenant_id = $1`,
    [tenantId],
  );

  const userContent = [
    `Opis biznesu: ${tenant.business_description}`,
    tenant.industry_vertical ? `Wertykał/branża: ${tenant.industry_vertical}` : null,
    competitors.length
      ? `Konkurenci:\n${competitors.map((c) => `- ${c.url}${c.notes ? ` (${c.notes})` : ''}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await client.messages.parse({
    model: STRATEGY_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    output_config: { format: zodOutputFormat(PillarsSchema) },
  });

  if (!response.parsed_output) {
    throw new Error('Content strategy map generation failed to parse.');
  }

  const inserted = [];
  const usedSlugs = new Set();
  const { pillars } = response.parsed_output;
  for (let i = 0; i < pillars.length; i++) {
    const p = pillars[i];
    let slug = slugify(p.name) || `filar-${i}`;
    if (usedSlugs.has(slug)) slug = `${slug}-${i}`;
    usedSlugs.add(slug);
    const { rows } = await db.query(
      `INSERT INTO seo_content_pillars (tenant_id, name, description, target_keyword_theme, priority, slug)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, target_keyword_theme, priority, slug`,
      [tenantId, p.name, p.description, p.target_keyword_theme, i, slug],
    );
    inserted.push(rows[0]);
  }

  logger.info('SEO content strategy map generated', {
    tenantId,
    pillarCount: inserted.length,
    usage: response.usage,
  });

  return inserted;
}

/** All pillars with article coverage counts, least-covered first — powers both scheduling and the editorial strategy view. */
async function getPillarsWithCoverage(tenantId) {
  await ensurePillars(tenantId);
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.description, p.target_keyword_theme, p.priority, p.slug,
            COUNT(k.content_id)::int AS article_count
       FROM seo_content_pillars p
       LEFT JOIN seo_keywords k ON k.pillar_id = p.id AND k.content_id IS NOT NULL
      WHERE p.tenant_id = $1
      GROUP BY p.id
      ORDER BY article_count ASC, p.priority ASC`,
    [tenantId],
  );
  return backfillSlugs(tenantId, rows);
}

/** Picks the pillar with the fewest published/in-progress articles so far — keeps coverage balanced. */
async function pickLeastCoveredPillar(tenantId) {
  const pillars = await getPillarsWithCoverage(tenantId);
  return pillars[0];
}

/** All pillars for the public "browse by topic" index — only ones with at least one published article are worth listing. */
async function getPublishedPillars(tenantId, locale) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.description, p.slug, COUNT(*)::int AS article_count
       FROM seo_content_pillars p
       JOIN seo_keywords k ON k.pillar_id = p.id
       JOIN seo_content_pieces c ON c.id = k.content_id
      WHERE p.tenant_id = $1 AND c.tenant_id = $1 AND c.locale = $2 AND c.status = 'published'
      GROUP BY p.id
      ORDER BY p.priority ASC`,
    [tenantId, locale],
  );
  return backfillSlugs(tenantId, rows);
}

/** Published articles belonging to one pillar, for its public hub page. */
async function getPublishedArticlesForPillar(tenantId, pillarId, locale) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.slug, c.meta_description, c.header_image_url, c.published_at
       FROM seo_content_pieces c
       JOIN seo_keywords k ON k.content_id = c.id
      WHERE k.pillar_id = $1 AND c.tenant_id = $2 AND c.locale = $3 AND c.status = 'published'
      ORDER BY c.published_at DESC`,
    [pillarId, tenantId, locale],
  );
  return rows;
}

module.exports = {
  getPillars,
  ensurePillars,
  generatePillars,
  getPillarsWithCoverage,
  pickLeastCoveredPillar,
  getPillarBySlug,
  getPublishedPillars,
  getPublishedArticlesForPillar,
};
