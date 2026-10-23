'use strict';

// WhatsApp sending rules: free text only inside the customer's 24h window,
// approved templates anytime. Meta's Graph API and the database are both
// replaced, so this suite runs anywhere.

jest.mock('../config/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../utils/encrypt', () => ({ encrypt: v => v, decrypt: v => v }));

const { pool } = require('../config/database');
const whatsappService = require('../services/whatsappService');

const SENDER_CONFIG = {
  waba_id: 'waba-1', phone_number_id: 'pn-1', display_phone_number: '+48 500 000 000',
  access_token: 'token', is_enabled: true,
};

const FOLLOW_UP_TEMPLATE = {
  name: 'follow_up', language: 'pl', status: 'APPROVED', category: 'MARKETING',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Dzień dobry' },
    { type: 'BODY', text: 'Cześć {{1}}, tu {{2}} z CRM Tree.', example: { body_text: [['Anna', 'Kacper']] } },
    { type: 'FOOTER', text: 'Odpisz STOP, aby zrezygnować' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Zadzwońcie' }] },
  ],
};
const NAMED_TEMPLATE = {
  name: 'reminder', language: 'pl', status: 'APPROVED', category: 'UTILITY', parameter_format: 'NAMED',
  components: [{
    type: 'BODY', text: 'Przypominamy o spotkaniu {{date}}.',
    example: { body_text_named_params: [{ param_name: 'date', example: '24.10' }] },
  }],
};
const MEDIA_TEMPLATE = {
  name: 'promo', language: 'pl', status: 'APPROVED', category: 'MARKETING',
  components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Promocja!' }],
};

// pool.query answers by SQL shape: sender config, or the 24h-window lookup.
function database({ windowOpen }) {
  pool.query.mockImplementation(async sql => {
    if (sql.includes('FROM tenant_whatsapp_config')) return { rows: [SENDER_CONFIG] };
    if (sql.includes('FROM whatsapp_messages')) return { rows: windowOpen ? [{ '?column?': 1 }] : [] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

function meta({ templates = [FOLLOW_UP_TEMPLATE, NAMED_TEMPLATE, MEDIA_TEMPLATE], sendOk = true } = {}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async url => {
    if (url.includes('/message_templates')) {
      return { ok: true, status: 200, json: async () => ({ data: templates }) };
    }
    if (url.endsWith('/messages')) {
      return sendOk
        ? { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }
        : { ok: false, status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function sentPayload(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/messages'));
  return JSON.parse(call[1].body);
}

afterEach(() => jest.restoreAllMocks());

describe('sendTextMessage — 24h customer-service window', () => {
  test('outside the window it refuses before calling Meta', async () => {
    database({ windowOpen: false });
    const fetchMock = meta();
    await expect(whatsappService.sendTextMessage({ tenantId: 't1', to: '+48 600 100 200', body: 'Hej' }))
      .rejects.toMatchObject({ code: 'WHATSAPP_WINDOW_CLOSED', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('inside the window it sends plain text', async () => {
    database({ windowOpen: true });
    const fetchMock = meta();
    const result = await whatsappService.sendTextMessage({ tenantId: 't1', to: '+48 600 100 200', body: 'Hej' });
    expect(result.messageId).toBe('wamid.1');
    expect(sentPayload(fetchMock)).toEqual({ messaging_product: 'whatsapp', to: '48600100200', type: 'text', text: { body: 'Hej' } });
  });

  test('Meta rejecting with 131047 is reported as a closed window', async () => {
    database({ windowOpen: true });
    meta({ sendOk: false });
    await expect(whatsappService.sendTextMessage({ tenantId: 't1', to: '+48600100200', body: 'Hej' }))
      .rejects.toMatchObject({ code: 'WHATSAPP_WINDOW_CLOSED' });
  });
});

describe('listTemplates', () => {
  test('describes variables with their examples and flags templates the CRM cannot fill', async () => {
    database({ windowOpen: false });
    meta();
    const templates = await whatsappService.listTemplates('t1');
    const byName = Object.fromEntries(templates.map(t => [t.name, t]));

    expect(byName.follow_up).toMatchObject({
      supported: true, parameter_format: 'POSITIONAL', header_text: 'Dzień dobry', buttons: ['Zadzwońcie'],
      variables: [{ key: '1', example: 'Anna' }, { key: '2', example: 'Kacper' }],
    });
    expect(byName.reminder).toMatchObject({ supported: true, parameter_format: 'NAMED', variables: [{ key: 'date', example: '24.10' }] });
    expect(byName.promo).toMatchObject({ supported: false, unsupported_reason: 'HEADER_MEDIA' });
  });
});

describe('sendTemplateMessage', () => {
  test('sends positional parameters even when the window is closed and returns the rendered text', async () => {
    database({ windowOpen: false });
    const fetchMock = meta();
    const result = await whatsappService.sendTemplateMessage({
      tenantId: 't1', to: '+48 600 100 200', templateName: 'follow_up', language: 'pl', params: { 1: 'Ola', 2: 'Kacper' },
    });

    expect(sentPayload(fetchMock)).toEqual({
      messaging_product: 'whatsapp', to: '48600100200', type: 'template',
      template: {
        name: 'follow_up', language: { code: 'pl' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ola' }, { type: 'text', text: 'Kacper' }] }],
      },
    });
    expect(result.body).toBe('Dzień dobry\n\nCześć Ola, tu Kacper z CRM Tree.\n\nOdpisz STOP, aby zrezygnować');
  });

  test('sends named parameters with parameter_name', async () => {
    database({ windowOpen: false });
    const fetchMock = meta();
    await whatsappService.sendTemplateMessage({
      tenantId: 't1', to: '+48600100200', templateName: 'reminder', language: 'pl', params: { date: 'jutro' },
    });
    expect(sentPayload(fetchMock).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'date', text: 'jutro' }] },
    ]);
  });

  test.each([
    ['a missing variable', 'follow_up', { 1: 'Ola' }],
    ['a variable with a new line', 'follow_up', { 1: 'Ola\nNowak', 2: 'Kacper' }],
    ['a template that is not approved', 'unknown', {}],
    ['a template with a media header', 'promo', {}],
  ])('rejects %s without sending', async (_label, templateName, params) => {
    database({ windowOpen: false });
    const fetchMock = meta();
    await expect(whatsappService.sendTemplateMessage({ tenantId: 't1', to: '+48600100200', templateName, language: 'pl', params }))
      .rejects.toMatchObject({ code: 'WHATSAPP_TEMPLATE_INVALID' });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/messages'))).toBe(false);
  });
});
