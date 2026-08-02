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
// entry below. No other file needs to change its list of provider keys.

const gmailService   = require('../services/gmailService');
const outlookService = require('../services/outlookService');
const zohoService    = require('../services/zohoService');
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
};

const EMAIL_PROVIDER_KEYS = Object.keys(EMAIL_PROVIDERS);

module.exports = { EMAIL_PROVIDERS, EMAIL_PROVIDER_KEYS };
