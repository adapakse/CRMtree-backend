'use strict';
// Shared error type for "tenant has no usable config for this provider".
// Thrown by gmailService/outlookService/zohoService instead of silently
// falling back to global .env credentials. Carries .status so it reaches
// the client as a 4xx through the normal error-handling paths (either
// next(err) -> errorHandler, or a route's own catch block).

class ProviderNotConfiguredError extends Error {
  constructor(provider) {
    super(`Poczta (${provider}) nie jest skonfigurowana dla tej organizacji. Skontaktuj się z administratorem.`);
    this.name     = 'ProviderNotConfiguredError';
    this.status   = 400;
    this.code     = 'PROVIDER_NOT_CONFIGURED';
    this.provider = provider;
  }
}

// Thrown when a tenant HAS an enabled tenant_email_providers row for this
// provider, but one or more fields that must be filled in per tenant
// (redirect_uri, azure_tenant_id, pubsub_topic, ...) are missing — instead of
// silently falling back to a global .env value for that one field.
class IncompleteProviderConfigError extends Error {
  constructor(provider, missingFields) {
    super(`Konfiguracja poczty (${provider}) dla tej organizacji jest niekompletna — brakuje pola: ${missingFields.join(', ')}. Uzupełnij ją w ustawieniach tenanta.`);
    this.name          = 'IncompleteProviderConfigError';
    this.status        = 400;
    this.code          = 'PROVIDER_CONFIG_INCOMPLETE';
    this.provider      = provider;
    this.missingFields = missingFields;
  }
}

// Thrown when a per-user mailbox connect (exchangeCodeAndSave) would attach
// a Google/Microsoft/Zoho account that's already connected to a DIFFERENT
// CRM user — the unique index on email (see migration 0208) makes this a DB
// constraint violation; this wraps it into a message the oauth/callback
// route can redirect with instead of a raw Postgres error.
class MailboxAlreadyConnectedError extends Error {
  constructor(provider) {
    super(`To konto jest już połączone z innym użytkownikiem CRM. Poproś administratora o sprawdzenie, kto je podłączył, albo użyj innego konta ${provider === 'gmail' ? 'Google' : provider}.`);
    this.name     = 'MailboxAlreadyConnectedError';
    this.status   = 409;
    this.code     = 'MAILBOX_ALREADY_CONNECTED';
    this.provider = provider;
  }
}

module.exports = { ProviderNotConfiguredError, IncompleteProviderConfigError, MailboxAlreadyConnectedError };
