'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoContentService.js — SEObot article generation pipeline.
//
// 5-stage pipeline per article, gated by automatic pre-checks before it
// ever reaches a human editor (crm-seo.js still owns the mandatory human
// approval gate — this only decides in_review vs needs_update):
//   1. Keyword research   (Sonnet 5) — picks a phrase within the least-
//      covered content pillar (see seoStrategyService), plus the entity
//      graph (main + related + contextual entities) that phrase sits in.
//   2. Facts research      (Sonnet 5 + web_search) — 0-4 real, cited
//      numeric data points (seoFactsService). Never invents statistics;
//      this is how real numbers get in instead (see BANNED_PATTERNS).
//   3. Outline             (Sonnet 5)
//   4. Draft                (Opus 4.8, adaptive thinking)
//   5. Critique/revise      (Opus 4.8) — mandatory quality pass, always run
//      once; re-run again (max 2 extra attempts) if pre-gate checks fail.
//
// Structure and validation here follow two source documents Adam supplied
// 2026-09-25 (classic on-page SEO + an AI-Overview/GEO citation strategy).
// Where the two disagreed or fully implementing both would have meant an
// unbounded article length, Adam picked an explicit middle ground
// ("wersja pośrednia", 2026-09-25): ~1200-1600 words and a trimmed set of
// the AI-citation framework's mandatory sections (dropped: a separate case
// study section) rather than its full ~12-section structure at 1500-4000
// words. Don't re-expand scope back to the full framework without asking —
// that was a deliberate, explicit trade-off, not an oversight.
// ─────────────────────────────────────────────────────────────────

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const strategyService = require('./seoStrategyService');
const factsService = require('./seoFactsService');
const pexelsService = require('./pexelsService');
const gscService = require('./gscService');
const { ensureValidSlug } = require('../utils/slugify');

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

const BRAND_VOICE = `Ton: profesjonalny, konkretny, B2B, bez sprzedażowego przegięcia i banalnych wstępów (unikaj fraz typu "W dzisiejszych czasach…", "Warto zauważyć, że…", ogólników i metafor).
Odbiorca: menedżerowie sprzedaży i właściciele firm z różnych branż, rozważający lub już używający CRM.
Fokus tematyczny: dynamiczna praca handlowców, zarządzanie lejkiem sprzedażowym, upsell i cross-sell.
Zero wymyślonych statystyk i case studies — jeśli dostarczono realne, zacytowane dane (z linkiem do źródła), wykorzystaj je i podlinkuj źródło; w przeciwnym razie albo uogólnienie bez fałszywego źródła, albo pominięcie liczby.
Każda sekcja musi być zrozumiała samodzielnie, bez kontekstu z innych sekcji — nigdy nie pisz "jak wspomniano wyżej" ani "w powyższym przykładzie": AI wycina fragmenty z artykułu pojedynczo, więc każdy fragment musi działać jako osobny, kompletny moduł wiedzy.
Cała treść po polsku.`;

const CRITIQUE_INSTRUCTIONS = `Skrytykuj i popraw ten artykuł pod kątem:
(1) halucynacji — wymyślonych statystyk, case studies, lub twierdzeń o konkurencji (dane z prawdziwym źródłem/linkiem są OK i pożądane),
(2) naturalności użycia frazy kluczowej,
(3) zgodności z tonem marki,
(4) obecności sensownego linkowania wewnętrznego (jeśli byli kandydaci),
(5) braku banalnych wstępów i sprzedażowego przegięcia,
(6) samodzielności każdej sekcji — usuń każde odniesienie wstecz typu "jak wspomniano", "jak wyżej", "w powyższym przykładzie",
(7) czy pierwszy akapit pod każdym H2 daje konkretną odpowiedź w 40-60 słowach, bez lania wody, zanim rozwinięcie,
(8) czy nagłówki H2 (poza "Dla kogo"/"Dla kogo nie"/"Najczęstsze błędy"/"Tabela porównawcza") są sformułowane jako pytania,
(9) czy artykuł zawiera min. 2-3 jednozdaniowe definicje w stylu "X to proces polegający na…".
Popraw wszystko co znajdziesz.`;

const BANNED_PATTERNS = [
  { regex: /\d{1,3}\s?%\s+(firm|klientów|użytkowników|przedsiębiorstw|organizacji)/i,
    reason: 'podejrzana, niepotwierdzona statystyka procentowa' },
  { regex: /najlepsz\w*\s+(crm|system)\w*\s+(na świecie|w polsce|na rynku)/i,
    reason: 'nieuzasadniony superlatyw' },
  { regex: /w dzisiejszych czasach/i,
    reason: 'banalny wstęp ("w dzisiejszych czasach")' },
  { regex: /warto (też\s+)?zauważyć,?\s*że/i,
    reason: 'wypełniacz stylistyczny ("warto zauważyć, że")' },
  { regex: /jak (już\s+)?wspomniano|jak wspomnieliśmy|w powyższym przykładzie|jak wcześniej pisaliśmy|jak napisaliśmy wyżej/i,
    reason: 'odniesienie wstecz do innej sekcji — łamie zasadę samodzielności fragmentu (RAG/AI Overview)' },
];

// ── Zod schemas (structured output — client.messages.parse) ───────────────

const KeywordResearchSchema = z.object({
  phrase: z.string(),
  intent: z.enum(['informational', 'transactional', 'commercial']),
  difficulty: z.enum(['low', 'medium', 'high']),
  // "Wersja pośrednia" (Adam, 2026-09-25): raised from 600-1000 so the
  // trimmed AI-citation section set below actually has room to breathe,
  // but capped well short of the source material's own 1500-4000 ceiling.
  recommended_word_count: z.number().int().min(1100).max(1600),
  // Entity mapping (doc: "graf tematyczny", not keyword-only writing) — main
  // entity is `phrase` itself; these are what should be naturally woven in.
  related_entities: z.array(z.string()).min(2).max(6),
  reasoning: z.string(),
});

const OutlineSchema = z.object({
  h1: z.string(),
  lead: z.string().describe('3-4 zdania: definicja tematu + kontekst biznesowy + dla kogo się przyda. Bez marketingu.'),
  tldr_bullets: z
    .array(z.string())
    .min(5)
    .max(8)
    .describe('Sekcja "W skrócie" pod chunking AI: czym jest, dla kogo, ile trwa/kosztuje, największe ryzyko, największa korzyść.'),
  sections: z
    .array(z.object({ heading: z.string(), level: z.enum(['h2', 'h3']), summary: z.string() }))
    .min(6)
    .max(8)
    .describe(
      'Musi zawierać dokładnie te sekcje wśród H2 (dosłownie w tych rolach, mogą być dostosowane tematycznie): "Dla kogo jest [temat]", "Dla kogo NIE jest to rozwiązanie", "Najczęstsze błędy", "Tabela porównawcza" (opisz w summary jaką tabelę). Pozostałe 2-4 sekcje dowolne, tematyczne, w miarę możliwości sformułowane jako pytania.',
    ),
  faq_questions: z.array(z.string()).min(5).max(8),
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
  lead: z.string(),
  tldr_bullets: z.array(z.string()).min(5).max(8),
  sections: z
    .array(z.object({ heading: z.string(), level: z.enum(['h2', 'h3']), content_markdown: z.string() }))
    .min(6),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).min(5).max(8),
  internal_link_suggestions: z
    .array(z.object({ target_slug: z.string(), anchor_text: z.string() }))
    .max(6),
  // No `cta` field at all — the marketing site has no demo/contact/pricing page for
  // the model to link to, only /login exists. Letting the model invent a CTA url
  // (it consistently guessed "/demo", a common SaaS convention that doesn't exist on
  // this site) produced a dead link on every published article. The real, fixed
  // footer (login + real contact form on crmtree.pl) is appended by renderBody()
  // instead, unconditionally, for every article.
});

// Two fixed footer CTAs appended to every article — not model-generated, since
// there are exactly two real destinations on the site and no reason to let the
// model guess at either one.
const LOGIN_CTA = '[Masz już konto? Zaloguj się](/login)';
const DEMO_CTA = '[Nie masz konta? Zamów demo](https://crmtree.pl/#contact)';

// ── Helpers ─────────────────────────────────────────────────────────────

function costOf(model, usage) {
  const pricing = PRICING[model];
  if (!pricing || !usage) return 0;
  return (usage.input_tokens || 0) * (pricing.input / 1e6) + (usage.output_tokens || 0) * (pricing.output / 1e6);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Heuristic "core word" of a keyword phrase — the longest word in it — used
// to soft-check keyword presence in H2s/meta/slug without needing exact
// phrase matching, which breaks constantly on Polish inflection (e.g.
// "zarządzanie lejkiem" vs. a heading using "zarządzaniu lejkami").
function coreWord(phrase) {
  const words = (phrase || '').split(/\s+/).filter((w) => w.length >= 4);
  if (!words.length) return (phrase || '').toLowerCase();
  return words.reduce((a, b) => (b.length > a.length ? b : a)).toLowerCase();
}

function containsMarkdownTable(text) {
  const lines = (text || '').split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith('|') && lines[i].endsWith('|') && /^\|?[\s:-]+\|[\s:|-]*\|?$/.test(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

// skipSlugCheck: a refreshed article keeps its existing, already-indexed slug.
// Older slugs may not contain the keyword's core word, and the model isn't
// allowed to change the slug anyway, so that check could never be fixed.
function validateArticle(article, primaryKeyword, validSlugSet, hasFacts = false, { skipSlugCheck = false } = {}) {
  const errors = [];
  const bodyText = [article.lead, ...(article.tldr_bullets || []), ...article.sections.map((s) => s.content_markdown)]
    .filter(Boolean)
    .join(' ');
  const core = coreWord(primaryKeyword);

  // "Wersja pośrednia" target: ~1200-1600 words, with slack either side to
  // avoid needless retry churn over a handful of words.
  const wordCount = countWords(bodyText);
  if (wordCount < 900 || wordCount > 1700) {
    errors.push(`Liczba słów (${wordCount}) poza zakresem 900-1700.`);
  }

  if (!article.meta_title || article.meta_title.length < 55 || article.meta_title.length > 70) {
    errors.push(`meta_title musi mieć 55-70 znaków (obecnie: ${article.meta_title?.length ?? 0}).`);
  }
  if (!article.meta_description || article.meta_description.length < 150 || article.meta_description.length > 160) {
    errors.push(`meta_description musi mieć 150-160 znaków (obecnie: ${article.meta_description?.length ?? 0}).`);
  }
  if (core && !article.meta_title?.toLowerCase().includes(core)) {
    errors.push(`Fraza kluczowa (lub jej rdzeń "${core}") nie występuje w meta_title.`);
  }
  if (core && !article.meta_description?.toLowerCase().includes(core)) {
    errors.push(`Fraza kluczowa (lub jej rdzeń "${core}") nie występuje w meta_description.`);
  }

  const first100Words = bodyText.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  if (primaryKeyword && !first100Words.includes(primaryKeyword.toLowerCase())) {
    errors.push('Fraza kluczowa nie występuje w pierwszych ~100 słowach treści (lead).');
  }

  if (!skipSlugCheck) {
    if (!/^[a-z0-9-]+$/.test(article.slug || '')) {
      errors.push(`Slug "${article.slug}" nie pasuje do formatu kebab-case ASCII.`);
    } else if (core && !article.slug.includes(core.normalize('NFD').replace(/[̀-ͯ]/g, ''))) {
      errors.push(`Slug "${article.slug}" nie zawiera rdzenia frazy kluczowej ("${core}").`);
    }
  }

  const phraseRegex = primaryKeyword
    ? new RegExp(primaryKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    : null;
  if (phraseRegex) {
    const occurrences = (bodyText.match(phraseRegex) || []).length;
    if (occurrences < 3 || occurrences > 10) {
      errors.push(`Fraza kluczowa występuje ${occurrences} razy w treści — oczekiwano 3-10.`);
    }
  }

  const h2Headings = article.sections.filter((s) => s.level === 'h2').map((s) => s.heading);
  if (core && !h2Headings.some((h) => h.toLowerCase().includes(core))) {
    errors.push(`Żaden nagłówek H2 nie zawiera frazy kluczowej (lub jej rdzenia "${core}").`);
  }
  const questionHeadings = h2Headings.filter((h) => /\?\s*$/.test(h.trim())).length;
  if (questionHeadings < 2) {
    errors.push(`Za mało nagłówków H2 sformułowanych jako pytania (${questionHeadings}, oczekiwano min. 2).`);
  }
  const dlaKogoCount = article.sections.filter((s) => /dla kogo/i.test(s.heading)).length;
  if (dlaKogoCount < 2) {
    errors.push('Brak wymaganej pary sekcji "Dla kogo" / "Dla kogo NIE jest to rozwiązanie".');
  }
  const mistakesCount = article.sections.filter((s) => /błęd/i.test(s.heading)).length;
  if (mistakesCount < 1) {
    errors.push('Brak wymaganej sekcji o najczęstszych błędach.');
  }
  if (!article.sections.some((s) => containsMarkdownTable(s.content_markdown))) {
    errors.push('Brak wymaganej tabeli porównawczej (markdown table) w treści.');
  }

  if (!Array.isArray(article.faq) || article.faq.length < 5 || article.faq.length > 8) {
    errors.push(`FAQ musi mieć 5-8 pozycji (obecnie: ${article.faq?.length ?? 0}).`);
  }
  for (const item of article.faq || []) {
    const words = countWords(item.answer || '');
    if (words < 15 || words > 90) {
      errors.push(`Odpowiedź FAQ "${item.question}" ma ${words} słów — oczekiwano ok. 15-90 (cel: 40-60).`);
    }
  }

  if (validSlugSet.size > 0 && (article.internal_link_suggestions || []).length < 2) {
    errors.push('Za mało linków wewnętrznych — minimum 2, gdy istnieją opublikowane artykuły do podlinkowania.');
  }
  for (const link of article.internal_link_suggestions || []) {
    if (!validSlugSet.has(link.target_slug)) {
      errors.push(`Sugerowany link wewnętrzny wskazuje na nieistniejący slug: "${link.target_slug}".`);
    }
  }

  if (hasFacts && !/\]\(https:\/\//.test(bodyText)) {
    errors.push('Dostarczono realne dane ze źródłami, ale artykuł nie zawiera żadnego linku zewnętrznego (https://) cytującego źródło.');
  }

  for (const { regex, reason } of BANNED_PATTERNS) {
    if (regex.test(bodyText)) errors.push(`Wykryto zakazany wzorzec: ${reason}.`);
  }

  return { ok: errors.length === 0, errors };
}

function renderBody(article, pillar) {
  const parts = [];
  parts.push(article.lead);
  if (article.tldr_bullets?.length) {
    parts.push('## W skrócie');
    parts.push(article.tldr_bullets.map((b) => `- ${b}`).join('\n'));
  }
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
  if (pillar?.slug) {
    parts.push(`[Zobacz wszystkie artykuły o: ${pillar.name}](/blog/temat/${pillar.slug})`);
  }
  parts.push(LOGIN_CTA);
  parts.push(DEMO_CTA);
  return parts.join('\n\n');
}

// ── Pipeline stages ─────────────────────────────────────────────────────

async function researchKeyword({ pillar, existingPhrases, gapQueries = [] }) {
  const response = await client.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: 2000,
    system:
      'You are an SEO/entity-graph keyword researcher for a B2B CRM company blog. Given a content pillar, propose ONE new target keyword phrase that fits within it, is distinct from already-used phrases, and has realistic search intent. Also map the entity graph around that phrase: related entities (closely tied concepts) and contextual entities (broader business context) it should naturally cover — not just synonyms. ' +
      'If a real Google Search Console query is provided and fits the pillar well, strongly prefer reusing it verbatim — it is a confirmed, real search, not a guess. Write the phrase, entities, and reasoning in Polish.',
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
          gapQueries.length
            ? `Realne zapytania z Google Search Console — ludzie już ich szukają, ale strona słabo się na nie pozycjonuje (szansa na treść):\n${gapQueries.map((q) => `- "${q.phrase}" (${q.impressions} wyświetleń, śr. pozycja ${q.position})`).join('\n')}`
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

async function generateOutline({ keyword, pillar, publishedArticles, facts }) {
  const response = await client.messages.parse({
    model: OUTLINE_MODEL,
    max_tokens: 6000,
    system: `You are an SEO content outline writer, building outlines that are both keyword-optimized and structured for AI Overview/RAG citation (self-contained, chunkable sections). ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          `Fraza kluczowa: ${keyword.phrase} (intencja: ${keyword.intent}, sugerowana długość: ~${keyword.recommended_word_count} słów)`,
          `Encje powiązane do naturalnego uwzględnienia: ${keyword.related_entities.join(', ')}`,
          `Filar tematyczny: ${pillar.name} — ${pillar.description}`,
          facts.length
            ? `Realne, zacytowane dane do wykorzystania (podaj link do źródła przy użyciu):\n${facts.map((f) => `- ${f.claim} (źródło: ${f.source_url})`).join('\n')}`
            : 'Brak realnych danych liczbowych na ten temat — nie wymyślaj statystyk, pisz bez liczb tam gdzie ich brak.',
          publishedArticles.length
            ? `Już opublikowane artykuły (kandydaci do linkowania wewnętrznego):\n${publishedArticles.map((a) => `- ${a.slug}: ${a.title}`).join('\n')}`
            : 'Brak jeszcze opublikowanych artykułów do linkowania wewnętrznego — zostaw internal_link_candidates puste.',
          `Zaproponuj: lead (3-4 zdania), sekcję "W skrócie" (5-8 punktów pod chunking AI), strukturę sekcji H2/H3 (6-8 łącznie, patrz opis pola sections co jest obowiązkowe), pytania FAQ (5-8), szkic meta title/description, kandydatów na linki wewnętrzne. Cały artykuł ma zmieścić się w ok. ${keyword.recommended_word_count} słowach (maks. 1600).`,
        ].join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(OutlineSchema) },
  });
  if (!response.parsed_output) throw new Error('Outline generation failed to parse.');
  return { result: response.parsed_output, usage: response.usage, model: OUTLINE_MODEL };
}

async function generateDraft({ outline, keyword, facts }) {
  const response = await client.messages.parse({
    model: DRAFT_MODEL,
    max_tokens: 12000,
    thinking: { type: 'adaptive' },
    system: `You are an expert B2B content writer, writing for both classic SEO and AI Overview citation. ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          "Napisz pełny artykuł na podstawie tego outline'u.",
          `Twardy limit długości: cały artykuł (lead + sekcje, bez FAQ) maksymalnie ${keyword.recommended_word_count} słów, w żadnym razie więcej niż 1600 słów łącznie.`,
          `H1: ${outline.h1}`,
          `Lead (użyj prawie dosłownie, dopracuj): ${outline.lead}`,
          `Fraza kluczowa: ${keyword.phrase}`,
          `Encje powiązane: ${keyword.related_entities.join(', ')}`,
          `Punkty "W skrócie": ${outline.tldr_bullets.join(' | ')}`,
          `Sekcje:\n${outline.sections.map((s) => `- [${s.level}] ${s.heading}: ${s.summary}`).join('\n')}`,
          'Pod sekcją "Tabela porównawcza" (lub odpowiednikiem) zbuduj prawdziwą tabelę w markdown (nagłówek + wiersz separatora `|---|---|` + wiersze danych) — nie opisową listę.',
          'Pierwszy akapit pod KAŻDYM H2 to 40-60 słów czystej, konkretnej odpowiedzi (definicja/liczba/konkret), bez wstępu — dopiero potem rozwinięcie. Każda sekcja musi być zrozumiała sama, bez odwołań do innych sekcji ("jak wspomniano" itp. — zakazane).',
          'Wpleć minimum 2-3 jednozdaniowe definicje w stylu "X to proces polegający na…".',
          facts.length
            ? `Realne, zacytowane dane — wykorzystaj naturalnie w treści, z linkiem markdown do źródła:\n${facts.map((f) => `- ${f.claim} (źródło: ${f.source_url})`).join('\n')}`
            : 'Brak realnych danych na ten temat — nie wymyślaj liczb ani statystyk.',
          `Pytania FAQ do rozwinięcia (każda odpowiedź 40-60 słów, bez CTA/sprzedaży):\n${outline.faq_questions.map((q) => `- ${q}`).join('\n')}`,
          `Szkic meta title: ${outline.meta_title_draft}`,
          `Szkic meta description: ${outline.meta_description_draft}`,
          outline.internal_link_candidates.length
            ? `Kandydaci na linki wewnętrzne:\n${outline.internal_link_candidates.map((l) => `- ${l.target_slug} (${l.reason})`).join('\n')}`
            : 'Brak kandydatów na linki wewnętrzne — zostaw internal_link_suggestions puste.',
          'Zwróć kompletny artykuł: title, slug (kebab-case, ASCII, zawierający rdzeń frazy kluczowej), meta_title (55-70 znaków), meta_description (150-160 znaków), primary_keyword, lead, tldr_bullets, sections (z pełną treścią w content_markdown), faq (5-8 pozycji), internal_link_suggestions.',
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
    max_tokens: 12000,
    thinking: { type: 'adaptive' },
    system: `You are an expert SEO/AI-citation content editor. ${BRAND_VOICE}`,
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
    `SELECT id, slug, title FROM seo_content_pieces WHERE tenant_id = $1 AND locale = 'pl' AND status = 'published'`,
    [tenantId],
  );
  const validSlugs = new Set(published.map((p) => p.slug));

  let totalCostUsd = 0;
  const track = (stage) => { totalCostUsd += costOf(stage.model, stage.usage); };

  // Real GSC queries (site already gets impressions for, but ranks poorly on) beat guesses —
  // gracefully skip when GSC isn't connected or the API call fails for any reason.
  let gapQueries = [];
  try {
    gapQueries = await gscService.getContentGapQueries(tenantId);
  } catch (err) {
    logger.info('SEO keyword research: no GSC content-gap data', { tenantId, reason: err.message });
  }

  const research = await researchKeyword({ pillar, existingPhrases: existingKeywords.map((k) => k.phrase), gapQueries });
  track(research);
  const keyword = research.result;
  const usedGscQuery = gapQueries.some((q) => q.phrase.trim().toLowerCase() === keyword.phrase.trim().toLowerCase());

  const { rows: keywordRows } = await db.query(
    `INSERT INTO seo_keywords (tenant_id, phrase, source, priority, pillar_id) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [tenantId, keyword.phrase, usedGscQuery ? 'gsc' : 'llm', pillar.id],
  );
  const keywordId = keywordRows[0].id;

  let facts = [];
  try {
    const factsResp = await factsService.findFacts({ keyword: keyword.phrase, pillar });
    track(factsResp);
    facts = factsResp.facts;
  } catch (err) {
    logger.info('SEO facts research failed — proceeding without cited data', { tenantId, reason: err.message });
  }

  const outlineResp = await generateOutline({ keyword, pillar, publishedArticles: published, facts });
  track(outlineResp);
  const outline = outlineResp.result;

  const draftResp = await generateDraft({ outline, keyword, facts });
  track(draftResp);
  let article = draftResp.result;

  const critiqueResp = await reviseArticle({ article, instructions: CRITIQUE_INSTRUCTIONS });
  track(critiqueResp);
  article = critiqueResp.result;
  article.slug = ensureValidSlug(article.slug, article.title);

  let validation = validateArticle(article, keyword.phrase, validSlugs, facts.length > 0);
  let attempts = 0;
  while (!validation.ok && attempts < 2) {
    const fixResp = await reviseArticle({
      article,
      instructions: `Ten artykuł nie przeszedł automatycznej walidacji. Popraw dokładnie te problemy:\n${validation.errors.map((e) => `- ${e}`).join('\n')}`,
    });
    track(fixResp);
    article = fixResp.result;
    article.slug = ensureValidSlug(article.slug, article.title);
    validation = validateArticle(article, keyword.phrase, validSlugs, facts.length > 0);
    attempts++;
  }

  const status = validation.ok ? 'in_review' : 'needs_update';
  const renderedBody = renderBody(article, pillar);
  const body = validation.ok
    ? renderedBody
    : `[Automatyczna walidacja nie przeszła po ${attempts} próbach poprawy — wymaga ręcznej korekty]:\n${validation.errors.join('\n')}\n\n${renderedBody}`;

  const headerImageUrl = await pexelsService.searchHeaderImage(pillar.name);

  const { rows: contentRows } = await db.query(
    `INSERT INTO seo_content_pieces
       (tenant_id, locale, title, slug, body, meta_description, status, target_keyword, category, generation_cost_usd, header_image_url, faq)
     VALUES ($1, 'pl', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [tenantId, article.title, article.slug, body, article.meta_description, status, keyword.phrase, pillar.name, totalCostUsd.toFixed(4), headerImageUrl, JSON.stringify(article.faq)],
  );

  await db.query(`UPDATE seo_keywords SET content_id = $1 WHERE id = $2`, [contentRows[0].id, keywordId]);

  // Internal links are already live in the body (renderBody's "Zobacz też" section) —
  // this is an audit trail of what got linked, not a pre-publish review gate.
  if (article.internal_link_suggestions?.length) {
    for (const link of article.internal_link_suggestions) {
      const target = published.find((p) => p.slug === link.target_slug);
      if (!target) continue;
      await db.query(
        `INSERT INTO seo_internal_links (tenant_id, from_content_id, to_content_id, status)
         VALUES ($1, $2, $3, 'accepted')`,
        [tenantId, contentRows[0].id, target.id],
      );
    }
  }

  logger.info('SEO article generated', {
    tenantId,
    contentId: contentRows[0].id,
    status,
    costUsd: totalCostUsd.toFixed(4),
    validationAttempts: attempts,
    factsUsed: facts.length,
  });

  return contentRows[0];
}

// ── Refresh of an already-published article ─────────────────────────────
// Produces a proposed revision only; seoRefreshService stages it in
// refresh_draft and it goes live when an editor applies it. Held to the same
// structure and validation as a new article, so a refresh also brings older,
// pre-2026-09 articles up to the current standard. It additionally targets
// the real queries the page already shows up for in Search Console.

const REFRESH_REASON_TEXT = {
  striking_distance: (s) => `Artykuł jest blisko pierwszej strony Google (śr. pozycja ${s.position}, ${s.impressions} wyświetleń w 28 dni) — celem jest wejście do TOP 10.`,
  position_drop: (s) => `Artykuł stracił pozycję w Google (z ${s.positionBefore} na ${s.positionNow}) — celem jest odzyskanie jej przez lepsze dopasowanie do zapytań i aktualność.`,
  age: () => 'Artykuł nie był aktualizowany od ponad 90 dni — celem jest aktualność danych i zgodność z bieżącymi standardami treści.',
  manual: () => 'Redaktor oznaczył artykuł do odświeżenia.',
};

async function refreshArticle(contentId, tenantId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.slug, c.body, c.meta_description, c.target_keyword, c.category,
            c.refresh_reason, c.refresh_signal, wp.remote_url AS wordpress_url
       FROM seo_content_pieces c
       LEFT JOIN seo_social_posts wp ON wp.content_id = c.id AND wp.platform = 'wordpress' AND wp.status = 'published'
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [contentId, tenantId],
  );
  const current = rows[0];
  if (!current) throw new Error('Nie znaleziono artykułu.');

  const { rows: pillarRows } = await db.query(
    `SELECT p.id, p.name, p.description, p.slug
       FROM seo_keywords k JOIN seo_content_pillars p ON p.id = k.pillar_id
      WHERE k.content_id = $1 LIMIT 1`,
    [contentId],
  );
  // Seed articles predate content pillars — fall back to the category text.
  const pillar = pillarRows[0] || { name: current.category || '', description: current.category || '', slug: null };
  const keyword = current.target_keyword || current.title;

  const { rows: published } = await db.query(
    `SELECT id, slug, title FROM seo_content_pieces
      WHERE tenant_id = $1 AND locale = 'pl' AND status = 'published' AND id <> $2`,
    [tenantId, contentId],
  );
  const validSlugs = new Set(published.map((p) => p.slug));

  let totalCostUsd = 0;
  const track = (stage) => { totalCostUsd += costOf(stage.model, stage.usage); };

  let queries = [];
  try {
    queries = await gscService.getQueriesForArticle(tenantId, current);
  } catch (err) {
    logger.info('SEO refresh: no GSC query data for page', { contentId, reason: err.message });
  }

  let facts = [];
  try {
    const factsResp = await factsService.findFacts({ keyword, pillar });
    track(factsResp);
    facts = factsResp.facts;
  } catch (err) {
    logger.info('SEO refresh: facts research failed — proceeding without cited data', { contentId, reason: err.message });
  }

  const reasonText = REFRESH_REASON_TEXT[current.refresh_reason]?.(current.refresh_signal || {}) ?? REFRESH_REASON_TEXT.manual();

  const response = await client.messages.parse({
    model: DRAFT_MODEL,
    max_tokens: 12000,
    thinking: { type: 'adaptive' },
    system: `You are an expert B2B content editor refreshing an already-published, already-indexed article — improve it, don't discard what already works. ${BRAND_VOICE}`,
    messages: [
      {
        role: 'user',
        content: [
          'Odśwież ten opublikowany artykuł. Zachowaj temat, główną frazę i to, co w nim dobre — to aktualizacja, nie nowy tekst od zera.',
          `Powód odświeżenia: ${reasonText}`,
          `Obecny tytuł: ${current.title}`,
          `Obecny meta description: ${current.meta_description || '(brak)'}`,
          `Fraza kluczowa: ${keyword}`,
          `Obecna treść (markdown; pomiń stopkę z linkami "Zobacz też", linkiem do tematu i CTA — dodawane są automatycznie):\n\n${current.body}`,
          queries.length
            ? `Zapytania z Google Search Console, na które ten artykuł JUŻ się wyświetla (ostatnie 28 dni):\n${queries.map((q) => `- "${q.phrase}" (${q.impressions} wyśw., śr. poz. ${q.position})`).join('\n')}\nDopisz lub przebuduj treść tak, żeby odpowiadała na te zapytania wprost — najlepiej jako nagłówek H2 w formie pytania albo pytanie w FAQ, z 40-60-słowną konkretną odpowiedzią na początku. Nie upychaj fraz sztucznie; pomiń zapytania niezwiązane z tematem.`
            : 'Brak danych o zapytaniach z Search Console — skup się na aktualności treści i zgodności ze strukturą poniżej.',
          facts.length
            ? `Realne, zacytowane dane — wykorzystaj naturalnie, z linkiem markdown do źródła:\n${facts.map((f) => `- ${f.claim} (źródło: ${f.source_url})`).join('\n')}`
            : 'Brak realnych danych na ten temat — nie wymyślaj liczb ani statystyk.',
          'Wymagana struktura (jak każdy nowy artykuł): lead (3-4 zdania, fraza w pierwszych 100 słowach), "W skrócie" (5-8 punktów), wśród H2 sekcje "Dla kogo jest…" i "Dla kogo NIE jest to rozwiązanie", "Najczęstsze błędy" oraz prawdziwa tabela porównawcza w markdown; pozostałe H2 w miarę możliwości jako pytania, pierwszy akapit pod każdym H2 to 40-60 słów czystej odpowiedzi; min. 2-3 jednozdaniowe definicje "X to…"; każda sekcja zrozumiała samodzielnie; FAQ 5-8 pytań po 40-60 słów; łącznie maks. 1600 słów (bez FAQ).',
          `Slug MUSI pozostać dokładnie: ${current.slug} — adres jest już zaindeksowany.`,
          published.length
            ? `Kandydaci na linki wewnętrzne (użyj 2-5 pasujących):\n${published.map((p) => `- ${p.slug}: ${p.title}`).join('\n')}`
            : 'Brak innych opublikowanych artykułów — zostaw internal_link_suggestions puste.',
          'Zwróć kompletny artykuł: title, slug, meta_title (55-70 znaków), meta_description (150-160 znaków), primary_keyword, lead, tldr_bullets, sections, faq, internal_link_suggestions.',
        ].join('\n\n'),
      },
    ],
    output_config: { format: zodOutputFormat(ArticleSchema) },
  });
  if (!response.parsed_output) throw new Error('Refresh generation failed to parse.');
  track({ model: DRAFT_MODEL, usage: response.usage });
  let article = { ...response.parsed_output, slug: current.slug };

  const critiqueResp = await reviseArticle({ article, instructions: CRITIQUE_INSTRUCTIONS });
  track(critiqueResp);
  article = { ...critiqueResp.result, slug: current.slug };

  const validationOpts = { skipSlugCheck: true };
  let validation = validateArticle(article, keyword, validSlugs, facts.length > 0, validationOpts);
  let attempts = 0;
  while (!validation.ok && attempts < 2) {
    const fixResp = await reviseArticle({
      article,
      instructions: `Ten artykuł nie przeszedł automatycznej walidacji. Popraw dokładnie te problemy (slug zostaw bez zmian):\n${validation.errors.map((e) => `- ${e}`).join('\n')}`,
    });
    track(fixResp);
    article = { ...fixResp.result, slug: current.slug };
    validation = validateArticle(article, keyword, validSlugs, facts.length > 0, validationOpts);
    attempts++;
  }

  logger.info('SEO refresh draft generated', {
    tenantId, contentId, costUsd: totalCostUsd.toFixed(4), queriesUsed: queries.length, factsUsed: facts.length, validationOk: validation.ok,
  });

  return {
    title: article.title,
    meta_description: article.meta_description,
    body: renderBody(article, pillar),
    faq: article.faq,
    queries,
    facts_used: facts.length,
    // Kept rather than blocking the draft: the editor decides whether the
    // remaining issues matter enough to reject it.
    validation_errors: validation.ok ? [] : validation.errors,
    cost_usd: Number(totalCostUsd.toFixed(4)),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { generateArticle, refreshArticle, countGeneratedToday, validateArticle, renderBody, BRAND_VOICE };
