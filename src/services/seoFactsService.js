'use strict';
// ─────────────────────────────────────────────────────────────────
// services/seoFactsService.js — finds real, citable numeric data (price
// ranges, percentages, study results) for a SEO article's keyword, using
// Anthropic's server-side web_search tool. Exists because the article
// generation pipeline (seoContentService) deliberately never invents
// statistics — but real ones, properly cited, are exactly what both the
// classic-SEO and AI-Overview-citation guidance ask for ("brak liczb =
// niższy scoring"). Adam's explicit call (2026-09-25): give the model real
// web search instead of a curated facts table or going numbers-free.
//
// Deliberately NOT combined with the structured-output (Zod) calls in
// seoContentService — web_search is a multi-turn server tool and mixing it
// with output_config.format in one call is unverified API territory. This
// runs as its own plain-text call; the facts it returns are then fed as
// plain context into the existing structured outline/draft calls, the same
// pattern already used for GSC content-gap queries.
// ─────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const FACTS_MODEL = 'claude-sonnet-5';
const MAX_PAUSE_RESUMES = 3;

function parseFacts(text) {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((f) => f && typeof f.claim === 'string' && typeof f.source_url === 'string' && /^https?:\/\//.test(f.source_url))
    .slice(0, 4);
}

/**
 * Returns { facts: [{claim, source_url}], usage, model }. Never throws —
 * callers should still wrap in try/catch for defense in depth, but any
 * search/parse failure here resolves to an empty facts array rather than
 * rejecting, since going numbers-free is an acceptable degraded mode
 * (same posture as gscService's gap-query lookup).
 */
async function findFacts({ keyword, pillar }) {
  const messages = [
    {
      role: 'user',
      content: [
        `Wyszukaj 2-4 prawdziwe, aktualne dane liczbowe (widełki cenowe, procenty, wyniki badań, konkretne wartości) związane z tematem: "${keyword}".`,
        `Kontekst branżowy: ${pillar.description}`,
        'Dla KAŻDEGO znalezionego faktu podaj: samo stwierdzenie w jednym zdaniu po polsku (bez marketingowego tonu, sama liczba/dana) oraz URL źródła, z którego pochodzi.',
        'Odpowiedz WYŁĄCZNIE tablicą JSON w formacie: [{"claim": "...", "source_url": "https://..."}]. Bez żadnego innego tekstu przed ani po. Jeśli nie znajdziesz nic wiarygodnego i aktualnego, zwróć pustą tablicę [].',
      ].join('\n\n'),
    },
  ];

  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = '';

  try {
    for (let i = 0; i <= MAX_PAUSE_RESUMES; i++) {
      const response = await client.messages.create({
        model: FACTS_MODEL,
        max_tokens: 2000,
        tools,
        messages,
      });
      usage.input_tokens += response.usage?.input_tokens || 0;
      usage.output_tokens += response.usage?.output_tokens || 0;

      if (response.stop_reason === 'pause_turn' && i < MAX_PAUSE_RESUMES) {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      const textBlock = response.content.find((b) => b.type === 'text');
      finalText = textBlock?.text || '';
      break;
    }
  } catch (err) {
    logger.info('SEO facts research failed — proceeding without cited data', { reason: err.message });
    return { facts: [], usage, model: FACTS_MODEL };
  }

  return { facts: parseFacts(finalText), usage, model: FACTS_MODEL };
}

module.exports = { findFacts };
