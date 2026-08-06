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

module.exports = { ProviderNotConfiguredError };
