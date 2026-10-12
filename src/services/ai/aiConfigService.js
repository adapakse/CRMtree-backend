'use strict';
// ─────────────────────────────────────────────────────────────────
// services/ai/aiConfigService.js
//
// Konfiguracja AI tenanta: odczyt dla panelu, zapis z weryfikacją, usunięcie.
// JEDEN WIERSZ NA FUNKCJĘ — każda może mieć innego dostawcę, inny klucz i inny
// model (migracja 0327).
//
// KLUCZ I MODEL SĄ WERYFIKOWANE PRZED ZAPISEM — robimy realne, minimalne
// wywołanie u dostawcy. Ten sam wzorzec co tokeny KSeF (uwierzytelnienie w KSeF
// przed zapisem) i numer WhatsApp (walidacja w Meta przy każdym zapisie). Bez
// tego admin zapisywałby literówkę w kluczu albo nieistniejący model i
// dowiadywał się o tym dopiero z nieudanego enrichmentu kilka godzin później.
//
// KLUCZ WKLEJA SIĘ RAZ NA DOSTAWCĘ, nie raz na funkcję: zapis bez klucza bierze
// ten, który jest już zapisany dla tego samego dostawcy przy innej funkcji
// (reuseKeyFor). Dzięki temu „DeepSeek do enrichmentu i do analizatora rozmów"
// to jedno wklejenie, a mimo to każda funkcja może dostać osobny klucz, gdy ktoś
// chce rozdzielić rozliczenia. Klucz jest KOPIOWANY do wiersza, nie wskazywany
// referencją — usunięcie jednej funkcji nie może rozbroić pozostałych.
//
// KLUCZ NIGDY NIE WRACA Z API. getConfig zwraca api_key_hint (4 ostatnie znaki),
// nigdy samego klucza — tak jak ksef_companies.token_hint. Klucz nie trafia też
// do logów ani do komunikatów błędów.
// ─────────────────────────────────────────────────────────────────

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/encrypt');
const {
  callProvider,
  listProviders,
  listProviderModels,
  detectProviderCandidates,
  listPurposes,
  resolveModel,
  supportsPurpose,
  PROVIDER_KEYS,
  PURPOSE_KEYS,
  AiProviderError,
} = require('./aiProviders');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const HINT_LENGTH = 4;
const hintOf = key => String(key).slice(-HINT_LENGTH);

const CONFIG_COLUMNS = `purpose, provider, api_key_hint, model, base_url,
                        status, last_error, last_checked_at, updated_at`;

/**
 * Konfiguracja wszystkich funkcji do pokazania w panelu — BEZ kluczy. Zwraca też
 * rejestr dostawców i funkcji, żeby frontend nie musiał trzymać własnej kopii
 * listy modeli domyślnych ani wiedzieć, który dostawca czego nie potrafi.
 */
async function getConfig(tenantId) {
  const { rows } = await db.query(
    `SELECT c.purpose, c.provider, c.api_key_hint, c.model, c.base_url,
            c.status, c.last_error, c.last_checked_at, c.updated_at,
            u.display_name AS updated_by_name
       FROM tenant_ai_config c
       LEFT JOIN users u ON u.id = c.updated_by
      WHERE c.tenant_id = $1`,
    [tenantId],
  );
  return {
    // Mapa funkcja → konfiguracja. Brak wpisu = funkcja nieskonfigurowana,
    // czyli u tego tenanta wyłączona (nie ma fallbacku na klucz systemowy).
    config: Object.fromEntries(rows.map(row => [row.purpose, row])),
    providers: listProviders(),
    purposes: listPurposes(),
  };
}

function assertPurpose(purpose) {
  if (!PURPOSE_KEYS.includes(purpose)) throw httpError(400, `Nieznana funkcja AI: ${purpose}`);
}

/**
 * Klucz zapisany już dla tego dostawcy przy innej funkcji. Pozwala wkleić klucz
 * raz i użyć go w kolejnych funkcjach tego samego dostawcy.
 */
async function reuseKeyFor(tenantId, provider, { excludePurpose = null } = {}) {
  const { rows } = await db.query(
    `SELECT api_key FROM tenant_ai_config
      WHERE tenant_id = $1 AND provider = $2 AND ($3::text IS NULL OR purpose <> $3::text)
      ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, provider, excludePurpose],
  );
  return rows.length ? decrypt(rows[0].api_key) : null;
}

/**
 * Rozpoznaje dostawcę po samym kluczu — admin nie musi go wybierać z listy.
 *
 * Prefiks tylko ZAWĘŻA kandydatów (OpenAI i DeepSeek wydają klucze zaczynające
 * się tak samo od „sk-"), więc wynik POTWIERDZAMY odpytaniem o listę modeli.
 * To żądanie nie zużywa tokenów, a daje pewność zamiast heurystyki: klucz jest
 * ważny u dokładnie jednego dostawcy, więc pierwszy, który go przyjmie, jest
 * tym właściwym.
 *
 * Zwraca też listę modeli, bo i tak ją pobraliśmy — panel dostaje rozpoznanie
 * i listę w jednym żądaniu, zamiast pytać dwa razy.
 */
async function resolveProviderForKey(apiKey, { baseUrl = null } = {}) {
  const candidates = detectProviderCandidates(apiKey);
  if (!candidates.length) throw httpError(400, 'Podaj klucz API.');

  let lastError = null;
  for (const provider of candidates) {
    try {
      const models = await listProviderModels(provider, { apiKey, baseUrl });
      return { provider, models };
    } catch (err) {
      // Odrzucenie klucza znaczy „to nie ten dostawca" — próbujemy kolejnego.
      // Awarię sieci zapamiętujemy, żeby nie zgłosić jej jako „zły klucz".
      if (err instanceof AiProviderError && err.kind === 'invalid') continue;
      lastError = err;
    }
  }
  if (lastError) {
    throw httpError(502, `Nie udało się połączyć z dostawcą AI: ${lastError.message}`);
  }
  throw httpError(422, 'Nie rozpoznano dostawcy dla tego klucza — żaden z obsługiwanych go nie przyjął.');
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

/** Zamienia błąd dostawcy na błąd HTTP z czytelnym powodem. */
function toHttpFailure(err, model) {
  // Brak środków to nie „zła konfiguracja" — klucz i model są dobre, konto jest
  // puste. Osobny status i komunikat, żeby admin nie szukał błędu w ustawieniach.
  if (err.isLowBalance) {
    return httpError(402, `Konto u dostawcy AI nie ma środków: ${err.message}`);
  }
  if (err instanceof AiProviderError && err.kind === 'invalid') {
    return httpError(422, `Dostawca odrzucił konfigurację dla modelu "${model}": ${err.message}`);
  }
  return httpError(502, `Nie udało się połączyć z dostawcą AI (model "${model}"): ${err.message}`);
}

/**
 * Zapis konfiguracji JEDNEJ funkcji. `apiKey` jest opcjonalny, gdy ten sam
 * dostawca ma już zapisany klucz przy innej funkcji albo przy tej samej (zmiana
 * samego modelu nie wymaga ponownego wklejania klucza — API go nie zwraca, więc
 * admin nie miałby go skąd przepisać).
 */
async function saveConfig(tenantId, purpose, { provider, apiKey, model, baseUrl }, { actorUserId = null } = {}) {
  assertPurpose(purpose);

  const cleanKey = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null;

  const { rows: currentRows } = await db.query(
    'SELECT api_key, provider FROM tenant_ai_config WHERE tenant_id = $1 AND purpose = $2',
    [tenantId, purpose],
  );
  const existing = currentRows[0];

  // Dostawcy nie trzeba podawać: rozpoznajemy go z samego klucza (potwierdzone
  // odpytaniem dostawcy, nie zgadywane z prefiksu). Jawny `provider` wygrywa —
  // zostaje dla przypadków, których rozpoznanie nie obejmuje, np. API zgodnego
  // z OpenAI pod własnym adresem. Bez klucza i bez dostawcy (zmiana samego
  // modelu) zostaje dostawca już zapisany przy tej funkcji.
  if (!provider) {
    if (cleanKey) ({ provider } = await resolveProviderForKey(cleanKey, { baseUrl: baseUrl || null }));
    else if (existing) provider = existing.provider;
  }
  if (!PROVIDER_KEYS.includes(provider)) {
    throw httpError(400, 'Nie wiadomo, u jakiego dostawcy zapisać tę funkcję — podaj klucz API.');
  }
  // Dostawca bez zdolności wymaganej przez tę funkcję odpada od razu, bez
  // dotykania sieci — inaczej zapisalibyśmy konfigurację, która nigdy nie zadziała.
  if (!supportsPurpose(provider, purpose)) {
    throw httpError(400, `Dostawca ${provider} nie obsługuje funkcji „${purpose}".`);
  }

  let effectiveKey = cleanKey;
  if (!effectiveKey && existing && existing.provider === provider) {
    effectiveKey = decrypt(existing.api_key);
  }
  if (!effectiveKey) {
    // Zmiana dostawcy albo pierwsza konfiguracja tej funkcji — klucz poprzedniego
    // dostawcy jest bezużyteczny, ale klucz tego samego dostawcy z innej funkcji już nie.
    effectiveKey = await reuseKeyFor(tenantId, provider, { excludePurpose: purpose });
  }
  if (!effectiveKey) {
    throw httpError(400, 'Klucz API jest wymagany — ten dostawca nie ma jeszcze zapisanego klucza.');
  }

  const url = baseUrl && String(baseUrl).trim() ? String(baseUrl).trim() : null;
  const chosenModel = model && String(model).trim() ? String(model).trim() : null;
  const effectiveModel = resolveModel(provider, purpose, chosenModel ? { [purpose]: chosenModel } : {});
  if (!effectiveModel) {
    throw httpError(400, `Brak modelu dla funkcji „${purpose}" u dostawcy ${provider}.`);
  }

  try {
    await verifyModel(provider, { apiKey: effectiveKey, baseUrl: url, model: effectiveModel });
  } catch (err) {
    throw toHttpFailure(err, effectiveModel);
  }

  const { rows } = await db.query(
    `INSERT INTO tenant_ai_config
       (tenant_id, purpose, provider, api_key, api_key_hint, model, base_url,
        status, last_error, last_checked_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',NULL,now(),$8)
     ON CONFLICT (tenant_id, purpose) DO UPDATE SET
       provider = EXCLUDED.provider,
       api_key = EXCLUDED.api_key,
       api_key_hint = EXCLUDED.api_key_hint,
       model = EXCLUDED.model,
       base_url = EXCLUDED.base_url,
       status = 'active',
       last_error = NULL,
       last_checked_at = now(),
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING ${CONFIG_COLUMNS}`,
    [tenantId, purpose, provider, encrypt(effectiveKey), hintOf(effectiveKey),
     chosenModel, url, actorUserId],
  );

  // Logujemy fakt, dostawcę, model i hint — NIGDY klucza.
  logger.info('[AI] zapisano konfigurację funkcji', {
    tenantId, purpose, provider, model: effectiveModel, keyHint: hintOf(effectiveKey),
  });
  return rows[0];
}

/** Usunięcie konfiguracji JEDNEJ funkcji = wyłączenie tylko jej. */
async function deleteConfig(tenantId, purpose) {
  assertPurpose(purpose);
  const { rowCount } = await db.query(
    'DELETE FROM tenant_ai_config WHERE tenant_id = $1 AND purpose = $2', [tenantId, purpose],
  );
  if (!rowCount) throw httpError(404, 'Ta funkcja AI nie jest skonfigurowana.');
  logger.info('[AI] usunięto konfigurację funkcji — funkcja wyłączona', { tenantId, purpose });
  return { deleted: true, purpose };
}

/**
 * Ponowna weryfikacja zapisanej konfiguracji funkcji — przycisk „Sprawdź
 * połączenie". Aktualizuje status, żeby panel i sama funkcja widziały ten sam stan.
 */
async function recheckConfig(tenantId, purpose) {
  assertPurpose(purpose);
  const { rows } = await db.query(
    `SELECT provider, api_key, model, base_url
       FROM tenant_ai_config WHERE tenant_id = $1 AND purpose = $2`,
    [tenantId, purpose],
  );
  if (!rows.length) throw httpError(404, 'Ta funkcja AI nie jest skonfigurowana.');
  const row = rows[0];
  const model = resolveModel(row.provider, purpose, row.model ? { [purpose]: row.model } : {});

  try {
    await verifyModel(row.provider, { apiKey: decrypt(row.api_key), baseUrl: row.base_url, model });
    await db.query(
      `UPDATE tenant_ai_config SET status='active', last_error=NULL, last_checked_at=now(), updated_at=now()
        WHERE tenant_id = $1 AND purpose = $2`, [tenantId, purpose],
    );
    return { purpose, status: 'active', last_error: null };
  } catch (err) {
    const failure = toHttpFailure(err, model);
    // 422 = dostawca odrzucił klucz lub model; wszystko inne (sieć, brak środków,
    // limit) jest przejściowe i warte ponowienia, więc nie pali konfiguracji.
    const status = failure.status === 422 ? 'invalid' : 'error';
    await db.query(
      `UPDATE tenant_ai_config SET status=$1, last_error=$2, last_checked_at=now(), updated_at=now()
        WHERE tenant_id = $3 AND purpose = $4`,
      [status, String(failure.message).slice(0, 1000), tenantId, purpose],
    );
    return { purpose, status, last_error: failure.message };
  }
}

/**
 * Modele dostępne na koncie u danego dostawcy — do listy wyboru w panelu.
 * Klucz bierzemy z podanego w żądaniu albo z już zapisanego dla tego dostawcy
 * (przy dowolnej funkcji), więc po skonfigurowaniu jednej funkcji listy w
 * pozostałych działają bez ponownego wklejania.
 */
async function listModels(tenantId, { provider, apiKey, baseUrl } = {}) {
  const cleanKey = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null;

  // Bez wskazanego dostawcy rozpoznajemy go z klucza i przy okazji mamy listę —
  // to ta sama odpowiedź, więc panel nie musi pytać dwa razy.
  if (!provider) {
    if (!cleanKey) throw httpError(400, 'Podaj klucz API albo wskaż dostawcę.');
    return resolveProviderForKey(cleanKey, { baseUrl: baseUrl || null });
  }

  if (!PROVIDER_KEYS.includes(provider)) throw httpError(400, 'Wybierz dostawcę AI.');
  const effectiveKey = cleanKey || await reuseKeyFor(tenantId, provider);
  if (!effectiveKey) {
    throw httpError(400, 'Podaj klucz API tego dostawcy, żeby pobrać listę modeli.');
  }

  try {
    return {
      provider,
      models: await listProviderModels(provider, { apiKey: effectiveKey, baseUrl: baseUrl || null }),
    };
  } catch (err) {
    if (err instanceof AiProviderError && err.kind === 'invalid') {
      throw httpError(422, `Dostawca odrzucił klucz: ${err.message}`);
    }
    throw httpError(502, `Nie udało się pobrać listy modeli: ${err.message}`);
  }
}

module.exports = {
  getConfig, saveConfig, deleteConfig, recheckConfig, listModels, resolveProviderForKey,
};
