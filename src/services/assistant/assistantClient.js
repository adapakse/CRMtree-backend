'use strict';
// services/assistant/assistantClient.js — the language model behind the
// mobile app's form assistants: Azure OpenAI, a small model (Adam,
// 2026-10-08: gpt-4.1-mini, the task is simple).
//
// The model answers in strict JSON of a given schema. Other modules call
// `assistantClient.ask(...)` through this object so tests can replace it.

const config = require('../../config');
const logger = require('../../utils/logger');

// A reply is two sentences plus the form as JSON; this leaves room without
// letting a runaway answer cost much.
const MAX_OUTPUT_TOKENS = 800;
const REQUEST_TIMEOUT_MS = 30000;

function unavailable(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

const assistantClient = {
  isConfigured() {
    const { endpoint, apiKey, deployment } = config.azureOpenAi;
    return Boolean(endpoint && apiKey && deployment);
  },

  /**
   * The model's answer to `messages` under the rules of `system`, as a JSON
   * string of `schema`. Throws an error with status 503 when the assistant
   * is not configured, too busy or down — the app falls back to the form.
   */
  async ask({ name, schema, system, messages }) {
    if (!assistantClient.isConfigured()) throw unavailable('Asystent nie jest skonfigurowany.');
    const { endpoint, apiKey, deployment, apiVersion } = config.azureOpenAi;
    const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
      if (!response.ok) {
        logger.warn('[assistant] Azure OpenAI refused the request', { status: response.status, response: (await response.text()).slice(0, 300) });
        throw unavailable('Asystent jest chwilowo niedostępny, spróbuj ponownie.');
      }
      const completion = await response.json();
      return completion.choices?.[0]?.message?.content ?? null;
    } catch (error) {
      if (error.status === 503) throw error;
      logger.warn('[assistant] Azure OpenAI call failed', { error: error.message });
      throw unavailable('Asystent jest chwilowo niedostępny, spróbuj ponownie.');
    }
  },
};

/** The model's JSON, or a 503 when it is not what was asked for. */
function parseAnswer(content) {
  try {
    const parsed = JSON.parse(content ?? '');
    if (parsed && typeof parsed === 'object' && parsed.intent) return parsed;
  } catch {
    // Falls through to the error below.
  }
  throw unavailable('Asystent odpowiedział nieczytelnie, spróbuj ponownie.');
}

module.exports = { assistantClient, parseAnswer };
