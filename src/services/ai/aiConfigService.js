'use strict';
// ─────────────────────────────────────────────────────────────────
// services/ai/aiConfigService.js
//
// Konfiguracja AI tenanta: odczyt dla panelu, zapis z weryfikacją, usunięcie.
//
// KLUCZ JEST WERYFIKOWANY PRZED ZAPISEM — robimy realne, minimalne wywołanie u
// dostawcy wybranym modelem. Ten sam wzorzec co tokeny KSeF (uwierzytelnienie w
// KSeF przed zapisem) i numer WhatsApp (walidacja w Meta przy każdym zapisie).
// Bez tego admin zapisywałby literówkę w kluczu albo nieistniejący model i
// dowiadywał się o tym dopiero z nieudanego enrichmentu kilka godzin później.
//
// Weryfikacja sprawdza OBA modele, jeśli oba są podane — nieistniejący
// model_quality wyszedłby inaczej dopiero przy pierwszym generowaniu treści SEO.
//
// KLUCZ NIGDY NIE WRACA Z API. getConfig zwraca api_key_hint (4 ostatnie znaki),
// nigdy samego klucza — tak jak ksef_companies.token_hint. Klucz nie trafia też
// do logów ani do komunikatów błędów.
// ─────────────────────────────────────────────────────────────────

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/encrypt');
const { callProvider, listProviders, PROVIDER_KEYS, AiProviderError } = require('./aiProviders');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const HINT_LENGTH = 4;
const hintOf = key => String(key).slice(-HINT_LENGTH);

/**
 * Konfiguracja do pokazania w panelu — BEZ klucza. Zwraca też listę dostawców,
 * żeby frontend nie musiał trzymać własnej kopii rejestru.
 */
async function getConfig(tenantId) {
  const { rows } = await db.query(
    `SELECT c.provider, c.api_key_hint, c.model_fast, c.model_quality, c.base_url,
            c.status, c.last_error, c.last_checked_at, c.updated_at,
            u.display_name AS updated_by_name
       FROM tenant_ai_config c
       LEFT JOIN users u ON u.id = c.updated_by
      WHERE c.tenant_id = $1`,
    [tenantId],
  );
  return {
    // null = tenant nie skonfigurował AI, czyli wszystkie funkcje AI są u niego
    // wyłączone (nie ma fallbacku na klucz systemowy).
    config: rows[0] ?? null,
    providers: listProviders(),
  };
}

/**
 * Minimalne, realne wywołanie u dostawcy — sprawdza jednocześnie klucz i to, czy
 * model istnieje. Krótki prompt i 16 tokenów wyjścia, żeby weryfikacja była
 * tania; nie interesuje nas treść odpowiedzi, tylko że żądanie przeszło.
 */
async function verifyModel(provider, { apiKey, baseUrl, model }) {
  await callProvider(provider, {
    apiKey,
    baseUrl,
    model,
    system: 'Odpowiadaj jednym słowem.',
    user: 'ping',
    maxTokens: 16,
    temperature: 0,
  });
}

/**
 * Zapis konfiguracji. `apiKey` jest opcjonalny przy aktualizacji — gdy admin
 * zmienia tylko model, nie musi ponownie wklejać klucza (i nie może go podejrzeć,
 * bo API go nie zwraca).
 */
async function saveConfig(tenantId, { provider, apiKey, modelFast, modelQuality, baseUrl }, { actorUserId = null } = {}) {
  if (!PROVIDER_KEYS.includes(provider)) {
    throw httpError(400, `Nieznany dostawca AI: ${provider}`);
  }
  if (!modelFast || !String(modelFast).trim()) {
    throw httpError(400, 'Model podstawowy jest wymagany.');
  }

  const { rows: existingRows } = await db.query(
    'SELECT api_key FROM tenant_ai_config WHERE tenant_id = $1', [tenantId],
  );
  const existing = existingRows[0];

  // Klucz: nowy z żądania albo dotychczasowy. Brak obu = nie ma czym wołać.
  const effectiveKey = apiKey && String(apiKey).trim()
    ? String(apiKey).trim()
    : (existing ? decrypt(existing.api_key) : null);
  if (!effectiveKey) {
    throw httpError(400, 'Klucz API jest wymagany przy pierwszym zapisie konfiguracji.');
  }

  const fast = String(modelFast).trim();
  const quality = modelQuality && String(modelQuality).trim() ? String(modelQuality).trim() : null;
  const url = baseUrl && String(baseUrl).trim() ? String(baseUrl).trim() : null;

  // Weryfikacja przed zapisem — oba modele, jeśli różne.
  const toVerify = quality && quality !== fast ? [fast, quality] : [fast];
  for (const model of toVerify) {
    try {
      await verifyModel(provider, { apiKey: effectiveKey, baseUrl: url, model });
    } catch (err) {
      if (err instanceof AiProviderError && err.kind === 'invalid') {
        throw httpError(422, `Dostawca odrzucił konfiguracją dla modelu "${model}": ${err.message}`);
      }
      throw httpError(502, `Nie udało się połączyć z dostawcą AI (model "${model}"): ${err.message}`);
    }
  }

  const { rows } = await db.query(
    `INSERT INTO tenant_ai_config
       (tenant_id, provider, api_key, api_key_hint, model_fast, model_quality, base_url,
        status, last_error, last_checked_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',NULL,now(),$8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       api_key = EXCLUDED.api_key,
       api_key_hint = EXCLUDED.api_key_hint,
       model_fast = EXCLUDED.model_fast,
       model_quality = EXCLUDED.model_quality,
       base_url = EXCLUDED.base_url,
       status = 'active',
       last_error = NULL,
       last_checked_at = now(),
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING provider, api_key_hint, model_fast, model_quality, base_url, status, last_checked_at`,
    [tenantId, provider, encrypt(effectiveKey), hintOf(effectiveKey), fast, quality, url, actorUserId],
  );

  // Logujemy fakt i hint, NIGDY klucza.
  logger.info('[AI] zapisano konfigurację tenanta', {
    tenantId, provider, modelFast: fast, modelQuality: quality, keyHint: hintOf(effectiveKey),
  });
  return rows[0];
}

/**
 * Usunięcie konfiguracji = wyłączenie wszystkich funkcji AI dla tenanta. Celowo
 * nie zostawiamy „osieroconego" klucza w bazie.
 */
async function deleteConfig(tenantId) {
  const { rowCount } = await db.query('DELETE FROM tenant_ai_config WHERE tenant_id = $1', [tenantId]);
  if (!rowCount) throw httpError(404, 'Ten tenant nie ma konfiguracji AI.');
  logger.info('[AI] usunięto konfigurację tenanta — funkcje AI wyłączone', { tenantId });
  return { deleted: true };
}

/**
 * Ponowna weryfikacja zapisanej konfiguracji — przycisk „Sprawdź połączenie".
 * Aktualizuje status, żeby panel i funkcje AI widziały ten sam stan.
 */
async function recheckConfig(tenantId) {
  const { rows } = await db.query(
    `SELECT provider, api_key, model_fast, model_quality, base_url
       FROM tenant_ai_config WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) throw httpError(404, 'Ten tenant nie ma konfiguracji AI.');
  const row = rows[0];
  const apiKey = decrypt(row.api_key);

  try {
    await verifyModel(row.provider, { apiKey, baseUrl: row.base_url, model: row.model_fast });
    await db.query(
      `UPDATE tenant_ai_config SET status='active', last_error=NULL, last_checked_at=now(), updated_at=now()
        WHERE tenant_id = $1`, [tenantId],
    );
    return { status: 'active', last_error: null };
  } catch (err) {
    const status = err instanceof AiProviderError && err.kind === 'invalid' ? 'invalid' : 'error';
    await db.query(
      `UPDATE tenant_ai_config SET status=$1, last_error=$2, last_checked_at=now(), updated_at=now()
        WHERE tenant_id = $3`,
      [status, String(err.message).slice(0, 1000), tenantId],
    );
    return { status, last_error: err.message };
  }
}

module.exports = { getConfig, saveConfig, deleteConfig, recheckConfig };
