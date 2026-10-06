'use strict';
// src/config/email-providers.js
//
// Central registry of supported CRM email providers. This is the ONE place
// that lists provider keys — admin-tenants.js, crm-email.js and the
// requireActiveEmailProvider middleware all read from here instead of
// hardcoding ['gmail', 'outlook', ...] separately.
//
// To add a new provider: implement its service module (same shape as
// gmailService/outlookService/zohoService — getAuthUrl, exchangeCodeAndSave,
// getStatus, disconnect, sendEmail, getThread, getNewMessages) and add one
// entry below, plus its required fields in emailProviderRequiredFields.js.
//
// No other JS file needs to change its list of provider keys — but the DATABASE
// does. Four CHECK constraints repeat the list and reject an unknown provider
// with 23514 (see migration 0317, which widened them for 'yandex'):
//   tenant_email_providers.provider          — saving a tenant's credentials
//   tenants.active_email_provider            — activating the provider
//   crm_lead_activities.email_provider       — storing received/sent mail
//   crm_partner_activities.email_provider    — same, for partners
// The frontend is not registry-driven either: the tenant admin panel
// (pages/admin/tenants/tenants.component.ts) hardcodes a signal, a form and a
// template block per provider, and each provider has its own OAuth callback
// component and route.

const gmailService   = require('../services/gmailService');
const outlookService = require('../services/outlookService');
const zohoService    = require('../services/zohoService');
const yandexService  = require('../services/yandexService');
const { REQUIRED_CONFIG_FIELDS } = require('./emailProviderRequiredFields');

const EMAIL_PROVIDERS = {
  gmail: {
    key: 'gmail',
    label: 'Gmail / Google Workspace',
    service: gmailService,
    supportsAttachments: true,
    // Fields the tenant admin panel collects/saves for this provider.
    configFields: ['client_id', 'client_secret', 'redirect_uri', 'pubsub_topic', 'pubsub_subscription'],
    // Subset of configFields that must be filled in per tenant — see
    // emailProviderRequiredFields.js for the single source of truth and why
    // pubsub_subscription is excluded.
    requiredConfigFields: REQUIRED_CONFIG_FIELDS.gmail,
  },
  outlook: {
    key: 'outlook',
    label: 'Outlook / Microsoft 365',
    service: outlookService,
    supportsAttachments: true,
    configFields: ['client_id', 'client_secret', 'redirect_uri', 'azure_tenant_id'],
    requiredConfigFields: REQUIRED_CONFIG_FIELDS.outlook,
  },
  zoho: {
    key: 'zoho',
    label: 'Zoho Mail',
    service: zohoService,
    supportsAttachments: true,
    configFields: ['client_id', 'client_secret', 'redirect_uri'],
    requiredConfigFields: REQUIRED_CONFIG_FIELDS.zoho,
  },
  yandex: {
    key: 'yandex',
    label: 'Yandex Mail',
    service: yandexService,
    // Attachments ride on the MIME message over IMAP/SMTP, so this is true in
    // principle — but every mail operation is stage 2 (see yandexService header),
    // so nothing reads this flag for Yandex yet.
    supportsAttachments: true,
    // Same three fields as Zoho: Yandex needs no Pub/Sub topic (that is Gmail's
    // push mechanism) and no directory id (that is Azure's).
    configFields: ['client_id', 'client_secret', 'redirect_uri'],
    requiredConfigFields: REQUIRED_CONFIG_FIELDS.yandex,
  },
};

const EMAIL_PROVIDER_KEYS = Object.keys(EMAIL_PROVIDERS);

module.exports = { EMAIL_PROVIDERS, EMAIL_PROVIDER_KEYS };
