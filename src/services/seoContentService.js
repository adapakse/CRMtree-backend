'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoContentService.js — SEObot article generation pipeline.
//
// 4-stage pipeline per article, gated by automatic pre-checks before it
// ever reaches a human editor (crm-seo.js still owns the mandatory human
// approval gate — this only decides in_review vs needs_update):
//   1. Keyword research   (Sonnet 5) — picks a phrase within the least-
//      covered content pillar (see seoStrategyService).
//   2. Outline             (Sonnet 5)
//   3. Draft                (Opus 4.8, adaptive thinking)
//   4. Critique/revise      (Opus 4.8) — mandatory quality pass, always run
//      once; re-run again (max 2 extra attempts) if pre-gate checks fail.
// ─────────────────────────────────────────────────────────────────

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const strategyService = require('./seoStrategyService');
const pexelsService = require('./pexelsService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const RESEARCH_MODEL  = 'claude-sonnet-5';
const OUTLINE_MODEL   = 'claude-sonnet-5';
const DRAFT_MODEL     = 'claude-opus-4-8';
const CRITIQUE_MODEL  = 'claude-opus-4-8';

// USD per 1M tokens — approximate, for the generation_cost_usd visibility column only.
const PRICING = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

const BRAND_VOICE = `Ton: profesjonalny, konkretny, B2B, bez sprzedażowego przegięcia i banalnych wstępów (unikaj fraz typu "W dzisiejszych czasach…").
Odbiorca: menedżerowie sprzedaży i właściciele firm z różnych branż, rozważający lub już używający CRM.
Fokus tematyczny: dynamiczna praca handlowców, zarządzanie lejkiem sprzedażowym, upsell i cross-sell.
Zero wymyślonych statystyk i case studies — jeśli potrzebna liczba, albo uogólnienie bez fałszywego źródła, albo pominięcie.
Cała treść po polsku.`;

const CRITIQUE_INSTRUCTIONS = `Skrytykuj i popraw ten artykuł pod kątem:
(1) halucynacji — wymyślonych statystyk, case studies, lub twierdzeń o konkurencji,
(2) naturalności użycia frazy kluczowej,
(3) zgodności z tonem marki,
(4) obecności sensownego linkowania wewnętrznego (jeśli byli kandydaci),
(5) braku banalnych wstępów i sprzedażowego przegięcia.
Popraw wszystko co znajdziesz.`;

const BANNED_PATTERNS = [
  { regex: /\d{1,3}\s?%\s+(firm|klientów|użytkowników|przedsiębiorstw|organizacji)/i,
    reason: 'podejrzana, niepotwierdzona statystyka procentowa' },
  { regex: /najlepsz\w*\s+(crm|system)\w*\s+(na świecie|w polsce|na rynku)/i,
    reason: 'nieuzasadniony superlatyw' },
];

// ── Zod schemas (structured output — client.messages.parse) ───────────────

const KeywordResearchSchema = z.object({
  phrase: z.string(),
  intent: z.enum(['informational', 'transactional']),
  difficulty: z.enum(['low', 'medium', 'high']),
  recommended_word_count: z.number().int().min(800).max(3000),
  reasoning: z.string(),
});

const OutlineSchema = z.object({
  h1: z.string(),
  sections: z
    .array(z.object({ heading: z.string(), level: z.enum(['h2', 'h3']), summary: z.string() }))
    .min(3)
    .max(8),
  faq_questions: z.array(z.string()).min(3).max(5),
  meta_title_draft: z.string(),
  meta_description_draft: z.string(),
  internal_link_candidates: z
    .array(z.object({ target_slug: z.string(), reason: z.string() }))
    .max(6),
});

const ArticleSchema = z.object({
  title: z.string(),
  slug: z.string(),
  meta_title: z.string(),
  meta_description: z.string(),
  primary_keyword: z.string(),
  sections: z
    .array(z.object({ heading: z.string(), level: z.enum(['h2', 'h3']), content_markdown: z.string() }))
    .min(3),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).min(3).max(5),
  internal_link_suggestions: z
    .array(z.object({ target_slug: z.string(), anchor_text: z.string() }))
    .max(6),
  cta: z.object({ text: z.string(), url: z.string() }),
});

// ── Helpers ─────────────────────────────────────────────────────────────

function costOf(model, usage) {
  const pricing = PRICING[model];
  if (!pricing || !usage) return 0;
  return (usage.input_tokens || 0) * (pricing.input / 1e6) + (usage.output_tokens || 0) * (pricing.output / 1e6);
}

function slugify(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureValidSlug(slug, fallbackTitle) {
  if (slug && /^[a-z0-9-]+$/.test(slug)) return slug;
  return slugify(fallbackTitle) || `artykul-${Date.now()}`;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateArticle(article, primaryKeyword, validSlugSet) {
  const errors = [];
  const bodyText = article.sections.map((s) => s.content_markdown).join(' ');

  const wordCount = countWords(bodyText);
  if (wordCount < 1200 || wordCount > 3000) {
    errors.push(`Liczba słów (${wordCount}) poza zakresem 1200-3000.`);
  }

  if (!article.meta_title || article.meta_title.length > 60) {
    errors.push(`meta_title musi mieć ≤60 znaków (obecnie: ${article.meta_title?.length ?? 0}).`);
  }
  if (!article.meta_description || article.meta_description.length < 100 || article.meta_description.length > 160) {
    errors.push(`meta_description musi mieć 100-160 znaków (obecnie: ${article.meta_description?.length ?? 0}).`);
  }

  const first100Words = bodyText.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  if (primaryKeyword && !first100Words.includes(primaryKeyword.toLowerCase())) {
    errors.push('Fraza kluczowa nie występuje w pierwszych ~100 słowach treści.');
  }

  if (!/^[a-z0-9-]+$/.test(article.slug || '')) {
    errors.push(`Slug "${article.slug}" nie pasuje do formatu kebab-case ASCII.`);
  }

  if (!Array.isArray(article.faq) || article.faq.length < 3 || article.faq.length > 5) {
    errors.push(`FAQ musi mieć 3-5 pozycji (obecnie: ${article.faq?.length ?? 0}).`);
  }

  for (const link of article.internal_link_suggestions || []) {
    if (!validSlugSet.has(link.target_slug)) {
      errors.push(`Sugerowany link wewnętrzny wskazuje na nieistniejący slug: "${link.target_slug}".`);
    }
  }

  for (const { regex, reason } of BANNED_PATTERNS) {
    if (regex.test(bodyText)) errors.push(`Wykryto zakazany wzorzec: ${reason}.`);
  }

  return { ok: errors.length === 0, errors };
}

function renderBody(article) {
  const parts = [];
  for (const section of article.sections) {
    parts.push(`${section.level === 'h3' ? '###' : '##'} ${section.heading}`);
    parts.push(section.content_markdown);
  }
  if (article.faq?.length) {
    parts.push('## Najczęściej zadawane pytania');
    for (const item of article.faq) {
      parts.push(`**${item.question}**`);
      parts.push(item.answer);
    }
  }
  if (article.internal_link_suggestions?.length) {
    parts.push('## Zobacz też');
    parts.push(article.internal_link_suggestions.map((l) => `- [${l.anchor_text}](/blog/${l.target_slug})`).join('\n'));
  }
  if (article.cta?.text) {
    parts.push(`[${article.cta.text}](${article.cta.url})`);
  }
  return parts.join('\n\n');
}

// ── Pipeline stages ─────────────────────────────────────────────────────

async function researchKeyword({ pillar, existingPhrases }) {
  const response = await client.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 2000,
    system:
      'You are an SEO keyword researcher for a B2B CRM company blog. Given a content pillar, propose ONE new target keyword phrase that fits within it, is distinct from already-used phrases, and has realistic search intent. Write the phrase and reasoning in Polish.',
    messages: [
      {
        role: 'user',
        content: [
          `Filar: ${pillar.name}`,
          `Opis filaru: ${pillar.description}`,
          `Tematyka fraz dla tego filaru: ${pillar.target_keyword_theme}`,
          existingPhrases.length
            ? `Frazy już wykorzystane (nie powtarzaj):\n${existingPhrases.map((p) => `- ${p}`).join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(KeywordResearchSchema) },
  });
  if (!response.parsed_output) throw new Error('Keyword research failed to parse.');
  return { result: response.parsed_output, usage: response.usage, model: RESEARCH_MODEL };
}

async function generateOutline({ keyword, pillar, publishedArticles }) {
  const response = await client.messages.parse({
    model: OUTLINE_MODEL,
    max_tokens: 3000,
    system: `You are an SEO content outline writer. ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          `Fraza kluczowa: ${keyword.phrase} (intencja: ${keyword.intent}, sugerowana długość: ~${keyword.recommended_word_count} słów)`,
          `Filar tematyczny: ${pillar.name} — ${pillar.description}`,
          publishedArticles.length
            ? `Już opublikowane artykuły (kandydaci do linkowania wewnętrznego):\n${publishedArticles.map((a) => `- ${a.slug}: ${a.title}`).join('\n')}`
            : 'Brak jeszcze opublikowanych artykułów do linkowania wewnętrznego — zostaw internal_link_candidates puste.',
          'Zaproponuj strukturę artykułu: H1, sekcje H2/H3 z krótkim opisem zawartości (maksymalnie 8 sekcji łącznie — połącz pokrewne wątki, jeśli masz ich więcej), pytania FAQ (3-5), szkic meta title/description, kandydatów na linki wewnętrzne.',
        ].join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(OutlineSchema) },
  });
  if (!response.parsed_output) throw new Error('Outline generation failed to parse.');
  return { result: response.parsed_output, usage: response.usage, model: OUTLINE_MODEL };
}

async function generateDraft({ outline, keyword }) {
  const response = await client.messages.parse({
    model: DRAFT_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: `You are an expert B2B content writer. ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          "Napisz pełny artykuł na podstawie tego outline'u.",
          `H1: ${outline.h1}`,
          `Fraza kluczowa: ${keyword.phrase}`,
          `Sekcje:\n${outline.sections.map((s) => `- [${s.level}] ${s.heading}: ${s.summary}`).join('\n')}`,
          `Pytania FAQ do rozwinięcia:\n${outline.faq_questions.map((q) => `- ${q}`).join('\n')}`,
          `Szkic meta title: ${outline.meta_title_draft}`,
          `Szkic meta description: ${outline.meta_description_draft}`,
          outline.internal_link_candidates.length
            ? `Kandydaci na linki wewnętrzne:\n${outline.internal_link_candidates.map((l) => `- ${l.target_slug} (${l.reason})`).join('\n')}`
            : 'Brak kandydatów na linki wewnętrzne — zostaw internal_link_suggestions puste.',
          'Zwróć kompletny artykuł: title, slug (kebab-case, ASCII), meta_title (≤60 znaków), meta_description (100-160 znaków), primary_keyword, sections (z pełną treścią w content_markdown), faq (3-5 pozycji), internal_link_suggestions, cta.',
        ].join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(ArticleSchema) },
  });
  if (!response.parsed_output) throw new Error('Draft generation failed to parse.');
  return { result: response.parsed_output, usage: response.usage, model: DRAFT_MODEL };
}

async function reviseArticle({ article, instructions }) {
  const response = await client.messages.parse({
    model: CRITIQUE_MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: `You are an expert SEO/content editor. ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          'Oto wersja robocza artykułu w formacie JSON:',
          JSON.stringify(article),
          instructions,
          'Zwróć poprawioną, kompletną wersję artykułu w tym samym formacie (wszystkie pola, nie tylko zmienione).',
        ].join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(ArticleSchema) },
  });
  if (!response.parsed_output) throw new Error('Article revision failed to parse.');
  return { result: response.parsed_output, usage: response.usage, model: CRITIQUE_MODEL };
}

// ── Orchestration ───────────────────────────────────────────────────────

async function countGeneratedToday(tenantId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM seo_content_pieces WHERE tenant_id = $1 AND created_at::date = now()::date`,
    [tenantId],
  );
  return rows[0].cnt;
}

async function generateArticle(tenantId) {
  const pillar = await strategyService.pickLeastCoveredPillar(tenantId);
  if (!pillar) throw new Error('No content pillar available for this tenant.');

  const { rows: existingKeywords } = await db.query(`SELECT phrase FROM seo_keywords WHERE tenant_id = $1`, [tenantId]);
  const { rows: published } = await db.query(
    `SELECT slug, title FROM seo_content_pieces WHERE tenant_id = $1 AND locale = 'pl' AND status = 'published'`,
    [tenantId],
  );
  const validSlugs = new Set(published.map((p) => p.slug));

  let totalCostUsd = 0;
  const track = (stage) => { totalCostUsd += costOf(stage.model, stage.usage); };

  const research = await researchKeyword({ pillar, existingPhrases: existingKeywords.map((k) => k.phrase) });
  track(research);
  const keyword = research.result;

  const { rows: keywordRows } = await db.query(
    `INSERT INTO seo_keywords (tenant_id, phrase, source, priority, pillar_id) VALUES ($1, $2, 'llm', 0, $3) RETURNING id`,
    [tenantId, keyword.phrase, pillar.id],
  );
  const keywordId = keywordRows[0].id;

  const outlineResp = await generateOutline({ keyword, pillar, publishedArticles: published });
  track(outlineResp);
  const outline = outlineResp.result;

  const draftResp = await generateDraft({ outline, keyword });
  track(draftResp);
  let article = draftResp.result;

  const critiqueResp = await reviseArticle({ article, instructions: CRITIQUE_INSTRUCTIONS });
  track(critiqueResp);
  article = critiqueResp.result;
  article.slug = ensureValidSlug(article.slug, article.title);

  let validation = validateArticle(article, keyword.phrase, validSlugs);
  let attempts = 0;
  while (!validation.ok && attempts < 2) {
    const fixResp = await reviseArticle({
      article,
      instructions: `Ten artykuł nie przeszedł automatycznej walidacji. Popraw dokładnie te problemy:\n${validation.errors.map((e) => `- ${e}`).join('\n')}`,
    });
    track(fixResp);
    article = fixResp.result;
    article.slug = ensureValidSlug(article.slug, article.title);
    validation = validateArticle(article, keyword.phrase, validSlugs);
    attempts++;
  }

  const status = validation.ok ? 'in_review' : 'needs_update';
  const renderedBody = renderBody(article);
  const body = validation.ok
    ? renderedBody
    : `[Automatyczna walidacja nie przeszła po ${attempts} próbach poprawy — wymaga ręcznej korekty]:\n${validation.errors.join('\n')}\n\n${renderedBody}`;

  const headerImageUrl = await pexelsService.searchHeaderImage(pillar.name);

  const { rows: contentRows } = await db.query(
    `INSERT INTO seo_content_pieces
       (tenant_id, locale, title, slug, body, meta_description, status, target_keyword, category, generation_cost_usd, header_image_url)
     VALUES ($1, 'pl', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [tenantId, article.title, article.slug, body, article.meta_description, status, keyword.phrase, pillar.name, totalCostUsd.toFixed(4), headerImageUrl],
  );

  await db.query(`UPDATE seo_keywords SET content_id = $1 WHERE id = $2`, [contentRows[0].id, keywordId]);

  logger.info('SEO article generated', {
    tenantId,
    contentId: contentRows[0].id,
    status,
    costUsd: totalCostUsd.toFixed(4),
    validationAttempts: attempts,
  });

  return contentRows[0];
}

module.exports = { generateArticle, countGeneratedToday, validateArticle, renderBody };
