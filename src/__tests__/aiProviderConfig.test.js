'use strict';

// Dostawca AI, klucz i modele per tenant (migracja 0327).
//
// Testuje to, co w tym mechanizmie jest nowe i co najdrożej byłoby zepsuć:
//   - cztery adaptery dostawców mówią różnymi kontraktami, a zwracają jeden
//     wspólny kształt { content, model, usage },
//   - klucz NIGDY nie wychodzi z API ani z logów — tylko hint,
//   - klucz i modele są weryfikowane realnym wywołaniem PRZED zapisem,
//   - brak konfiguracji = funkcja AI wyłączona (AiNotConfiguredError), NIE ciche
//     zero — ciche zero zapisałoby enrichment jako ukończony z wynikiem 0,
//     dokładnie jak w regresji naprawionej 23.09,
//   - odrzucony klucz oznacza konfigurację jako 'invalid', żeby kolejne
//     wywołania nie dobijały dostawcy 401-ką.
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
  data: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'pong' }],
          usage: { input_tokens: 11, output_tokens: 2 } },
};
const okGemini = {
  data: { modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { parts: [{ text: 'pong' }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2 } },
};
const reject = (status, message) => {
  const err = new Error(message);
  err.response = { status, data: { error: { message } } };
  return err;
};

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

beforeEach(() => { axios.post.mockReset(); });
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
      apiKey: API_KEY, model: 'claude-haiku-4-5', system: 's', user: 'u',
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

  test('401 to "invalid" (nie ponawiać), 500 to "error" (warte ponowienia)', async () => {
    axios.post.mockRejectedValueOnce(reject(401, 'bad key'));
    await expect(providers.callProvider('openai', { apiKey: 'x', model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'invalid', status: 401 });

    axios.post.mockRejectedValueOnce(reject(500, 'boom'));
    await expect(providers.callProvider('openai', { apiKey: 'x', model: 'm', system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'error', status: 500 });
  });
});

describe('zapis konfiguracji', () => {
  test('weryfikuje klucz realnym wywołaniem PRZED zapisem', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic);
    const saved = await aiConfig.saveConfig(tenantId, {
      provider: 'anthropic', apiKey: API_KEY, modelFast: 'claude-haiku-4-5',
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ provider: 'anthropic', status: 'active', model_fast: 'claude-haiku-4-5' });
  });

  test('odrzucony klucz NIE zostaje zapisany', async () => {
    axios.post.mockRejectedValueOnce(reject(401, 'invalid api key'));
    await expect(aiConfig.saveConfig(tenantId, {
      provider: 'openai', apiKey: 'zly', modelFast: 'gpt-4.1-mini',
    })).rejects.toMatchObject({ status: 422 });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config).toBeNull();
  });

  test('weryfikuje OBA modele, gdy quality jest inny niż fast', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic).mockResolvedValueOnce(okAnthropic);
    await aiConfig.saveConfig(tenantId, {
      provider: 'anthropic', apiKey: API_KEY,
      modelFast: 'claude-haiku-4-5', modelQuality: 'claude-sonnet-5',
    });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls.map(c => c[1].model)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  test('nieistniejący model_quality blokuje zapis całej konfiguracji', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic).mockRejectedValueOnce(reject(404, 'model not found'));
    await expect(aiConfig.saveConfig(tenantId, {
      provider: 'anthropic', apiKey: API_KEY, modelFast: 'claude-haiku-4-5', modelQuality: 'nie-ma-takiego',
    })).rejects.toMatchObject({ status: 422 });
    expect((await aiConfig.getConfig(tenantId)).config).toBeNull();
  });

  test('zmiana samego modelu nie wymaga ponownego wklejania klucza', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });

    axios.post.mockResolvedValueOnce(okOpenAi);
    const updated = await aiConfig.saveConfig(tenantId, { provider: 'openai', modelFast: 'gpt-4.1' });
    expect(updated.model_fast).toBe('gpt-4.1');
    // Ten sam klucz — poznajemy po hincie, bo samego klucza API nie wydaje.
    expect(updated.api_key_hint).toBe(API_KEY.slice(-4));
  });

  test('pierwszy zapis bez klucza jest odrzucany', async () => {
    await expect(aiConfig.saveConfig(tenantId, { provider: 'openai', modelFast: 'gpt-4.1-mini' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('nieznany dostawca odrzucony bez dotykania sieci', async () => {
    await expect(aiConfig.saveConfig(tenantId, {
      provider: 'skynet', apiKey: API_KEY, modelFast: 'm',
    })).rejects.toMatchObject({ status: 400 });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('klucz API nie wycieka', () => {
  test('getConfig zwraca hint, nigdy klucza', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.api_key_hint).toBe('9876');
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(Object.keys(config)).not.toContain('api_key');
  });

  test('w bazie klucz jest zaszyfrowany, nie jawny', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });

    const { rows } = await db.query('SELECT api_key FROM tenant_ai_config WHERE tenant_id = $1', [tenantId]);
    expect(rows[0].api_key).not.toContain(API_KEY);
    expect(rows[0].api_key.length).toBeGreaterThan(API_KEY.length);
  });
});

describe('brak konfiguracji = funkcja AI wyłączona', () => {
  test('callAi rzuca AiNotConfiguredError, a NIE zwraca pustej odpowiedzi', async () => {
    await expect(aiClient.callAi({ tenantId, system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(aiClient.AiNotConfiguredError);
    expect(await aiClient.isConfigured(tenantId)).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('po skonfigurowaniu callAi działa i raportuje dostawcę', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic);
    await aiConfig.saveConfig(tenantId, { provider: 'anthropic', apiKey: API_KEY, modelFast: 'claude-haiku-4-5' });
    expect(await aiClient.isConfigured(tenantId)).toBe(true);

    axios.post.mockResolvedValueOnce(okAnthropic);
    const res = await aiClient.callAi({ tenantId, system: 's', user: 'u', purpose: 'test' });
    expect(res).toMatchObject({ content: 'pong', provider: 'anthropic' });
  });

  test('tier quality bez własnego modelu spada na model_fast', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic);
    await aiConfig.saveConfig(tenantId, { provider: 'anthropic', apiKey: API_KEY, modelFast: 'claude-haiku-4-5' });

    axios.post.mockResolvedValueOnce(okAnthropic);
    await aiClient.callAi({ tenantId, system: 's', user: 'u', tier: 'quality' });
    expect(axios.post.mock.calls.at(-1)[1].model).toBe('claude-haiku-4-5');
  });

  test('tier quality używa model_quality, gdy jest ustawiony', async () => {
    axios.post.mockResolvedValueOnce(okAnthropic).mockResolvedValueOnce(okAnthropic);
    await aiConfig.saveConfig(tenantId, {
      provider: 'anthropic', apiKey: API_KEY,
      modelFast: 'claude-haiku-4-5', modelQuality: 'claude-sonnet-5',
    });

    axios.post.mockResolvedValueOnce(okAnthropic);
    await aiClient.callAi({ tenantId, system: 's', user: 'u', tier: 'quality' });
    expect(axios.post.mock.calls.at(-1)[1].model).toBe('claude-sonnet-5');
  });

  test('odrzucony klucz w trakcie pracy oznacza konfigurację jako invalid i blokuje kolejne wywołania', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });

    axios.post.mockRejectedValueOnce(reject(401, 'key revoked'));
    await expect(aiClient.callAi({ tenantId, system: 's', user: 'u' }))
      .rejects.toMatchObject({ kind: 'invalid' });

    const { config } = await aiConfig.getConfig(tenantId);
    expect(config.status).toBe('invalid');
    expect(await aiClient.isConfigured(tenantId)).toBe(false);

    // Kolejne wywołanie nie dobija już dostawcy — odcina je sam klient.
    const callsBefore = axios.post.mock.calls.length;
    await expect(aiClient.callAi({ tenantId, system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(aiClient.AiNotConfiguredError);
    expect(axios.post.mock.calls.length).toBe(callsBefore);
  });
});

describe('usunięcie i ponowna weryfikacja', () => {
  test('usunięcie konfiguracji wyłącza AI', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });
    await aiConfig.deleteConfig(tenantId);
    expect(await aiClient.isConfigured(tenantId)).toBe(false);
    await expect(aiConfig.deleteConfig(tenantId)).rejects.toMatchObject({ status: 404 });
  });

  test('recheck podnosi invalid z powrotem do active, gdy klucz znów działa', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });
    await db.query(`UPDATE tenant_ai_config SET status='invalid' WHERE tenant_id=$1`, [tenantId]);

    axios.post.mockResolvedValueOnce(okOpenAi);
    expect(await aiConfig.recheckConfig(tenantId)).toMatchObject({ status: 'active' });
    expect(await aiClient.isConfigured(tenantId)).toBe(true);
  });

  test('recheck zapisuje powód, gdy dostawca nadal odrzuca', async () => {
    axios.post.mockResolvedValueOnce(okOpenAi);
    await aiConfig.saveConfig(tenantId, { provider: 'openai', apiKey: API_KEY, modelFast: 'gpt-4.1-mini' });

    axios.post.mockRejectedValueOnce(reject(401, 'key revoked'));
    const res = await aiConfig.recheckConfig(tenantId);
    expect(res.status).toBe('invalid');
    expect(res.last_error).toMatch(/revoked/);
  });
});
