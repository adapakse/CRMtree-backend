"use strict";

require("dotenv").config();

function required(name) {
  const v = process.env[name];
  if (!v && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v || "";
}

function optional(name, defaultValue = "") {
  return process.env[name] || defaultValue;
}

module.exports = {
  env: optional("NODE_ENV", "development"),
  port: parseInt(optional("PORT", "3000")),
  appUrl: optional("APP_URL", "http://localhost:3000"),
  frontendUrl: optional("FRONTEND_URL", "http://localhost:4200"),
  isDev: optional("NODE_ENV", "development") === "development",
  isProd: optional("NODE_ENV", "development") === "production",

  db: {
    host: optional("DB_HOST", "localhost"),
    port: parseInt(optional("DB_PORT", "5432")),
    database: optional("DB_NAME", "worktrips_doc"),
    user: optional("DB_USER", "postgres"),
    password: optional("DB_PASSWORD", ""),
    ssl: optional("DB_SSL", "false") === "true",
    poolMax: parseInt(optional("DB_POOL_MAX", "20")),
    idleTimeoutMillis: parseInt(optional("DB_POOL_IDLE_TIMEOUT", "30000")),
    connectionTimeoutMillis: parseInt(
      optional("DB_POOL_CONNECTION_TIMEOUT", "10000"),
    ),
  },

  jwt: {
    secret: optional(
      "JWT_SECRET",
      "dev_secret_change_in_production_min_64_chars_xxxxxxxxxxxxxxxxxxxx",
    ),
    expiresIn: optional("JWT_EXPIRES_IN", "8h"),
    refreshExpiresIn: optional("JWT_REFRESH_EXPIRES_IN", "7d"),
  },

  saml: {
    entryPoint: optional("SAML_ENTRY_POINT"),
    issuer: optional("SAML_ISSUER", "worktrips-doc"),
    callbackUrl: optional("SAML_CALLBACK_URL"),
    idpCert: optional("SAML_IDP_CERT"),
  },

  storage: {
    accountName: optional("AZURE_STORAGE_ACCOUNT_NAME"),
    accountKey: optional("AZURE_STORAGE_ACCOUNT_KEY"),
    connectionString: optional("AZURE_STORAGE_CONNECTION_STRING"),
    container: optional("AZURE_STORAGE_CONTAINER", "documents"),
  },

  email: {
    from: optional("EMAIL_FROM", "noreply@worktrips.com"),
    fromName: optional("EMAIL_FROM_NAME", "worktrips.doc"),
  },

  // ─── Google Workspace / Gmail API ─────────────────────────────────────────
  // Dwa tryby autoryzacji (można stosować jeden lub oba równolegle):
  //
  // [A] Service Account z Domain-Wide Delegation — wysyłka "w imieniu" skrzynki
  //     GOOGLE_SERVICE_ACCOUNT_JSON  — cała zawartość pliku JSON (env secrets)
  //     GOOGLE_SERVICE_ACCOUNT_FILE  — ścieżka do pliku JSON (lokalnie)
  //
  // [B] OAuth2 per-user — każdy handlowiec autoryzuje własne konto Google
  //     Wymagane: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
  //     Opcjonalne: GOOGLE_PUBSUB_TOPIC — do odbierania push-notyfikacji Gmail
  //
  google: {
    // [A] Service Account
    serviceAccountJson: optional("GOOGLE_SERVICE_ACCOUNT_JSON"),
    serviceAccountFile: optional("GOOGLE_SERVICE_ACCOUNT_FILE"),
    impersonateEmail: optional(
      "GOOGLE_IMPERSONATE_EMAIL",
      "noreply@worktrips.com",
    ),
    sendInDev: optional("GOOGLE_SEND_IN_DEV", "false") === "true",

    // [B] OAuth2 per-user
    clientId:    optional("GOOGLE_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET"),
    redirectUri:  optional(
      "GOOGLE_REDIRECT_URI",
      "http://localhost:3000/api/crm/gmail/oauth/callback",
    ),
    // Pub/Sub topic (format: projects/<project>/topics/<topic>)
    // Wymagany do rejestracji Gmail watch (gmail.users.watch).
    pubsubTopic: optional("GOOGLE_PUBSUB_TOPIC"),
    // Pub/Sub subskrypcja pull (format: projects/<project>/subscriptions/<name>)
    // Zastępuje push webhook — aplikacja sama odpytuje kolejkę.
    pubsubSubscription: optional("GOOGLE_PUBSUB_SUBSCRIPTION"),
  },

  signus: {
    baseUrl: optional("SIGNUS_API_BASE_URL", "https://api.signus.eu/v1"),
    apiKey: optional("SIGNUS_API_KEY"),
    webhookSecret: optional("SIGNUS_WEBHOOK_SECRET"),
  },

  rateLimit: {
    windowMs: parseInt(optional("RATE_LIMIT_WINDOW_MS", "900000")),
    max: parseInt(optional("RATE_LIMIT_MAX", "200")),
  },

  upload: {
    maxSizeMb: parseInt(optional("MAX_FILE_SIZE_MB", "50")),
    allowedMimeTypes: optional(
      "ALLOWED_MIME_TYPES",
      "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword",
    ).split(","),
  },
};
