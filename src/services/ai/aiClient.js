'use strict';
// ─────────────────────────────────────────────────────────────────
// services/ai/aiClient.js
//
// Wejście do AI dla całej aplikacji. Wołający nie wie ani jakiego dostawcę ma
// tenant, ani jakiego modelu użyć, ani skąd wziąć klucz — podaje tylko FUNKCJĘ
// (`purpose`), a reszta wynika z konfiguracji tenanta.
//
// KAŻDA FUNKCJA MA WŁASNEGO DOSTAWCĘ, KLUCZ I MODEL (migracja 0327, jeden
// wiersz tenant_ai_config na funkcję). Klient może mieć enrichment na DeepSeeku,
// analizator rozmów na OpenAI, a „Znajdź konkurencję" na Anthropicu — i każda z
// tych funkcji rozlicza się na swoim koncie.
//
// KTO TO UŻYWA: wszystkie funkcje AI w CRMtree. Nic nie stoi już na kluczu
// systemowym z env:
//   enrichment            prospectEnrichmentService
//   call_analysis         callAnalysisService
//   competitor_discovery  competitorDiscoveryService      [web_search]
//   seo_facts             seoFactsService                 [web_search]
//   seo_research          seoContentService / seoStrategyService
//   seo_content           seoContentService / seoSocialService
//   assistant             assistant/assistantClient
// Dodając funkcję, dopisz jej klucz do PURPOSES w aiProviders.js — inaczej nie
// będzie miała ani modelu domyślnego, ani wiersza w panelu.
//
// DECYZJA 2026-10-08: brak wiersza dla funkcji = ta funkcja jest wyłączona.
// Nie ma fallbacku na klucz systemowy z env — każdy tenant płaci za swoje AI.
// Dlatego callAi rzuca AiNotConfiguredError (status 409), a nie cicho zwraca
// pustą odpowiedź: wywołujący MUSI zdecydować, czy to błąd dla usera, czy
// pominięcie kroku. Ciche zero byłoby najgorsze — enrichment zapisałby się jako
// ukończony z wynikiem 0, dokładnie jak w błędzie naprawionym 2026-09-23.
//
// GDY DOSTAWCA NIE UMIE TEGO, CZEGO FUNKCJA WYMAGA (web_search, wymuszony JSON),
// rzucamy AiPurposeUnsupportedError — osobny typ, nie „zły klucz": klucz jest
// dobry, brakuje zdolności, więc NIE wolno oznaczać wiersza jako invalid.
// Statusy i tak są per funkcja, więc problem jednej nigdy nie wyłącza reszty.
// ─────────────────────────────────────────────────────────────────

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { decrypt } = require('../../utils/encrypt');
const {
  callProvider,
  callProviderWithWebSearch,
  callProviderStructured,
  resolveModel,
  supportsPurpose,
  AiProviderError,
} = require('./aiProviders');

/** Tenant nie skonfigurował AI — funkcje AI są dla niego wyłączone. */
class AiNotConfiguredError extends Error {
  constructor(message = 'Tenant nie ma skonfigurowanego dostawcy AI. Ustawienia → Dostawca AI.') {
    super(message);
    this.name = 'AiNotConfiguredError';
    this.status = 409;
  }
}

/** Dostawca tenanta nie obsługuje tej funkcji (dziś: brak web_search). */
class AiPurposeUnsupportedError extends Error {
  constructor(message, { provider = null, purpose = null } = {}) {
    super(message);
    this.name = 'AiPurposeUnsupportedError';
    this.status = 409;
    this.provider = provider;
    this.purpose = purpose;
  }
}

/**
 * Konfiguracja JEDNEJ funkcji AI tenanta, z rozszyfrowanym kluczem. Zwraca null,
 * gdy funkcja nie jest skonfigurowana — wywołujący rozstrzyga, czy to błąd.
 */
async function loadConfig(tenantId, purpose) {
  const { rows } = await db.query(
    `SELECT purpose, provider, api_key, model, base_url, status
       FROM tenant_ai_config WHERE tenant_id = $1 AND purpose = $2`,
    [tenantId, purpose],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return { ...row, apiKey: decrypt(row.api_key) };
}

/**
 * Czy tenant ma skonfigurowaną I DZIAŁAJĄCĄ daną funkcję AI. Sprawdza też, czy
 * wybrany dostawca w ogóle umie to, czego funkcja wymaga — konfiguracja mogła
 * powstać, zanim funkcja dostała nowy wymóg.
 */
async function isPurposeAvailable(tenantId, purpose) {
  const { rows } = await db.query(
    `SELECT provider FROM tenant_ai_config
      WHERE tenant_id = $1 AND purpose = $2 AND status = 'active'`,
    [tenantId, purpose],
  );
  if (!rows.length) return false;
  return supportsPurpose(rows[0].provider, purpose);
}

/** Czy tenant ma skonfigurowaną JAKĄKOLWIEK funkcję AI — do gate'owania UI. */
async function isConfigured(tenantId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tenant_ai_config WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  return rows.length > 0;
}

/** Wspólna walidacja: funkcja skonfigurowana, klucz żyje, dostawca ją umie. */
async function prepare(tenantId, purpose) {
  const config = await loadConfig(tenantId, purpose);
  if (!config) {
    throw new AiNotConfiguredError(
      `Funkcja AI „${purpose}" nie jest skonfigurowana. Ustawienia → Dostawcy AI.`,
    );
  }
  if (config.status === 'invalid') {
    throw new AiNotConfiguredError(
      `Klucz API dla funkcji „${purpose}" został odrzucony — podmień go w Ustawienia → Dostawcy AI.`,
    );
  }
  // Model zapisany przez admina albo domyślny dla tego dostawcy i tej funkcji.
  const model = resolveModel(config.provider, purpose, config.model ? { [purpose]: config.model } : {});
  if (!model) {
    throw new AiPurposeUnsupportedError(
      `Dostawca ustawiony dla funkcji „${purpose}" jej nie obsługuje — zmień dostawcę w Ustawienia → Dostawcy AI.`,
      { provider: config.provider, purpose },
    );
  }
  return { config, model };
}

/**
 * Oznacza konfigurację jako invalid, gdy dostawca odrzucił klucz — żeby panel
 * pokazał „podmień klucz", a kolejne wywołania nie dobijały dostawcy 401-ką.
 */
async function markInvalid(tenantId, purpose, err) {
  await db.query(
    `UPDATE tenant_ai_config
        SET status = 'invalid', last_error = $1, last_checked_at = now(), updated_at = now()
      WHERE tenant_id = $2 AND purpose = $3`,
    [String(err.message).slice(0, 1000), tenantId, purpose],
  ).catch(() => { /* zapis diagnostyki nie może przykryć pierwotnego błędu */ });
}

/**
 * Wywołanie AI w imieniu tenanta.
 *
 * @param {object}  params
 * @param {string}  params.tenantId
 * @param {string}  params.purpose      klucz funkcji z PURPOSES — wybiera model
 * @param {string}  params.system       prompt systemowy
 * @param {string}  params.user         wiadomość użytkownika
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @returns {Promise<{content:string, model:string, provider:string, usage:object}>}
 * @throws  {AiNotConfiguredError}     brak konfiguracji albo odrzucony klucz
 * @throws  {AiPurposeUnsupportedError} dostawca nie umie tej funkcji
 * @throws  {AiProviderError}          dostawca odrzucił żądanie
 */
async function callAi({ tenantId, purpose, system, user, maxTokens = 3000, temperature = 0 }) {
  const { config, model } = await prepare(tenantId, purpose);

  try {
    const result = await callProvider(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.base_url,
      model,
      system,
      user,
      maxTokens,
      temperature,
    });
    logger.info('[AI] wywołanie zakończone', {
      tenantId, purpose, provider: config.provider, model: result.model,
      promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
      contentLength: result.content?.length,
    });
    return { ...result, provider: config.provider };
  } catch (err) {
    if (err instanceof AiProviderError && err.kind === 'invalid') await markInvalid(tenantId, purpose, err);
    logger.warn('[AI] wywołanie nieudane', {
      tenantId, purpose, provider: config.provider, model,
      kind: err.kind || null, status: err.status || null, error: err.message,
    });
    throw err;
  }
}

/**
 * Wywołanie, w którym model sam szuka w internecie. Tylko dla funkcji
 * oznaczonych `requiresWebSearch` i tylko u dostawcy, który to potrafi.
 *
 * @param {number} [params.maxUses]   ile razy model może wyszukać w jednej odpowiedzi
 * @param {number} [params.timeoutMs]
 */
async function callAiWithWebSearch({
  tenantId, purpose, system, user, maxTokens = 3000, maxUses = 4, timeoutMs,
}) {
  const { config, model } = await prepare(tenantId, purpose);

  try {
    const result = await callProviderWithWebSearch(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.base_url,
      model,
      system,
      user,
      maxTokens,
      maxUses,
      timeoutMs,
    });
    logger.info('[AI] wywołanie z web_search zakończone', {
      tenantId, purpose, provider: config.provider, model: result.model,
      promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
      contentLength: result.content?.length,
    });
    return { ...result, provider: config.provider };
  } catch (err) {
    if (err instanceof AiProviderError && err.kind === 'invalid') await markInvalid(tenantId, purpose, err);
    logger.warn('[AI] wywołanie z web_search nieudane', {
      tenantId, purpose, provider: config.provider, model,
      kind: err.kind || null, status: err.status || null, error: err.message,
    });
    throw err;
  }
}

/**
 * Wywołanie z wymuszoną strukturą odpowiedzi. Tylko dla funkcji oznaczonych
 * `structuredOutput` i tylko u dostawcy, który to potrafi.
 *
 * @param {object} params.jsonSchema  schemat odpowiedzi (z Zod: zodOutputFormat(S).schema)
 * @param {string} [params.schemaName] nazwa schematu — OpenAI jej wymaga
 * @returns {Promise<{parsed:object, content:string, model:string, provider:string, usage:object}>}
 */
async function callAiStructured({
  tenantId, purpose, system, user, messages, jsonSchema, schemaName,
  maxTokens = 3000, temperature = 0,
}) {
  const { config, model } = await prepare(tenantId, purpose);

  try {
    const result = await callProviderStructured(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.base_url,
      model,
      system,
      user,
      messages,
      jsonSchema,
      schemaName,
      maxTokens,
      temperature,
    });
    logger.info('[AI] wywołanie strukturalne zakończone', {
      tenantId, purpose, provider: config.provider, model: result.model,
      promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
    });
    return { ...result, provider: config.provider };
  } catch (err) {
    if (err instanceof AiProviderError && err.kind === 'invalid') await markInvalid(tenantId, purpose, err);
    logger.warn('[AI] wywołanie strukturalne nieudane', {
      tenantId, purpose, provider: config.provider, model,
      kind: err.kind || null, status: err.status || null, error: err.message,
    });
    throw err;
  }
}

module.exports = {
  callAi,
  callAiWithWebSearch,
  callAiStructured,
  isConfigured,
  isPurposeAvailable,
  loadConfig,
  AiNotConfiguredError,
  AiPurposeUnsupportedError,
};
