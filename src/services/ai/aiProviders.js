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
//
// MODELE DOMYŚLNE SIEDZĄ TUTAJ, NIE W BAZIE. Tenant, który nie wpisał modelu
// dla danej funkcji, dostaje domyślny dla swojego dostawcy — i po wdrożeniu
// nowszego modelu dostaje go bez edycji wiersza w bazie. To celowe: katalogi
// modeli zmieniają się co kilka tygodni, schemat bazy nie.
//
// DRUGI ADAPTER: web_search. Dwie funkcje (Znajdź konkurencję, research faktów
// SEO) nie są zwykłym „prompt → tekst": model w trakcie odpowiedzi sam szuka w
// sieci SERWEROWYM narzędziem Anthropica, co wymaga pętli po turach. Ma to
// własny adapter i jest dostępne WYŁĄCZNIE u Anthropica — patrz PURPOSES.
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

// Brak środków na koncie dostawcy. Anthropic zwraca na to 400, czyli dokładnie
// ten sam kod co „nie ma takiego modelu" — rozróżnia je tylko treść komunikatu.
// Rozróżnienie jest istotne: 'invalid' oznacza konfigurację jako zepsutą i odcina
// tenantowi wszystkie funkcje AI do ręcznej interwencji. Po doładowaniu konta klucz
// działa sam, więc oznaczanie go jako złego zostawiłoby AI martwe bez powodu.
const LOW_BALANCE = /credit balance is too low|insufficient[\s_]*(credit|balance|funds|quota)|billing[\s_]*(hard[\s_]*limit|not[\s_]*active)|exceeded your current quota/i;

function classify(err, provider) {
  const status = err.response?.status ?? null;
  const detail =
    err.response?.data?.error?.message ||
    err.response?.data?.error?.type ||
    err.response?.data?.message ||
    err.message;
  // 401/403 to zły lub cofnięty klucz; 404/400 przy poprawnym kluczu to prawie
  // zawsze nieistniejący model — w obu przypadkach ponowienie nic nie da.
  // Wyjątek: brak środków, który mija po doładowaniu, więc jest 'error'.
  const isLowBalance = LOW_BALANCE.test(String(detail || ''));
  const kind = !isLowBalance && [400, 401, 403, 404].includes(status) ? 'invalid' : 'error';
  const error = new AiProviderError(detail || `Błąd dostawcy ${provider}`, { kind, status, provider });
  error.isLowBalance = isLowBalance;
  return error;
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

// ── Adapter: Anthropic + serwerowe web_search ───────────────────────────────
// Model szuka w sieci SAM, w trakcie odpowiedzi, i po każdym wyszukaniu wraca ze
// `stop_reason: 'pause_turn'` — trzeba oddać mu jego własną wypowiedź i pozwolić
// dokończyć. Bez tej pętli dostajemy ucięty tekst z połowy researchu.
//
// UWAGA, to naprawia istniejącą usterkę: competitorDiscoveryService pętlił po
// `stop_reason === 'tool_use'`, które przy narzędziu SERWEROWYM nigdy nie
// przychodzi (serwer wykonuje wyszukiwanie u siebie i zwraca 'pause_turn').
// Pętla kończyła więc pracę po pierwszej turze. seoFactsService miał to od
// początku poprawnie i ten adapter idzie za jego wzorcem.
const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
const MAX_SEARCH_TURNS = 4;

async function callAnthropicWebSearch({
  apiKey, baseUrl, model, system, user, maxTokens, maxUses, timeoutMs, provider,
}) {
  const url = `${(baseUrl || PROVIDERS.anthropic.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
  const tools = [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: maxUses }];
  const messages = [{ role: 'user', content: user }];
  const usage = { prompt_tokens: 0, completion_tokens: 0, raw: null };
  let finalText = '';
  let actualModel = model;

  for (let turn = 0; turn <= MAX_SEARCH_TURNS; turn++) {
    let data;
    try {
      ({ data } = await axios.post(
        url,
        {
          model,
          max_tokens: maxTokens,
          tools,
          ...(system ? { system } : {}),
          messages,
        },
        { headers, timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS },
      ));
    } catch (err) {
      throw classify(err, provider);
    }

    usage.prompt_tokens += data?.usage?.input_tokens || 0;
    usage.completion_tokens += data?.usage?.output_tokens || 0;
    usage.raw = data?.usage ?? usage.raw;
    actualModel = data?.model || actualModel;

    if (data?.stop_reason === 'pause_turn' && turn < MAX_SEARCH_TURNS) {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    finalText = (data?.content || [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n');
    break;
  }

  return { content: finalText, model: actualModel, usage };
}

// ── Adaptery: wymuszony JSON wg schematu ────────────────────────────────────
// Część funkcji nie chce „tekstu" — chce obiektu o konkretnym kształcie (artykuł
// SEO z sekcjami, odpowiedź asystenta formularza). Dostawca wymusza to po swojej
// stronie, więc model nie może odpowiedzieć prozą ani urwać JSON-a w połowie.
//
// Wspólnym kontraktem jest zwykły JSON Schema. Schematy w kodzie są pisane w Zod
// (seoContentService) — `zodOutputFormat(S).schema` daje z nich dokładnie taki
// obiekt, więc jedna definicja wystarcza obu dostawcom.
//
// POTRAFIĄ TO TYLKO ANTHROPIC I OPENAI. Gemini ma własny `responseSchema`
// (podzbiór OpenAPI, nie przyjmuje m.in. additionalProperties), a DeepSeek
// wyłącznie tryb „jakikolwiek JSON" bez schematu. Dopisanie ich wymagałoby
// tłumaczenia schematu i testu na realnym kluczu — do zrobienia osobno, nie na
// ślepo. Dziś tenant na Gemini/DeepSeeku ma te funkcje niedostępne, jawnie.

function parseStructured(text, provider) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) {
    throw new AiProviderError('Model nie zwrócił obiektu JSON.', { kind: 'error', provider });
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new AiProviderError(`Nie udało się odczytać JSON-a od modelu: ${err.message}`, {
      kind: 'error', provider,
    });
  }
}

async function callAnthropicStructured({
  apiKey, baseUrl, model, system, user, messages, jsonSchema, maxTokens, temperature, provider,
}) {
  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
      {
        model,
        max_tokens: maxTokens,
        temperature,
        output_config: { format: { type: 'json_schema', schema: jsonSchema } },
        ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
        messages: messages ?? [{ role: 'user', content: user }],
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
      parsed: parseStructured(text, provider),
      content: text,
      model: data?.model || model,
      usage: normalizeUsage(data?.usage, data?.usage?.input_tokens, data?.usage?.output_tokens),
    };
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw classify(err, provider);
  }
}

async function callOpenAiStructured({
  apiKey, baseUrl, model, system, user, messages, jsonSchema, schemaName, maxTokens, temperature, provider,
}) {
  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        model,
        max_tokens: maxTokens,
        temperature,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName || 'result', strict: true, schema: jsonSchema },
        },
        messages: [
          { role: 'system', content: system },
          ...(messages ?? [{ role: 'user', content: user }]),
        ],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    const text = data?.choices?.[0]?.message?.content || '';
    return {
      parsed: parseStructured(text, provider),
      content: text,
      model: data?.model || model,
      usage: normalizeUsage(data?.usage, data?.usage?.prompt_tokens, data?.usage?.completion_tokens),
    };
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw classify(err, provider);
  }
}

// ── Lista modeli dostępnych na koncie ───────────────────────────────────────
// Każdy z czterech dostawców ma endpoint z katalogiem modeli, więc admin nie musi
// przepisywać nazwy z dokumentacji ani zgadywać, co jest jeszcze dostępne. Zwraca
// posortowane { id, label }; kształt odpowiedzi różni się u każdego.
//
// PO CO: nazwy modeli to przypięte wersje — `claude-opus-4-8` nigdy nie zmieni się
// sam w nowszy. Wpisywane z palca zamrażają się na lata (dokładnie to stało się
// tutaj: SEO stało na opus-4-8, a konkurencja na sonnet-4-6, choć nowsze były
// jednocześnie lepsze i tańsze). Lista z konta pokazuje, co realnie jest.

async function listAnthropicModels({ apiKey, baseUrl, provider }) {
  const { data } = await axios.get(`${baseUrl.replace(/\/+$/, '')}/v1/models?limit=100`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    timeout: 20_000,
  }).catch(err => { throw classify(err, provider); });
  return (data?.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
}

async function listOpenAiCompatibleModels({ apiKey, baseUrl, provider }) {
  const { data } = await axios.get(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 20_000,
  }).catch(err => { throw classify(err, provider); });
  return (data?.data || []).map(m => ({ id: m.id, label: m.id }));
}

async function listGeminiModels({ apiKey, baseUrl, provider }) {
  const { data } = await axios.get(`${baseUrl.replace(/\/+$/, '')}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
    timeout: 20_000,
  }).catch(err => { throw classify(err, provider); });
  // Gemini zwraca "models/gemini-2.5-flash" i listuje też modele, które nie
  // potrafią generować treści (np. embeddingi) — jedne i drugie trzeba odfiltrować,
  // bo wybranie ich dałoby błąd dopiero przy realnym użyciu.
  return (data?.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: String(m.name || '').replace(/^models\//, ''),
      label: m.displayName || String(m.name || '').replace(/^models\//, ''),
    }))
    .filter(m => m.id);
}

// ── Funkcje AI (klucze w tenant_ai_config.models) ───────────────────────────
// Kolejność tej listy jest kolejnością pól w panelu. Etykiety są we frontendzie
// (i18n ×10), tutaj tylko to, co musi wiedzieć backend.
//
// `needs` to ZDOLNOŚĆ, której funkcja wymaga od dostawcy — nie każda funkcja AI
// to „prompt → tekst", a te różnice nie znikają po wymianie klucza:
//
//   null                — zwykły tekst, działa u każdego dostawcy
//   'webSearch'         — model sam szuka w internecie w trakcie odpowiedzi
//                         (serwerowe narzędzie Anthropica; OpenAI i Gemini mają
//                         własne, niekompatybilne, DeepSeek nie ma żadnego)
//   'structuredOutput'  — dostawca wymusza JSON wg schematu (Anthropic, OpenAI)
//
// Tenant, którego dostawca danej zdolności nie ma, widzi tę funkcję jako
// niedostępną — jawnie, w panelu i w komunikacie błędu, nigdy cicho.
// SEO ma DWA pola, nie jedno, bo jego przebieg ma dwa różne etapy: tani research
// i konspekt (krótkie wejście, krótkie wyjście) oraz drogie pisanie i redakcja
// (długi artykuł, model najwyższej klasy). Jedno pole wymuszałoby albo research
// po cenie modelu do treści, albo pisanie na modelu do zadań masowych. Ukrycie
// researchu przed adminem odrzucone świadomie — ma być ustawialne wszystko.
const PURPOSES = Object.freeze([
  { key: 'enrichment',           needs: null },
  { key: 'call_analysis',        needs: null },
  { key: 'competitor_discovery', needs: 'webSearch' },
  { key: 'seo_facts',            needs: 'webSearch' },
  { key: 'seo_research',         needs: 'structuredOutput' },
  { key: 'seo_content',          needs: 'structuredOutput' },
  { key: 'assistant',            needs: 'structuredOutput' },
]);

const PURPOSE_KEYS = Object.freeze(PURPOSES.map(p => p.key));
const PURPOSE_NEEDS = Object.freeze(
  Object.fromEntries(PURPOSES.map(p => [p.key, p.needs])),
);

// ── Rejestr ─────────────────────────────────────────────────────────────────
// `models` to modele DOMYŚLNE per funkcja — podpowiedź w panelu i wartość
// użyta, gdy admin nic nie wpisał. Nic ich nie waliduje poza realnym wywołaniem
// u dostawcy; admin może nadpisać każdą pozycję dowolnym modelem ze swojego
// konta.
//
// Dla Anthropica domyślne to rodzina 5.5 (sprawdzone 2026-10-08 w GET /v1/models
// i w cenniku, nie z pamięci). Zastępują modele, które stały zahardkodowane w
// serwisach — każda podmiana jest jednocześnie NOWSZA i TAŃSZA, więc nie ma tu
// kompromisu „lepiej za drożej":
//   haiku-4-5  → haiku-5-5   $1/$5     → $0.10/$0.50 do 100k tokenów (10× taniej)
//   sonnet-4-6 → sonnet-5-5  $3/$15    → $2/$10
//   sonnet-5   → sonnet-5-5  ta sama cena, tańszy odczyt cache ($0.10 vs $0.20)
//   opus-4-8   → opus-5-5    $5/$25    → $4/$20
//
// UWAGA o Haiku 5.5: jedyny model rozliczany wg DŁUGOŚCI promptu — powyżej 100k
// tokenów wejścia cena rośnie do $0.50/$2.50 (nadal o połowę taniej niż
// haiku-4-5). Dotyczy to enrichmentu przy bardzo dużych stronach. Haiku 5.5 jest
// też wyjęty z reguły „1M kontekstu w standardowej cenie", więc przy naprawdę
// długich wejściach warto sprawdzić limit kontekstu.
//
// Dla pozostałych dostawców to rozsądny punkt startowy: tani model do zadań
// masowych, mocniejszy do treści. Funkcje wymagające zdolności, której dostawca
// nie ma, nie mają u niego wpisu — bo są niedostępne.
const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    call: callAnthropic,
    webSearch: callAnthropicWebSearch,
    structuredOutput: callAnthropicStructured,
    listModels: listAnthropicModels,
    models: {
      enrichment: 'claude-haiku-5-5',
      call_analysis: 'claude-haiku-5-5',
      competitor_discovery: 'claude-sonnet-5-5',
      seo_facts: 'claude-sonnet-5-5',
      seo_research: 'claude-sonnet-5-5',
      seo_content: 'claude-opus-5-5',
      assistant: 'claude-haiku-5-5',
    },
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    call: callOpenAiCompatible,
    webSearch: null,
    structuredOutput: callOpenAiStructured,
    listModels: listOpenAiCompatibleModels,
    models: {
      enrichment: 'gpt-4.1-mini',
      call_analysis: 'gpt-4.1-mini',
      seo_research: 'gpt-4.1-mini',
      seo_content: 'gpt-4.1',
      assistant: 'gpt-4.1-mini',
    },
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keysUrl: 'https://aistudio.google.com/apikey',
    call: callGemini,
    webSearch: null,
    structuredOutput: null,
    listModels: listGeminiModels,
    models: {
      enrichment: 'gemini-2.5-flash',
      call_analysis: 'gemini-2.5-flash',
    },
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    call: callOpenAiCompatible,
    webSearch: null,
    structuredOutput: null,
    listModels: listOpenAiCompatibleModels,
    models: {
      enrichment: 'deepseek-chat',
      call_analysis: 'deepseek-chat',
    },
  },
});

const PROVIDER_KEYS = Object.freeze(Object.keys(PROVIDERS));

/** Czy dostawca ma zdolność, której wymaga ta funkcja. */
function supportsPurpose(provider, purpose) {
  const entry = PROVIDERS[provider];
  if (!entry) return false;
  const needs = PURPOSE_NEEDS[purpose];
  if (needs === undefined) return false; // nieznana funkcja
  return needs === null ? true : Boolean(entry[needs]);
}

/**
 * Model dla funkcji: wpis admina, a gdy go nie ma — domyślny dla dostawcy.
 * `null` oznacza, że ten dostawca tej funkcji nie obsługuje.
 */
function resolveModel(provider, purpose, models = {}) {
  if (!supportsPurpose(provider, purpose)) return null;
  const chosen = typeof models?.[purpose] === 'string' ? models[purpose].trim() : '';
  return chosen || PROVIDERS[provider]?.models?.[purpose] || null;
}

/**
 * Dostawcy do wyboru w panelu — bez adapterów, same dane dla UI. Frontend dostaje
 * też listę funkcji, których dany dostawca NIE obsługuje, żeby wyszarzyć je od
 * razu po zmianie dostawcy, bez pytania backendu.
 */
function listProviders() {
  return PROVIDER_KEYS.map(key => ({
    key,
    label: PROVIDERS[key].label,
    keys_url: PROVIDERS[key].keysUrl,
    default_models: { ...PROVIDERS[key].models },
    unsupported_purposes: PURPOSE_KEYS.filter(purpose => !supportsPurpose(key, purpose)),
  }));
}

/**
 * Funkcje AI do wypisania w panelu, w kolejności wyświetlania. `requires` mówi
 * frontendowi, CZEGO brakuje u dostawcy, który funkcji nie obsługuje — żeby
 * komunikat mógł nazwać powód, a nie tylko „niedostępne".
 */
function listPurposes() {
  return PURPOSES.map(p => ({
    key: p.key,
    requires: p.needs,
    supported_by: PROVIDER_KEYS.filter(provider => supportsPurpose(provider, p.key)),
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

/**
 * Wywołanie, w którym model sam szuka w sieci. Dostępne tylko u dostawcy z
 * serwerowym web_search — u pozostałych rzuca 'invalid', bo zmiana klucza tego
 * nie naprawi i ponowienie nic nie da.
 */
async function callProviderWithWebSearch(
  provider,
  { apiKey, baseUrl, model, system, user, maxTokens = 3000, maxUses = 4, timeoutMs },
) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new AiProviderError(`Nieznany dostawca AI: ${provider}`, { kind: 'invalid', provider });
  // Zwykłe Error, nie AiProviderError — patrz komentarz w callProviderStructured.
  if (!entry.webSearch) {
    throw new Error(
      `Dostawca ${entry.label} nie obsługuje wyszukiwania w internecie — ta funkcja wymaga Anthropic (Claude).`,
    );
  }
  return entry.webSearch({
    apiKey,
    baseUrl: baseUrl || entry.baseUrl,
    model,
    system,
    user,
    maxTokens,
    maxUses,
    timeoutMs,
    provider,
  });
}

/**
 * Wywołanie z wymuszonym JSON-em wg schematu. `jsonSchema` to zwykły JSON Schema
 * (z Zod: `zodOutputFormat(S).schema`). Zwraca dodatkowo `parsed` — gotowy obiekt.
 *
 * Zamiast `user` można podać `messages` — całą rozmowę (asystent formularzy jest
 * wielorundowy, jedno pole tekstowe by mu nie wystarczyło).
 */
async function callProviderStructured(
  provider,
  { apiKey, baseUrl, model, system, user, messages, jsonSchema, schemaName, maxTokens = 3000, temperature = 0 },
) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new AiProviderError(`Nieznany dostawca AI: ${provider}`, { kind: 'invalid', provider });
  // Zwykłe Error, NIE AiProviderError: to brak zdolności dostawcy albo błąd
  // wywołującego, nie odrzucenie klucza. AiProviderError{kind:'invalid'}
  // oznaczyłoby konfigurację tenanta jako zepsutą i odciął mu pozostałe funkcje AI.
  if (!entry.structuredOutput) {
    throw new Error(
      `Dostawca ${entry.label} nie potrafi wymusić odpowiedzi w zadanym formacie — ta funkcja wymaga Anthropic (Claude) albo OpenAI.`,
    );
  }
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    throw new Error('Brak schematu odpowiedzi (jsonSchema).');
  }
  return entry.structuredOutput({
    apiKey,
    baseUrl: baseUrl || entry.baseUrl,
    model,
    system,
    user,
    messages,
    jsonSchema,
    schemaName,
    maxTokens,
    temperature,
    provider,
  });
}

/**
 * Dostawcy, u których ten klucz MOŻE być ważny, w kolejności od
 * najpewniejszego. Rozpoznanie po prefiksie tylko ZAWĘŻA listę — nie
 * rozstrzyga, bo OpenAI i DeepSeek wydają klucze zaczynające się tak samo od
 * „sk-". Ostateczną odpowiedź daje odpytanie dostawcy (patrz
 * aiConfigService.resolveProviderForKey), nie ten regex.
 *
 *   sk-ant-…   Anthropic   — jednoznaczne
 *   AIza…      Gemini      — jednoznaczne (format klucza Google)
 *   sk-proj-…  OpenAI      — klucze projektowe i serwisowe
 *   sk-…       OpenAI ALBO DeepSeek — rozstrzygane wywołaniem
 */
function detectProviderCandidates(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return [];
  if (key.startsWith('sk-ant-')) return ['anthropic'];
  if (key.startsWith('AIza')) return ['gemini'];
  if (/^sk-(proj|svcacct)-/.test(key)) return ['openai'];
  if (key.startsWith('sk-')) {
    // Klucz DeepSeeka to „sk-" + 32 znaki heksadecymalne; klucze OpenAI są
    // dłuższe. Kolejność to tylko podpowiedź, co sprawdzić najpierw.
    return /^sk-[0-9a-f]{32}$/i.test(key) ? ['deepseek', 'openai'] : ['openai', 'deepseek'];
  }
  // Nieznany format — sprawdzamy wszystkich, bo dostawca mógł zmienić format
  // kluczy, a my nie chcemy odrzucać poprawnego klucza na podstawie regexa.
  return [...PROVIDER_KEYS];
}

/** Modele dostępne na koncie dostawcy dla tego klucza. */
async function listProviderModels(provider, { apiKey, baseUrl }) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new AiProviderError(`Nieznany dostawca AI: ${provider}`, { kind: 'invalid', provider });
  if (!entry.listModels) throw new Error(`Dostawca ${entry.label} nie udostępnia listy modeli.`);
  const models = await entry.listModels({ apiKey, baseUrl: baseUrl || entry.baseUrl, provider });
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  PROVIDER_KEYS,
  PURPOSE_KEYS,
  PURPOSE_NEEDS,
  AiProviderError,
  listProviders,
  listProviderModels,
  detectProviderCandidates,
  listPurposes,
  supportsPurpose,
  resolveModel,
  callProvider,
  callProviderWithWebSearch,
  callProviderStructured,
  defaultBaseUrl: provider => PROVIDERS[provider]?.baseUrl ?? null,
};
