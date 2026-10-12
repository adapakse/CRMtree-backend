'use strict';
// services/assistant/assistantClient.js — the language model behind the
// mobile app's form assistants.
//
// Provider, key and model come from the TENANT's configuration
// (tenant_ai_config, migration 0327), purpose 'assistant'. Until 2026-10-08 this
// ran on OUR shared Azure OpenAI deployment from env (Adam: gpt-4.1-mini, the
// task is simple), which meant we paid for every tenant's assistant. The Azure
// deployment and its AZURE_OPENAI_* variables are no longer read here; a tenant
// who wants a small cheap model simply picks one.
//
// The assistant needs STRICT JSON of a given schema, which only Anthropic and
// OpenAI can enforce — a tenant on Gemini or DeepSeek has no assistant, and gets
// the same 503 as any other outage, so the app falls back to the plain form.
//
// Other modules call `assistantClient.ask(...)` through this object so tests can
// replace it.

const logger = require('../../utils/logger');
const { callAiStructured, isPurposeAvailable } = require('../ai/aiClient');

const AI_PURPOSE = 'assistant';

// A reply is two sentences plus the form as JSON; this leaves room without
// letting a runaway answer cost much.
const MAX_OUTPUT_TOKENS = 800;

function unavailable(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

const assistantClient = {
  /** Whether this tenant has AI able to run the assistant. */
  async isConfigured(tenantId) {
    return isPurposeAvailable(tenantId, AI_PURPOSE);
  },

  /**
   * The model's answer to `messages` under the rules of `system`, as a JSON
   * string of `schema`. Throws an error with status 503 when the assistant
   * is not configured, too busy or down — the app falls back to the form.
   *
   * Returns a JSON STRING, not an object: the callers run it through
   * parseAnswer(), and keeping that boundary means this swap did not touch them.
   */
  async ask({ tenantId, name, schema, system, messages }) {
    try {
      const { content, parsed } = await callAiStructured({
        tenantId,
        purpose: AI_PURPOSE,
        system,
        messages,
        jsonSchema: schema,
        schemaName: name,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      });
      return content ?? (parsed ? JSON.stringify(parsed) : null);
    } catch (error) {
      logger.warn('[assistant] AI call failed', {
        tenantId, status: error.status ?? null, error: error.message,
      });
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
