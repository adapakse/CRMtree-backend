'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoSocialService.js — social post copy generation + publish
// orchestration, fired automatically when an article publishes (immediate
// approve, or the scheduler job). One-click-publish means the article gate
// (crm-seo.js /approve) doubles as the social publish gate — there is no
// separate approval step for social.
//
// X (Twitter) intentionally excluded — on hold (Adam, 2026-07-17), needs a
// paid API tier we haven't subscribed to.
//
// Never lets a social failure block the article's own publish state: each
// platform is generated/published independently and failures are recorded
// per-platform in seo_social_posts, not thrown back at the caller.
// ─────────────────────────────────────────────────────────────────

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const { BRAND_VOICE } = require('./seoContentService');
const linkedinService = require('./socialPublish/linkedinService');
const metaService = require('./socialPublish/metaService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const MODEL = 'claude-sonnet-5';

const SocialCopySchema = z.object({
  linkedin: z.string().describe('Post na LinkedIn: hook w pierwszej linii, 3-6 krótkich akapitów, max ok. 1200 znaków, link do artykułu na końcu.'),
  facebook: z.string().describe('Post na Facebook: krótszy i bardziej bezpośredni niż LinkedIn, max ok. 500 znaków, z linkiem do artykułu.'),
  instagram: z.string().describe('Opis pod Instagram: 2-3 krótkie zdania/akapity, max ok. 300 znaków, BEZ oczekiwania że link będzie klikalny (nie jest w opisie IG) — nie zachęcaj do klikania linku w tekście, zamiast tego napisz coś w stylu "link w bio". Zakończ 3-5 trafnymi hashtagami.'),
});

async function generateCopyVariants({ title, metaDescription, articleUrl }) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system:
      `You write social media posts promoting B2B blog articles for a CRM company, across LinkedIn, Facebook and Instagram. ${BRAND_VOICE} ` +
      'Each platform gets its own tone and constraints — do not just copy-paste the same text three times. No more than 2 emoji total per post. Write in Polish.',
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
    output_config: { format: zodOutputFormat(SocialCopySchema) },
  });
  if (!response.parsed_output) throw new Error('Social copy generation failed to parse.');
  return response.parsed_output;
}

async function upsertPost(tenantId, contentId, platform, patch) {
  const fields = Object.keys(patch);
  const setClause = fields.map((f, i) => `${f} = $${i + 4}`).join(', ');
  await db.query(
    `INSERT INTO seo_social_posts (tenant_id, content_id, platform, ${fields.join(', ')})
     VALUES ($1, $2, $3, ${fields.map((_, i) => `$${i + 4}`).join(', ')})
     ON CONFLICT (content_id, platform) DO UPDATE SET ${setClause}`,
    [tenantId, contentId, platform, ...fields.map((f) => patch[f])],
  );
}

/** Fire-and-forget from the publish paths (crm-seo.js /approve, jobs/seo-scheduler.js). */
async function publishToConnectedPlatforms(contentId, tenantId, siteUrl) {
  try {
    const { rows: articleRows } = await db.query(
      `SELECT title, meta_description, slug, header_image_url FROM seo_content_pieces WHERE id = $1`,
      [contentId],
    );
    const article = articleRows[0];
    if (!article) return;

    const { rows: accounts } = await db.query(
      `SELECT platform FROM tenant_social_accounts WHERE tenant_id = $1`,
      [tenantId],
    );
    const connected = new Set(accounts.map((a) => a.platform));
    if (!connected.size) return; // nothing connected — nothing to do, not an error

    const articleUrl = `${(siteUrl || '').replace(/\/$/, '')}/blog/${article.slug}`;
    const copy = await generateCopyVariants({ title: article.title, metaDescription: article.meta_description, articleUrl });

    if (connected.has('linkedin')) {
      await publishOne(tenantId, contentId, 'linkedin', copy.linkedin, () =>
        linkedinService.publishPost(tenantId, { text: copy.linkedin, articleUrl, articleTitle: article.title, articleDescription: article.meta_description }));
    }
    if (connected.has('facebook')) {
      await publishOne(tenantId, contentId, 'facebook', copy.facebook, () =>
        metaService.publishToFacebook(tenantId, { text: copy.facebook, articleUrl }));
    }
    if (connected.has('instagram')) {
      await publishOne(tenantId, contentId, 'instagram', copy.instagram, () =>
        metaService.publishToInstagram(tenantId, { caption: copy.instagram, imageUrl: article.header_image_url }));
    }
  } catch (err) {
    logger.error('SEO social publish orchestration failed', { contentId, tenantId, error: err.message });
  }
}

async function publishOne(tenantId, contentId, platform, body, publishFn) {
  await upsertPost(tenantId, contentId, platform, { status: 'queued', body });
  try {
    const { remotePostId, remoteUrl } = await publishFn();
    await upsertPost(tenantId, contentId, platform, { status: 'published', remote_post_id: remotePostId, remote_url: remoteUrl, published_at: new Date().toISOString(), error_message: null });
    logger.info('SEO social post published', { contentId, tenantId, platform });
  } catch (err) {
    await upsertPost(tenantId, contentId, platform, { status: 'failed', error_message: err.message.slice(0, 500) });
    logger.warn('SEO social post publish failed', { contentId, tenantId, platform, error: err.message });
  }
}

/** Manual retry for a single failed platform, or (re)publish one platform on demand. */
async function retryPlatform(contentId, tenantId, platform, siteUrl) {
  const { rows: articleRows } = await db.query(
    `SELECT title, meta_description, slug, header_image_url FROM seo_content_pieces WHERE id = $1`,
    [contentId],
  );
  const article = articleRows[0];
  if (!article) throw new Error('Nie znaleziono artykułu.');

  const { rows: existing } = await db.query(
    `SELECT body FROM seo_social_posts WHERE content_id = $1 AND platform = $2`,
    [contentId, platform],
  );
  const articleUrl = `${(siteUrl || '').replace(/\/$/, '')}/blog/${article.slug}`;
  let body = existing[0]?.body;
  if (!body) {
    const copy = await generateCopyVariants({ title: article.title, metaDescription: article.meta_description, articleUrl });
    body = copy[platform];
  }

  const publishFn = {
    linkedin: () => linkedinService.publishPost(tenantId, { text: body, articleUrl, articleTitle: article.title, articleDescription: article.meta_description }),
    facebook: () => metaService.publishToFacebook(tenantId, { text: body, articleUrl }),
    instagram: () => metaService.publishToInstagram(tenantId, { caption: body, imageUrl: article.header_image_url }),
  }[platform];
  if (!publishFn) throw new Error(`Nieznana platforma: ${platform}`);

  await publishOne(tenantId, contentId, platform, body, publishFn);
}

module.exports = { generateCopyVariants, publishToConnectedPlatforms, retryPlatform };
