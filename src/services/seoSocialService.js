'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoSocialService.js — LinkedIn post copy, generated automatically
// when an article publishes (see crm-seo.js /approve and jobs/seo-scheduler.js).
//
// LinkedIn only, for now: it's the one B2B-relevant platform for a CRM
// product, and each platform needs its own registered OAuth app to actually
// post via API — out of scope here, this produces copy-paste-ready text only.
//
// Never lets a social-post failure break publishing — same "nice-to-have,
// not a hard requirement" posture as pexelsService's header images.
// ─────────────────────────────────────────────────────────────────

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { BRAND_VOICE } = require('./seoContentService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const MODEL = 'claude-sonnet-5';

const SocialPostSchema = z.object({
  post: z.string().describe('Gotowy tekst posta LinkedIn, po polsku, 3-6 krótkich akapitów, max ~1200 znaków'),
});

async function generateSocialPost({ title, metaDescription, articleUrl }) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 1200,
    system:
      `You write LinkedIn posts promoting B2B blog articles for a CRM company. ${BRAND_VOICE} ` +
      'Hook in the first line (no "W dzisiejszych czasach" style openers), 3-6 short paragraphs, no more than 2 emoji total, ' +
      'end with a short call to action and the article link on its own line. Do not use hashtags unless genuinely useful (max 3).',
    messages: [
      {
        role: 'user',
        content: [
          `Tytuł artykułu: ${title}`,
          `Opis: ${metaDescription}`,
          `Link do artykułu: ${articleUrl}`,
        ].join('\n'),
      },
    ],
    output_config: { format: zodOutputFormat(SocialPostSchema) },
  });
  if (!response.parsed_output) throw new Error('Social post generation failed to parse.');
  return response.parsed_output.post;
}

/** Fire-and-forget from the publish paths — logs and swallows failures rather than blocking publication. */
async function generateAndSaveSocialPost(contentId, siteUrl) {
  try {
    const { rows } = await db.query(
      `SELECT title, meta_description, slug FROM seo_content_pieces WHERE id = $1`,
      [contentId],
    );
    const article = rows[0];
    if (!article) return;

    const articleUrl = `${(siteUrl || '').replace(/\/$/, '')}/blog/${article.slug}`;
    const post = await generateSocialPost({ title: article.title, metaDescription: article.meta_description, articleUrl });

    await db.query(`UPDATE seo_content_pieces SET social_post_linkedin = $1 WHERE id = $2`, [post, contentId]);
    logger.info('SEO social post generated', { contentId });
  } catch (err) {
    logger.warn('SEO social post generation failed', { contentId, error: err.message });
  }
}

module.exports = { generateSocialPost, generateAndSaveSocialPost };
