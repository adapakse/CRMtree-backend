'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoFactsService.js — finds real, citable numeric data (price
// ranges, percentages, study results) and attributed quotes for a SEO
// article's keyword, using Anthropic's server-side web_search tool. Exists
// because the article generation pipeline (seoContentService) deliberately
// never invents statistics — but real ones, properly cited, are exactly
// what both the classic-SEO and AI-Overview-citation guidance ask for
// ("brak liczb = niższy scoring"). Adam's explicit call (2026-09-25): give
// the model real web search instead of a curated facts table or going
// numbers-free.
//
// Quotes (added 2026-09-28) only pre-fill an article's quote slot for the
// editor to confirm, and only after verifyQuoteOnPage finds the exact
// wording on the cited page — a model can paraphrase or misattribute a
// quote while still returning a plausible URL, and a made-up quote with a
// real person's name on it is worse than no quote at all.
//
// Deliberately NOT combined with the structured-output (Zod) calls in
// seoContentService — web_search is a multi-turn server tool and mixing it
// with output_config.format in one call is unverified API territory. This
// runs as its own plain-text call; the facts it returns are then fed as
// plain context into the existing structured outline/draft calls, the same
// pattern already used for GSC content-gap queries.
// ─────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');
const { callAiWithWebSearch } = require('./ai/aiClient');

// Provider, key and model come from the TENANT's configuration (tenant_ai_config,
// migration 0327), purpose 'seo_facts'. The multi-turn pause_turn loop that the
// server-side web_search needs now lives in the provider adapter.
//
// This purpose REQUIRES Anthropic: web_search is its server-side tool and the
// other providers have no equivalent with the same contract. A tenant on another
// provider gets a 409 from aiClient, which findFacts treats like any other
// failure — going numbers-free is an acceptable degraded mode.
const AI_PURPOSE = 'seo_facts';
const QUOTE_FETCH_TIMEOUT_MS = 10000;

function parseJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const isHttpsUrl = (url) => typeof url === 'string' && /^https:\/\//.test(url);

function parseFacts(parsed, maxFacts) {
  if (!Array.isArray(parsed?.facts)) return [];
  return parsed.facts
    .filter((f) => f && typeof f.claim === 'string' && isHttpsUrl(f.source_url))
    .slice(0, maxFacts);
}

function parseQuotes(parsed) {
  if (!Array.isArray(parsed?.quotes)) return [];
  return parsed.quotes
    .filter((q) => q && typeof q.quote === 'string' && typeof q.author === 'string' && isHttpsUrl(q.source_url))
    .filter((q) => q.quote.length >= 40 && q.quote.length <= 400)
    .slice(0, 3);
}

function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#8220;|&#8221;|&#8222;|&#39;|&#8217;/g, '')
    .replace(/["„”“'’‘«»]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True only when the quote's exact wording appears in the page's text. */
async function verifyQuoteOnPage(url, quote) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRMtreeSEObot/1.0)' },
    });
    if (!response.ok) return false;
    const html = await response.text();
    const pageText = normalizeForMatch(
      html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '),
    );
    return pageText.includes(normalizeForMatch(quote));
  } catch {
    return false;
  }
}

/**
 * Returns { facts: [{claim, source_url}], quotes: [{quote, author, author_role,
 * source_title, source_url}], usage, model }. Never throws — any search/parse
 * failure resolves to empty arrays, since going numbers-free is an acceptable
 * degraded mode (same posture as gscService's gap-query lookup).
 * Expert topics (law, AI, security, finance) get more facts: the expert review
 * of 2026-09-28 asked for noticeably more sourcing on those.
 */
async function findFacts(tenantId, { keyword, pillar, isExpertTopic = false }) {
  const factRange = isExpertTopic ? '4-6' : '2-4';
  const maxFacts = isExpertTopic ? 6 : 4;
  const prompt = [
        `Wyszukaj ${factRange} prawdziwe, aktualne dane liczbowe (widełki cenowe, procenty, wyniki badań, konkretne wartości) związane z tematem: "${keyword}".`,
        isExpertTopic
          ? 'To temat ekspercki — preferuj źródła pierwotne: akty prawne, oficjalne wytyczne, raporty badawcze, dane instytucji publicznych. Unikaj blogów marketingowych.'
          : null,
        `Kontekst branżowy: ${pillar.description}`,
        'Dla KAŻDEGO znalezionego faktu podaj: samo stwierdzenie w jednym zdaniu po polsku (bez marketingowego tonu, sama liczba/dana) oraz URL źródła, z którego pochodzi.',
        'Znajdź też 1-3 dosłowne cytaty na ten temat z wiarygodnych źródeł (raport, badanie, regulacja, wypowiedź rozpoznawalnego eksperta lub instytucji). Cytat przepisz DOKŁADNIE tak, jak brzmi na stronie źródłowej, w oryginalnym języku, bez skracania i parafrazy (40-400 znaków). Podaj autora (osobę lub instytucję), jego rolę, tytuł źródła i URL strony, na której cytat się znajduje.',
        'Odpowiedz WYŁĄCZNIE obiektem JSON w formacie: {"facts": [{"claim": "...", "source_url": "https://..."}], "quotes": [{"quote": "...", "author": "...", "author_role": "...", "source_title": "...", "source_url": "https://..."}]}. Bez żadnego innego tekstu przed ani po. Jeśli nie znajdziesz nic wiarygodnego, zwróć puste tablice.',
  ].filter(Boolean).join('\n\n');

  let finalText = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let model = null;

  try {
    const response = await callAiWithWebSearch({
      tenantId,
      purpose: AI_PURPOSE,
      user: prompt,
      maxTokens: 3000,
      maxUses: isExpertTopic ? 6 : 4,
    });
    finalText = response.content || '';
    model = response.model;
    // Reported under the names the rest of the SEO pipeline already uses; the
    // provider adapter normalises every provider to prompt_/completion_tokens.
    usage = {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    };
  } catch (err) {
    logger.info('SEO facts research failed — proceeding without cited data', { tenantId, reason: err.message });
    return { facts: [], quotes: [], usage, model };
  }

  const parsed = parseJsonObject(finalText);
  const candidateQuotes = parseQuotes(parsed);
  const checks = await Promise.all(candidateQuotes.map((q) => verifyQuoteOnPage(q.source_url, q.quote)));
  const quotes = candidateQuotes.filter((_q, i) => checks[i]);
  if (candidateQuotes.length !== quotes.length) {
    logger.info('SEO facts research: dropped quotes not found verbatim on their source page', {
      keyword, found: candidateQuotes.length, verified: quotes.length,
    });
  }

  return { facts: parseFacts(parsed, maxFacts), quotes, usage, model };
}

module.exports = { findFacts, verifyQuoteOnPage, normalizeForMatch };
