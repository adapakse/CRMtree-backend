'use strict';

// Dostawca AI, klucz i model OSOBNO DLA KAŻDEJ FUNKCJI, per tenant (0327).
//
// Testuje to, co w tym mechanizmie najdrożej byłoby zepsuć:
//   - cztery adaptery dostawców mówią różnymi kontraktami, a zwracają jeden
//     wspólny kształt { content, model, usage },
//   - funkcje są od siebie NIEZALEŻNE: inny dostawca, inny klucz, inny status;
//     zepsuta jedna nie wyłącza pozostałych,
//   - klucz wkleja się RAZ NA DOSTAWCĘ — kolejna funkcja tego samego dostawcy
//     dziedziczy go, ale jako własną kopię (usunięcie jednej nie rozbraja reszty),
//   - dostawca bez zdolności wymaganej przez funkcję (web_search, wymuszony JSON)
//     jest odrzucany PRZED dotknięciem sieci,
//   - klucz NIGDY nie wychodzi z API ani z logów — tylko hint,
//   - klucz i model są weryfikowane realnym wywołaniem PRZED zapisem,
//   - brak wiersza = funkcja wyłączona (AiNotConfiguredError), NIE ciche zero —
//     ciche zero zapisałoby enrichment jako ukończony z wynikiem 0, dokładnie
//     jak w regresji naprawionej 23.09,
//   - pętla web_search kończy się dopiero po `pause_turn` (dawny kod przerywał po
//     pierwszej turze, bo czekał na `tool_use`, które przy narzędziu serwerowym
//     nigdy nie przychodzi).
//
// Integracyjny na realnej lokalnej bazie; mockowana jest tylko granica
// zewnętrzna (axios). Zero realnych wywołań do dostawców AI.

jest.mock('axios');

const axios = require('axios');
const db = require('../config/database');
const providers = require('../services/ai/aiProviders');
const aiClient = require('../services/ai/aiClient');
const aiConfig = require('../services/ai/aiConfigService');

const SLUG = 'zz-ai-config-test';
const API_KEY = 'sk-test-abcdefghijkl9876';

let tenantId;

const okOpenAi = {
  data: { model: 'gpt-4.1-mini', choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 11, completion_tokens: 2 } },
};
const okAnthropic = {
  data: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'pong' }],
          usage: { input_tokens: 11, output_tokens: 2 } },
};
const okGemini = {
  data: { modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { parts: [{ text: 'pong' }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2 } },
};
const jsonAnthropic = (obj) => ({
  data: { model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(obj) }],
          usage: { input_tokens: 5, output_tokens: 5 } },
});
const reject = (status, message) => {
  const err = new Error(message);
  err.response = { status, data: { error: { message } } };
  return err;
};

/** Zapis JEDNEJ funkcji: weryfikacja robi jedno wywołanie u dostawcy. */
async function saveOk(purpose, payload, response = okOpenAi) {
  axios.post.mockResolvedValue(response);
  const saved = await aiConfig.saveConfig(tenantId, purpose, payload);
  axios.post.mockReset();
  return saved;
}

async function cleanUp() {
  await db.query('DELETE FROM tenant_ai_config WHERE tenant_id = $1', [tenantId]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('AI Config Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await cleanUp();
});

beforeEach(() => { axios.post.mockReset(); axios.get.mockReset(); });
afterEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

describe('adaptery dostawców — różne kontrakty, jeden kształt wyniku', () => {
  test('OpenAI i DeepSeek dzielą ścieżkę /chat/completions', async () => {
    for (const provider of ['openai', 'deepseek']) {
      axios.post.mockResolvedValueOnce(okOpenAi);
      const res = await providers.callProvider(provider, {
        apiKey: API_KEY, model: 'm', system: 's', user: 'u',
      });
      expect(res.content).toBe('pong');
      expect(res.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 2 });
      const [url, body, opts] = axios.post.mock.calls.at(-1);
      expect(url).toMatch(/\/chat\/completions$/);
      expect(body.messages).toEqual([
        { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      ]);
      expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    }
  });

  test('Anthropic: prompt systemowy osobnym polem, treść z content[].text', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic);
    const res = await providers.callProvider('anthropic', {
      apiKey: API_KEY, model: 'claude-haiku-5-5', system: 's', user: 'u',
    });
    expect(res.content).toBe('pong');
    expect(res.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 2 });
    const [url, body, opts] = axios.post.mock.calls.at(-1);
    expect(url).toMatch(/\/v1\/messages$/);
    expect(body.system[0].text).toBe('s');
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
    expect(opts.headers['x-api-key']).toBe(API_KEY);
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('Gemini: model w ścieżce URL, systemInstruction, maxOutputTokens', async () => {
    axios.post.mockResolvedValueOnce(okGemini);
    const res = await providers.callProvider('gemini', {
      apiKey: API_KEY, model: 'gemini-2.5-flash', system: 's', user: 'u', maxTokens: 123,
    });
    expect(res.content).toBe('pong');
    expect(res.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 2 });
    const [url, body, opts] = axios.post.mock.calls.at(-1);
    expect(url).toMatch(/\/models\/gemini-2\.5-flash:generateContent$/);
    expect(body.systemInstruction.parts[0].text).toBe('s');
    expect(body.generationConfig.maxOutputTokens).toBe(123);
    expect(opts.headers['x-goog-api-key']).toBe(API_KEY);
  });

  test('brak środków NIE jest złym kluczem — mija po doładowaniu, więc "error"', async () => {
    // Anthropic zwraca na to 400, czyli ten sam kod co „nie ma takiego modelu".
    // Potraktowanie tego jako 'invalid' odcięłoby tenantowi wszystkie funkcje AI
    // na stałe: po doładowaniu konta klucz działa, ale status został zepsuty.
    axios.post.mockRejectedValueOnce(reject(400,
      'Your credit balance is too low to access the Anthropic API.'));
    await expect(providers.callProvider('anthropic', { apiKey: API_KEY, model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'error', isLowBalance: true });

    // Dla porównania: nieistniejący model przy tym samym kodzie HTTP to 'invalid'.
    axios.post.mockRejectedValueOnce(reject(400, 'model: nie-ma-takiego not found'));
    await expect(providers.callProvider('anthropic', { apiKey: API_KEY, model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'invalid' });
  });

  test('401 to "invalid" (nie ponawiać), 500 to "error" (warte ponowienia)', async () => {
    axios.post.mockRejectedValueOnce(reject(401, 'bad key'));
    await expect(providers.callProvider('openai', { apiKey: 'x', model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'invalid', status: 401 });

    axios.post.mockRejectedValueOnce(reject(500, 'boom'));
    await expect(providers.callProvider('openai', { apiKey: 'x', model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'error', status: 500 });
  });
});

describe('web_search — pętla po turach', () => {
  const pause = {
    data: { model: 'claude-sonnet-5-5', stop_reason: 'pause_turn',
            content: [{ type: 'text', text: 'szukam…' }],
            usage: { input_tokens: 10, output_tokens: 3 } },
  };
  const done = {
    data: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'wynik' }],
            usage: { input_tokens: 20, output_tokens: 7 } },
  };

  test('„pause_turn" jest wznawiane, a nie traktowane jak koniec odpowiedzi', async () => {
    axios.post.mockResolvedValueOnce(pause).mockResolvedValueOnce(done);
    const res = await providers.callProviderWithWebSearch('anthropic', {
      apiKey: API_KEY, model: 'claude-sonnet-5-5', user: 'u', maxTokens: 100, maxUses: 3,
    });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(res.content).toBe('wynik');
    // Zużycie sumuje się po wszystkich turach, inaczej koszt byłby zaniżony.
    expect(res.usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 10 });
    // Druga tura dostaje wypowiedź modelu z pierwszej.
    const [, body] = axios.post.mock.calls.at(-1);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].role).toBe('assistant');
  });

  test('dostawca bez web_search odmawia bez dotykania sieci', async () => {
    await expect(providers.callProviderWithWebSearch('openai', {
      apiKey: API_KEY, model: 'm', user: 'u',
    })).rejects.toThrow(/nie obsługuje wyszukiwania/i);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('wymuszony JSON wg schematu', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };

  test('Anthropic dostaje output_config, a my gotowy obiekt', async () => {
    axios.post.mockResolvedValueOnce(jsonAnthropic({ a: 'x' }));
    const res = await providers.callProviderStructured('anthropic', {
      apiKey: API_KEY, model: 'claude-opus-5-5', system: 's', user: 'u', jsonSchema: schema,
    });
    expect(res.parsed).toEqual({ a: 'x' });
    const [, body] = axios.post.mock.calls.at(-1);
    expect(body.output_config.format).toMatchObject({ type: 'json_schema', schema });
  });

  test('OpenAI dostaje response_format w trybie strict', async () => {
    axios.post.mockResolvedValueOnce({
      data: { model: 'gpt-4.1', choices: [{ message: { content: '{"a":"x"}' } }],
              usage: { prompt_tokens: 3, completion_tokens: 3 } },
    });
    const res = await providers.callProviderStructured('openai', {
      apiKey: API_KEY, model: 'gpt-4.1', system: 's', user: 'u',
      jsonSchema: schema, schemaName: 'wynik',
    });
    expect(res.parsed).toEqual({ a: 'x' });
    const [, body] = axios.post.mock.calls.at(-1);
    expect(body.response_format.json_schema).toMatchObject({ name: 'wynik', strict: true, schema });
  });

  test('Gemini i DeepSeek odmawiają — nie potrafią wymusić schematu', async () => {
    for (const provider of ['gemini', 'deepseek']) {
      await expect(providers.callProviderStructured(provider, {
        apiKey: API_KEY, model: 'm', user: 'u', jsonSchema: schema,
      })).rejects.toThrow(/nie potrafi wymusić/i);
    }
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('model i dostawca wybierane per funkcja', () => {
  test('puste pole = model domyślny dostawcy, wpisane = nadpisanie', () => {
    expect(providers.resolveModel('anthropic', 'enrichment', {})).toBe('claude-haiku-5-5');
    expect(providers.resolveModel('anthropic', 'seo_content', {})).toBe('claude-opus-5-5');
    expect(providers.resolveModel('anthropic', 'seo_content', { seo_content: '  claude-opus-5 ' }))
      .toBe('claude-opus-5');
  });

  test('funkcja niedostępna u dostawcy nie ma modelu', () => {
    expect(providers.resolveModel('openai', 'competitor_discovery', {})).toBeNull();
    expect(providers.resolveModel('deepseek', 'seo_content', { seo_content: 'cokolwiek' })).toBeNull();
    expect(providers.supportsPurpose('anthropic', 'seo_facts')).toBe(true);
    expect(providers.supportsPurpose('gemini', 'enrichment')).toBe(true);
  });

  test('dwie funkcje mogą mieć RÓŻNYCH dostawców naraz', async () => {
    await saveOk('enrichment', { provider: 'deepseek', apiKey: 'sk-deep-0001' });
    await saveOk('seo_content', { provider: 'anthropic', apiKey: 'sk-anth-0002' }, okAnthropic);

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment.provider).toBe('deepseek');
    expect(config.seo_content.provider).toBe('anthropic');
    // Każda funkcja trzyma SWÓJ klucz — poznajemy po hincie.
    expect(config.enrichment.api_key_hint).toBe('0001');
    expect(config.seo_content.api_key_hint).toBe('0002');
  });

  test('callAi używa dostawcy i modelu przypisanych do tej funkcji', async () => {
    await saveOk('enrichment', { provider: 'deepseek', apiKey: API_KEY });
    await saveOk('seo_content', { provider: 'anthropic', apiKey: API_KEY, model: 'claude-opus-5' }, okAnthropic);

    axios.post.mockResolvedValueOnce(okAnthropic);
    const res = await aiClient.callAi({ tenantId, purpose: 'seo_content', system: 's', user: 'u' });
    expect(res.provider).toBe('anthropic');
    expect(axios.post.mock.calls.at(-1)[1].model).toBe('claude-opus-5');
  });

  test('dostawca bez wymaganej zdolności jest odrzucany PRZED dotknięciem sieci', async () => {
    await expect(aiConfig.saveConfig(tenantId, 'competitor_discovery', {
      provider: 'deepseek', apiKey: API_KEY,
    })).rejects.toMatchObject({ status: 400 });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('funkcje są od siebie niezależne', () => {
  test('odrzucony klucz psuje TYLKO swoją funkcję', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await saveOk('call_analysis', { provider: 'openai', apiKey: API_KEY });

    axios.post.mockRejectedValueOnce(reject(401, 'key revoked'));
    await expect(aiClient.callAi({ tenantId, purpose: 'enrichment', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'invalid' });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment.status).toBe('invalid');
    expect(config.call_analysis.status).toBe('active');

    // Zepsuta funkcja nie dobija już dostawcy, sprawna działa dalej.
    const before = axios.post.mock.calls.length;
    await expect(aiClient.callAi({ tenantId, purpose: 'enrichment', system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(aiClient.AiNotConfiguredError);
    expect(axios.post.mock.calls.length).toBe(before);

    axios.post.mockResolvedValueOnce(okOpenAi);
    await expect(aiClient.callAi({ tenantId, purpose: 'call_analysis', system: 's', user: 'u' }))
      .resolves.toMatchObject({ content: 'pong' });
  });

  test('brak środków NIE psuje konfiguracji — mija po doładowaniu', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    axios.post.mockRejectedValueOnce(reject(429, 'You exceeded your current quota'));
    await expect(aiClient.callAi({ tenantId, purpose: 'enrichment', system: 's', user: 'u' }))
      .rejects.toMatchObject({ isLowBalance: true });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment.status).toBe('active');
  });

  test('usunięcie jednej funkcji zostawia pozostałe nietknięte', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await saveOk('call_analysis', { provider: 'openai', apiKey: API_KEY });

    await aiConfig.deleteConfig(tenantId, 'enrichment');
    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment).toBeUndefined();
    expect(config.call_analysis.status).toBe('active');
    expect(await aiClient.isPurposeAvailable(tenantId, 'call_analysis')).toBe(true);
    expect(await aiClient.isPurposeAvailable(tenantId, 'enrichment')).toBe(false);
  });
});

describe('klucz wkleja się raz na dostawcę', () => {
  test('druga funkcja tego samego dostawcy dziedziczy klucz', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    const saved = await saveOk('call_analysis', { provider: 'openai' });
    expect(saved.api_key_hint).toBe(API_KEY.slice(-4));
  });

  test('klucz jest KOPIOWANY — usunięcie źródła nie rozbraja pozostałych', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await saveOk('call_analysis', { provider: 'openai' });

    await aiConfig.deleteConfig(tenantId, 'enrichment');

    axios.post.mockResolvedValueOnce(okOpenAi);
    await expect(aiClient.callAi({ tenantId, purpose: 'call_analysis', system: 's', user: 'u' }))
      .resolves.toMatchObject({ content: 'pong' });
  });

  test('klucz INNEGO dostawcy się nie dziedziczy', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await expect(aiConfig.saveConfig(tenantId, 'call_analysis', { provider: 'deepseek' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('zmiana samego modelu nie wymaga ponownego wklejania klucza', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    const updated = await saveOk('enrichment', { provider: 'openai', model: 'gpt-4.1' });
    expect(updated.model).toBe('gpt-4.1');
    expect(updated.api_key_hint).toBe(API_KEY.slice(-4));
  });
});

describe('zapis konfiguracji', () => {
  test('weryfikuje klucz i model realnym wywołaniem PRZED zapisem', async () => {
    axios.post.mockResolvedValue(okAnthropic);
    const saved = await aiConfig.saveConfig(tenantId, 'seo_content', {
      provider: 'anthropic', apiKey: API_KEY,
    });
    expect(saved).toMatchObject({ purpose: 'seo_content', provider: 'anthropic', status: 'active' });
    // Model domyślny dla TEJ funkcji, nie dla jakiejkolwiek innej.
    expect(axios.post.mock.calls.at(-1)[1].model).toBe('claude-opus-5-5');
  });

  test('odrzucony klucz NIE zostaje zapisany', async () => {
    axios.post.mockRejectedValue(reject(401, 'invalid api key'));
    await expect(aiConfig.saveConfig(tenantId, 'enrichment', {
      provider: 'openai', apiKey: 'zly',
    })).rejects.toMatchObject({ status: 422 });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment).toBeUndefined();
  });

  test('brak środków daje 402, nie "zła konfiguracja"', async () => {
    axios.post.mockRejectedValue(reject(400, 'Your credit balance is too low'));
    await expect(aiConfig.saveConfig(tenantId, 'enrichment', {
      provider: 'anthropic', apiKey: API_KEY,
    })).rejects.toMatchObject({ status: 402 });
  });

  test('błąd wskazuje model, który nie przeszedł', async () => {
    axios.post.mockRejectedValue(reject(404, 'model not found'));
    await expect(aiConfig.saveConfig(tenantId, 'enrichment', {
      provider: 'openai', apiKey: API_KEY, model: 'nie-ma-takiego',
    })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('nie-ma-takiego') });
  });

  test('pierwszy zapis bez klucza jest odrzucany', async () => {
    await expect(aiConfig.saveConfig(tenantId, 'enrichment', { provider: 'openai' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('nieznany dostawca i nieznana funkcja odrzucone bez dotykania sieci', async () => {
    await expect(aiConfig.saveConfig(tenantId, 'enrichment', { provider: 'skynet', apiKey: API_KEY }))
      .rejects.toMatchObject({ status: 400 });
    await expect(aiConfig.saveConfig(tenantId, 'wrozenie_z_fusow', { provider: 'openai', apiKey: API_KEY }))
      .rejects.toMatchObject({ status: 400 });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('lista modeli z konta dostawcy', () => {
  test('Anthropic: id + nazwa czytelna dla człowieka', async () => {
    axios.get.mockResolvedValueOnce({
      data: { data: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
        { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
      ] },
    });
    const models = await providers.listProviderModels('anthropic', { apiKey: API_KEY });
    expect(models).toEqual([
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ]);
  });

  test('Gemini: obcięty prefiks "models/" i bez modeli, które nie generują treści', async () => {
    axios.get.mockResolvedValueOnce({
      data: { models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', displayName: 'Embedding',
          supportedGenerationMethods: ['embedContent'] },
      ] },
    });
    const models = await providers.listProviderModels('gemini', { apiKey: API_KEY });
    expect(models).toEqual([{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]);
  });

  test('lista bierze klucz zapisany przy dowolnej funkcji tego dostawcy', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4.1' }] } });

    const res = await aiConfig.listModels(tenantId, { provider: 'openai' });
    expect(res.models).toEqual([{ id: 'gpt-4.1', label: 'gpt-4.1' }]);
  });

  test('bez klucza w ogóle nie pytamy dostawcy', async () => {
    await expect(aiConfig.listModels(tenantId, { provider: 'openai' }))
      .rejects.toMatchObject({ status: 400 });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('klucz API nie wycieka', () => {
  test('getConfig zwraca hint, nigdy klucza', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.enrichment.api_key_hint).toBe('9876');
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(Object.keys(config.enrichment)).not.toContain('api_key');
  });

  test('w bazie klucz jest zaszyfrowany, nie jawny', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    const { rows } = await db.query(
      'SELECT api_key FROM tenant_ai_config WHERE tenant_id = $1 AND purpose = $2',
      [tenantId, 'enrichment'],
    );
    expect(rows[0].api_key).not.toContain(API_KEY);
    expect(rows[0].api_key.length).toBeGreaterThan(API_KEY.length);
  });
});

describe('brak konfiguracji = funkcja wyłączona', () => {
  test('callAi rzuca AiNotConfiguredError, a NIE zwraca pustej odpowiedzi', async () => {
    await expect(aiClient.callAi({ tenantId, purpose: 'enrichment', system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(aiClient.AiNotConfiguredError);
    expect(await aiClient.isPurposeAvailable(tenantId, 'enrichment')).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('skonfigurowana funkcja działa i raportuje swojego dostawcę', async () => {
    await saveOk('enrichment', { provider: 'anthropic', apiKey: API_KEY }, okAnthropic);
    expect(await aiClient.isPurposeAvailable(tenantId, 'enrichment')).toBe(true);

    axios.post.mockResolvedValueOnce(okAnthropic);
    const res = await aiClient.callAi({ tenantId, purpose: 'enrichment', system: 's', user: 'u' });
    expect(res).toMatchObject({ content: 'pong', provider: 'anthropic' });
  });

  test('inna funkcja tego samego tenanta zostaje wyłączona', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await expect(aiClient.callAi({ tenantId, purpose: 'call_analysis', system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(aiClient.AiNotConfiguredError);
  });
});

describe('ponowna weryfikacja', () => {
  test('recheck podnosi invalid z powrotem do active, gdy klucz znów działa', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });
    await db.query(
      "UPDATE tenant_ai_config SET status='invalid' WHERE tenant_id=$1 AND purpose='enrichment'",
      [tenantId],
    );

    axios.post.mockResolvedValue(okOpenAi);
    expect(await aiConfig.recheckConfig(tenantId, 'enrichment')).toMatchObject({ status: 'active' });
    expect(await aiClient.isPurposeAvailable(tenantId, 'enrichment')).toBe(true);
  });

  test('recheck zapisuje powód, gdy dostawca nadal odrzuca', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    axios.post.mockRejectedValue(reject(401, 'key revoked'));
    const res = await aiConfig.recheckConfig(tenantId, 'enrichment');
    expect(res.status).toBe('invalid');
    expect(res.last_error).toMatch(/revoked/);
  });

  test('brak środków daje status "error", nie "invalid" — jest przejściowy', async () => {
    await saveOk('enrichment', { provider: 'openai', apiKey: API_KEY });

    axios.post.mockRejectedValue(reject(400, 'Your credit balance is too low'));
    const res = await aiConfig.recheckConfig(tenantId, 'enrichment');
    expect(res.status).toBe('error');
  });

  test('recheck nieskonfigurowanej funkcji daje 404', async () => {
    await expect(aiConfig.recheckConfig(tenantId, 'enrichment'))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('dostawca rozpoznawany z samego klucza', () => {
  test('prefiks zawęża kandydatów, ale sam nie rozstrzyga sk- ', () => {
    expect(providers.detectProviderCandidates('sk-ant-api03-xyz')).toEqual(['anthropic']);
    expect(providers.detectProviderCandidates('AIzaSyFakeGoogleKey')).toEqual(['gemini']);
    expect(providers.detectProviderCandidates('sk-proj-abc')).toEqual(['openai']);
    // „sk-" + 32 hex to kształt klucza DeepSeeka, ale OpenAI zostaje w kolejce:
    // decyduje dopiero odpytanie dostawcy, nie ten regex.
    expect(providers.detectProviderCandidates('sk-' + 'a'.repeat(32)))
      .toEqual(['deepseek', 'openai']);
    expect(providers.detectProviderCandidates('sk-' + 'a'.repeat(60)))
      .toEqual(['openai', 'deepseek']);
    expect(providers.detectProviderCandidates('')).toEqual([]);
  });

  test('rozpoznanie potwierdza dostawca: pierwszy, który przyjmie klucz', async () => {
    // DeepSeek odrzuca, OpenAI przyjmuje — mimo że prefiks typował DeepSeeka.
    axios.get
      .mockRejectedValueOnce(reject(401, 'invalid key'))
      .mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4.1' }] } });

    const res = await aiConfig.resolveProviderForKey('sk-' + 'a'.repeat(32));
    expect(res.provider).toBe('openai');
    expect(res.models).toEqual([{ id: 'gpt-4.1', label: 'gpt-4.1' }]);
  });

  test('klucz, którego nikt nie przyjmuje, daje 422 — nie zgadujemy', async () => {
    axios.get.mockRejectedValue(reject(401, 'invalid key'));
    await expect(aiConfig.resolveProviderForKey('sk-' + 'a'.repeat(32)))
      .rejects.toMatchObject({ status: 422 });
  });

  test('awaria sieci to 502, a nie „zły klucz"', async () => {
    axios.get.mockRejectedValue(reject(503, 'service unavailable'));
    await expect(aiConfig.resolveProviderForKey('sk-ant-cokolwiek'))
      .rejects.toMatchObject({ status: 502 });
  });

  test('zapis bez podanego dostawcy rozpoznaje go i zapisuje', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'claude-haiku-5-5' }] } });
    axios.post.mockResolvedValue(okAnthropic);

    const saved = await aiConfig.saveConfig(tenantId, 'enrichment', { apiKey: 'sk-ant-abc1234' });
    expect(saved.provider).toBe('anthropic');
    expect(saved.status).toBe('active');
  });
});
