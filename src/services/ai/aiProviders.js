'use strict';
// ─────────────────────────────────────────────────────────────────
// services/ai/aiProviders.js
//
// Rejestr dostawców AI + adaptery. JEDYNE miejsce w kodzie, które wie, jak
// wygląda żądanie i odpowiedź konkretnego dostawcy.
//
// Wszystkie funkcje AI w CRMtree potrzebują dokładnie tego samego: prompt
// systemowy + wiadomość użytkownika → tekst, z limitem tokenów i temperaturą.
// Dlatego adapter to jedna funkcja o wspólnym kontrakcie:
//
//   call({ apiKey, baseUrl, model, system, user, maxTokens, temperature })
//     → { content, model, usage }
//
// `usage` jest znormalizowany do { prompt_tokens, completion_tokens } — pola
// specyficzne dla dostawcy (np. cache DeepSeeka) lądują w `usage.raw`, żeby
// logi i statystyki enrichmentu nie straciły tego, co dotąd zapisywały.
//
// DODANIE DOSTAWCY = jeden wpis w PROVIDERS. Reszta aplikacji (aiClient.js,
// trasy, frontend) czyta ten rejestr i nie wymaga zmian.
//
// Modele są polem TEKSTOWYM, nie listą zamkniętą. Katalogi modeli u dostawców
// zmieniają się częściej niż ten plik, a wpisanie nieistniejącego modelu i tak
// wychodzi od razu — klucz i model są walidowane realnym wywołaniem przed
// zapisem konfiguracji (patrz aiConfigService.verifyConfig).
// ─────────────────────────────────────────────────────────────────

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 90_000;

/** Błąd dostawcy z rozróżnieniem „zły klucz" od „coś się zepsuło". */
class AiProviderError extends Error {
  constructor(message, { kind = 'error', status = null, provider = null } = {}) {
    super(message);
    this.name = 'AiProviderError';
    // 'invalid' = dostawca odrzucił klucz/model i samo ponowienie nie pomoże;
    // 'error'   = sieć, 5xx, limit — warte ponowienia.
    this.kind = kind;
    this.status = status;
    this.provider = provider;
  }
}

function classify(err, provider) {
  const status = err.response?.status ?? null;
  const detail =
    err.response?.data?.error?.message ||
    err.response?.data?.error?.type ||
    err.response?.data?.message ||
    err.message;
  // 401/403 to zły lub cofnięty klucz; 404/400 przy poprawnym kluczu to prawie
  // zawsze nieistniejący model — w obu przypadkach ponowienie nic nie da.
  const kind = [400, 401, 403, 404].includes(status) ? 'invalid' : 'error';
  return new AiProviderError(detail || `Błąd dostawcy ${provider}`, { kind, status, provider });
}

function normalizeUsage(raw, promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens ?? null,
    completion_tokens: completionTokens ?? null,
    raw: raw ?? null,
  };
}

// ── Adapter: API zgodne z OpenAI (OpenAI, DeepSeek i dowolne proxy) ──────────
// Jeden kod dla obu, bo DeepSeek świadomie trzyma kontrakt /chat/completions.
async function callOpenAiCompatible({ apiKey, baseUrl, model, system, user, maxTokens, temperature, provider }) {
  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    const choice = data?.choices?.[0];
    return {
      content: choice?.message?.content || '',
      model: data?.model || model,
      usage: normalizeUsage(data?.usage, data?.usage?.prompt_tokens, data?.usage?.completion_tokens),
    };
  } catch (err) {
    throw classify(err, provider);
  }
}

// ── Adapter: Anthropic Messages API ─────────────────────────────────────────
// Prompt systemowy idzie osobnym polem `system` (nie wiadomością), a treść
// wraca w content[].text — inaczej niż u OpenAI. cache_control na prompcie
// systemowym zachowuje oszczędność, którą miało dotychczasowe wywołanie
// enrichmentu (prompt ICP jest długi i powtarzalny).
async function callAnthropic({ apiKey, baseUrl, model, system, user, maxTokens, temperature, provider }) {
  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
      {
        model,
        max_tokens: maxTokens,
        temperature,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    const text = (data?.content || [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('');
    return {
      content: text,
      model: data?.model || model,
      usage: normalizeUsage(data?.usage, data?.usage?.input_tokens, data?.usage?.output_tokens),
    };
  } catch (err) {
    throw classify(err, provider);
  }
}

// ── Adapter: Google Gemini (generativeLanguage) ─────────────────────────────
// Najbardziej odmienny kontrakt: klucz w query stringu, prompt systemowy jako
// systemInstruction, wiadomości jako contents[].parts[].text, limit tokenów
// pod generationConfig.maxOutputTokens, a model w ŚCIEŻCE URL-a.
async function callGemini({ apiKey, baseUrl, model, system, user, maxTokens, temperature, provider }) {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
    const { data } = await axios.post(
      url,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      },
      {
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part?.text || '')
      .join('');
    const meta = data?.usageMetadata;
    return {
      content: text,
      model: data?.modelVersion || model,
      usage: normalizeUsage(meta, meta?.promptTokenCount, meta?.candidatesTokenCount),
    };
  } catch (err) {
    throw classify(err, provider);
  }
}

// ── Rejestr ─────────────────────────────────────────────────────────────────
// suggestedFast/suggestedQuality to TYLKO podpowiedzi dla pola tekstowego w
// panelu — nic ich nie waliduje poza realnym wywołaniem u dostawcy. Dla
// Anthropica podane ID są zweryfikowane; dla pozostałych to rozsądny punkt
// startowy, który admin może nadpisać dowolnym modelem ze swojego konta.
const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    suggestedFast: 'claude-haiku-4-5',
    suggestedQuality: 'claude-sonnet-5',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    call: callAnthropic,
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    baseUrl: 'https://api.openai.com/v1',
    suggestedFast: 'gpt-4.1-mini',
    suggestedQuality: 'gpt-4.1',
    keysUrl: 'https://platform.openai.com/api-keys',
    call: callOpenAiCompatible,
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    suggestedFast: 'gemini-2.5-flash',
    suggestedQuality: 'gemini-2.5-pro',
    keysUrl: 'https://aistudio.google.com/apikey',
    call: callGemini,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    suggestedFast: 'deepseek-chat',
    suggestedQuality: 'deepseek-chat',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    call: callOpenAiCompatible,
  },
});

const PROVIDER_KEYS = Object.freeze(Object.keys(PROVIDERS));

/** Dostawcy do wyboru w panelu — bez adapterów, same dane dla UI. */
function listProviders() {
  return PROVIDER_KEYS.map(key => ({
    key,
    label: PROVIDERS[key].label,
    suggested_fast: PROVIDERS[key].suggestedFast,
    suggested_quality: PROVIDERS[key].suggestedQuality,
    keys_url: PROVIDERS[key].keysUrl,
  }));
}

/**
 * Jedno wywołanie AI u wskazanego dostawcy. Nie zna pojęcia tenanta ani
 * konfiguracji — to warstwa aiClient.js.
 */
async function callProvider(provider, { apiKey, baseUrl, model, system, user, maxTokens = 3000, temperature = 0 }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new AiProviderError(`Nieznany dostawca AI: ${provider}`, { kind: 'invalid', provider });
  return entry.call({
    apiKey,
    baseUrl: baseUrl || entry.baseUrl,
    model,
    system,
    user,
    maxTokens,
    temperature,
    provider,
  });
}

module.exports = {
  PROVIDER_KEYS,
  AiProviderError,
  listProviders,
  callProvider,
  defaultBaseUrl: provider => PROVIDERS[provider]?.baseUrl ?? null,
};
