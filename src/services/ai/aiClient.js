'use strict';
// ─────────────────────────────────────────────────────────────────
// services/ai/aiClient.js
//
// Wejście do AI dla funkcji, które korzystają z KLUCZA TENANTA. Wołający nie wie
// ani jakiego dostawcę ma tenant, ani jakiego modelu użyć, ani skąd wziąć klucz.
//
// KTO TO UŻYWA (stan na 2026-10-08): enrichment ICP prospektów i analizator
// rozmów. Znajdź konkurencję, SEO i asystent formularzy mobilnych świadomie
// zostają na kluczach systemowych z env — dwie pierwsze opierają się na
// serwerowym web_search Anthropica, który nie ma odpowiednika u pozostałych
// dostawców, więc ich przeniesienie to osobna decyzja. Nie dopisuj tu kolejnej
// funkcji bez sprawdzenia, czy nie potrzebuje zdolności specyficznej dla dostawcy.
//
// DECYZJA 2026-10-08: brak konfiguracji AI u tenanta = objęta funkcja wyłączona.
// Nie ma fallbacku na klucz systemowy z env — każdy tenant płaci za swoje AI.
// Dlatego callAi rzuca AiNotConfiguredError (status 409), a nie cicho zwraca
// pustą odpowiedź: wywołujący MUSI zdecydować, czy to błąd dla usera, czy
// pominięcie kroku. Ciche zero byłoby najgorsze — enrichment zapisałby się jako
// ukończony z wynikiem 0, dokładnie jak w błędzie naprawionym 2026-09-23.
//
// TIER modelu, nie model. Wywołujący podaje 'fast' albo 'quality', a nie nazwę
// modelu — nazwy należą do konfiguracji tenanta, nie do kodu funkcji:
//   fast    — zadania masowe i tanie (enrichment, analizator rozmów, asystent)
//   quality — długie treści i trudniejsze rozumowanie (SEO); gdy tenant nie
//             ustawił model_quality, spada na model_fast
// ─────────────────────────────────────────────────────────────────

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { decrypt } = require('../../utils/encrypt');
const { callProvider, AiProviderError } = require('./aiProviders');

/** Tenant nie skonfigurował AI — funkcja AI jest dla niego wyłączona. */
class AiNotConfiguredError extends Error {
  constructor(message = 'Tenant nie ma skonfigurowanego dostawcy AI. Ustawienia → AI.') {
    super(message);
    this.name = 'AiNotConfiguredError';
    this.status = 409;
  }
}

const TIERS = Object.freeze(['fast', 'quality']);

/**
 * Konfiguracja AI tenanta z rozszyfrowanym kluczem. Zwraca null, gdy tenant nie
 * ma wiersza — wywołujący rozstrzyga, czy to błąd.
 */
async function loadConfig(tenantId) {
  const { rows } = await db.query(
    `SELECT provider, api_key, model_fast, model_quality, base_url, status
       FROM tenant_ai_config WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return { ...row, apiKey: decrypt(row.api_key) };
}

/** Czy tenant ma działające AI — do gate'owania UI i pomijania kroków. */
async function isConfigured(tenantId) {
  const { rows } = await db.query(
    `SELECT 1 FROM tenant_ai_config WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  return rows.length > 0;
}

/**
 * Wywołanie AI w imieniu tenanta.
 *
 * @param {object}  params
 * @param {string}  params.tenantId
 * @param {string}  params.system       prompt systemowy
 * @param {string}  params.user         wiadomość użytkownika
 * @param {string} [params.tier]        'fast' (domyślnie) albo 'quality'
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {string} [params.purpose]     tylko do logów, np. 'enrichment'
 * @returns {Promise<{content:string, model:string, provider:string, usage:object}>}
 * @throws  {AiNotConfiguredError} gdy tenant nie ma konfiguracji lub klucz jest invalid
 * @throws  {AiProviderError}      gdy dostawca odrzucił żądanie
 */
async function callAi({ tenantId, system, user, tier = 'fast', maxTokens = 3000, temperature = 0, purpose = null }) {
  if (!TIERS.includes(tier)) throw new Error(`Nieznany tier modelu: ${tier}`);

  const config = await loadConfig(tenantId);
  if (!config) throw new AiNotConfiguredError();
  if (config.status === 'invalid') {
    throw new AiNotConfiguredError(
      'Klucz API dostawcy AI został odrzucony — podmień go w Ustawienia → AI.',
    );
  }

  // quality bez własnego modelu spada na fast — tenant nie musi wypełniać obu.
  const model = tier === 'quality' ? (config.model_quality || config.model_fast) : config.model_fast;

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
      tenantId, purpose, tier, provider: config.provider, model: result.model,
      promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
      contentLength: result.content?.length,
    });
    return { ...result, provider: config.provider };
  } catch (err) {
    // Klucz odrzucony przez dostawcę — zapisujemy to na konfiguracji, żeby panel
    // pokazał „podmień klucz", a kolejne wywołania nie dobijały dostawcy 401-ką.
    if (err instanceof AiProviderError && err.kind === 'invalid') {
      await db.query(
        `UPDATE tenant_ai_config
            SET status = 'invalid', last_error = $1, last_checked_at = now(), updated_at = now()
          WHERE tenant_id = $2`,
        [String(err.message).slice(0, 1000), tenantId],
      ).catch(() => { /* zapis diagnostyki nie może przykryć pierwotnego błędu */ });
    }
    logger.warn('[AI] wywołanie nieudane', {
      tenantId, purpose, tier, provider: config.provider, model,
      kind: err.kind || null, status: err.status || null, error: err.message,
    });
    throw err;
  }
}

module.exports = { callAi, isConfigured, loadConfig, AiNotConfiguredError };
