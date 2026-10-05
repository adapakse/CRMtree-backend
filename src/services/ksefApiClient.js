'use strict';
// services/ksefApiClient.js
//
// HTTP client for KSeF 2.0 (the Polish national e-invoice system), read side:
// authentication with a KSeF token and the asynchronous invoice export.
// Protocol reference: https://github.com/CIRFMF/ksef-docs
//
// The environment is chosen by KSEF_ENVIRONMENT (test | production). Unset
// means the integration is off — callers check isConfigured() first.
//
// Nothing here logs or returns the KSeF token, the access tokens or the
// export key.

const crypto = require('crypto');

const ENVIRONMENT_URLS = {
  test: 'https://api-test.ksef.mf.gov.pl/v2',
  production: 'https://api.ksef.mf.gov.pl/v2',
};
const REQUEST_TIMEOUT_MS         = 30_000;
const DOWNLOAD_TIMEOUT_MS        = 120_000;
const PUBLIC_KEYS_TTL_MS         = 24 * 60 * 60_000;
const AUTH_POLL_INTERVAL_MS      = 1000;
const AUTH_POLL_ATTEMPTS         = 30;
const EXPORT_POLL_INTERVAL_MS    = 2000;
const EXPORT_POLL_ATTEMPTS       = 90;
const RATE_LIMIT_RETRIES         = 3;
// A longer wait means an hourly limit was hit; the run gives up and the next
// scheduled one continues from the stored cursor.
const MAX_RETRY_AFTER_SECONDS    = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const STATUS_IN_PROGRESS = 100;
const STATUS_DONE        = 200;
const MAX_ERROR_LENGTH   = 300;

class KsefApiError extends Error {
  constructor(message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'KsefApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// KSeF refused the token itself (wrong, revoked, issued for another NIP).
class KsefTokenRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KsefTokenRejectedError';
  }
}

// Replaced in tests so that polling and rate-limit waits take no time.
const timing = {
  sleep: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
};

function getEnvironment() {
  const environment = (process.env.KSEF_ENVIRONMENT || '').trim().toLowerCase();
  return ENVIRONMENT_URLS[environment] ? environment : null;
}

function isConfigured() {
  return getEnvironment() !== null;
}

function baseUrl() {
  const environment = getEnvironment();
  if (!environment) throw new KsefApiError('KSeF integration is not configured');
  return ENVIRONMENT_URLS[environment];
}

// Retry-After is either a number of seconds or an HTTP date.
function parseRetryAfterSeconds(headerValue) {
  if (!headerValue) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(headerValue);
  if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function describeErrorBody(payload) {
  const details = payload?.exception?.exceptionDetailList;
  if (Array.isArray(details) && details.length) {
    return details.map((detail) => detail?.exceptionDescription).filter(Boolean).join('; ');
  }
  return payload?.status?.description || payload?.title || payload?.detail || '';
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A network failure or timeout becomes a KsefApiError, so callers tell "KSeF
// is unreachable" apart from a bug in our own code.
async function fetchFromKsef(url, options, description) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw new KsefApiError(`KSeF is unreachable (${description}): ${err.name}`);
  }
}

// One KSeF call. HTTP 429 is waited out as told by Retry-After, a few times.
async function request(method, path, { bearerToken, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${baseUrl()}${path}`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchFromKsef(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, `${method} ${path}`);
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      if (attempt >= RATE_LIMIT_RETRIES || retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
        throw new KsefApiError(
          `KSeF rate limit reached on ${method} ${path} (retry after ${retryAfterSeconds} s)`,
          { status: 429, retryAfterSeconds },
        );
      }
      await timing.sleep(retryAfterSeconds * 1000);
      continue;
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const description = describeErrorBody(payload).slice(0, MAX_ERROR_LENGTH);
      throw new KsefApiError(
        `KSeF answered ${response.status} on ${method} ${path}${description ? `: ${description}` : ''}`,
        { status: response.status },
      );
    }
    return payload;
  }
}

// ── Public keys ─────────────────────────────────────────────────────────

let publicKeyCache = null;

async function loadPublicKeyCertificates() {
  const url = baseUrl();
  const isFresh = publicKeyCache
    && publicKeyCache.url === url
    && Date.now() - publicKeyCache.fetchedAt < PUBLIC_KEYS_TTL_MS;
  if (isFresh) return publicKeyCache.certificates;
  const certificates = await request('GET', '/security/public-key-certificates');
  if (!Array.isArray(certificates)) throw new KsefApiError('Unexpected KSeF public key response');
  publicKeyCache = { url, fetchedAt: Date.now(), certificates };
  return certificates;
}

function clearPublicKeyCache() {
  publicKeyCache = null;
}

async function encryptForKsef(usage, plaintext) {
  const certificates = await loadPublicKeyCertificates();
  const entry = certificates.find((candidate) => Array.isArray(candidate?.usage) && candidate.usage.includes(usage));
  if (!entry) throw new KsefApiError(`KSeF published no public key for ${usage}`);
  const publicKey = new crypto.X509Certificate(Buffer.from(entry.certificate, 'base64')).publicKey;
  return crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plaintext,
  ).toString('base64');
}

// ── Authentication ──────────────────────────────────────────────────────

function toSession(tokens) {
  if (!tokens?.accessToken?.token) throw new KsefApiError('Unexpected KSeF token response');
  return {
    accessToken: tokens.accessToken.token,
    accessTokenValidUntil: tokens.accessToken.validUntil,
    refreshToken: tokens.refreshToken?.token || null,
  };
}

function describeAuthStatus(status) {
  const details = Array.isArray(status?.details) ? status.details.join('; ') : '';
  return [status?.description, details].filter(Boolean).join(' — ').slice(0, MAX_ERROR_LENGTH);
}

async function waitForAuthentication(referenceNumber, authenticationToken) {
  for (let attempt = 0; attempt < AUTH_POLL_ATTEMPTS; attempt += 1) {
    const result = await request('GET', `/auth/${referenceNumber}`, { bearerToken: authenticationToken });
    const code = result?.status?.code;
    if (code === STATUS_DONE) return;
    if (code >= 400) {
      throw new KsefTokenRejectedError(describeAuthStatus(result.status) || 'KSeF rejected the token');
    }
    await timing.sleep(AUTH_POLL_INTERVAL_MS);
  }
  throw new KsefApiError('KSeF authentication timed out');
}

// Authenticates the company `nip` with its KSeF token. Throws
// KsefTokenRejectedError when KSeF refuses the token, KsefApiError otherwise.
async function authenticate(nip, ksefToken) {
  const challenge = await request('POST', '/auth/challenge');
  // The timestamp must be the one from the challenge, not the local clock.
  const encryptedToken = await encryptForKsef(
    'KsefTokenEncryption', Buffer.from(`${ksefToken}|${challenge.timestampMs}`, 'utf8'),
  );

  let started;
  try {
    started = await request('POST', '/auth/ksef-token', {
      body: {
        challenge: challenge.challenge,
        contextIdentifier: { type: 'Nip', value: nip },
        encryptedToken,
      },
    });
  } catch (err) {
    const isRejection = err instanceof KsefApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
    if (isRejection) throw new KsefTokenRejectedError(err.message);
    throw err;
  }

  const authenticationToken = started?.authenticationToken?.token;
  if (!started?.referenceNumber || !authenticationToken) {
    throw new KsefApiError('Unexpected KSeF authentication response');
  }
  await waitForAuthentication(started.referenceNumber, authenticationToken);
  return toSession(await request('POST', '/auth/token/redeem', { bearerToken: authenticationToken }));
}

async function refreshAccessToken(refreshToken) {
  const tokens = await request('POST', '/auth/token/refresh', { bearerToken: refreshToken });
  return { ...toSession(tokens), refreshToken };
}

// ── Invoice export ──────────────────────────────────────────────────────

// Starts an export of purchase invoices (the authenticated NIP is the buyer)
// stored permanently in [from, to). `to` null = open-ended, up to the
// high-water mark. A fresh AES key and IV are generated for every export.
async function startPurchaseInvoiceExport(accessToken, { from, to }) {
  const key = crypto.randomBytes(32);
  const initializationVector = crypto.randomBytes(16);
  const dateRange = {
    dateType: 'PermanentStorage',
    from: from.toISOString(),
    restrictToPermanentStorageHwmDate: true,
  };
  if (to) dateRange.to = to.toISOString();

  const started = await request('POST', '/invoices/exports', {
    bearerToken: accessToken,
    body: {
      encryption: {
        encryptedSymmetricKey: await encryptForKsef('SymmetricKeyEncryption', key),
        initializationVector: initializationVector.toString('base64'),
      },
      filters: { subjectType: 'Subject2', dateRange },
    },
  });
  if (!started?.referenceNumber) throw new KsefApiError('Unexpected KSeF export response');
  return { referenceNumber: started.referenceNumber, key, initializationVector };
}

// Resolves with the export's `package` (null when the window held nothing).
async function waitForExport(accessToken, referenceNumber) {
  for (let attempt = 0; attempt < EXPORT_POLL_ATTEMPTS; attempt += 1) {
    await timing.sleep(EXPORT_POLL_INTERVAL_MS);
    const result = await request('GET', `/invoices/exports/${referenceNumber}`, { bearerToken: accessToken });
    const code = result?.status?.code;
    if (code === STATUS_DONE) return result.package || null;
    if (code !== STATUS_IN_PROGRESS) {
      throw new KsefApiError(
        `KSeF export failed (${code}): ${String(result?.status?.description || '').slice(0, MAX_ERROR_LENGTH)}`,
      );
    }
  }
  throw new KsefApiError('KSeF export timed out');
}

// Part URLs are pre-signed: they must be called without the Authorization header.
async function downloadExportPart(part) {
  let url;
  try {
    url = new URL(part?.url);
  } catch {
    throw new KsefApiError('KSeF export part has no valid URL');
  }
  if (url.protocol !== 'https:') throw new KsefApiError('KSeF export part URL is not HTTPS');
  const response = await fetchFromKsef(url, {
    method: part.method || 'GET',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }, 'export part download');
  if (!response.ok) throw new KsefApiError(`Downloading a KSeF export part failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {
  KsefApiError,
  KsefTokenRejectedError,
  timing,
  getEnvironment,
  isConfigured,
  parseRetryAfterSeconds,
  clearPublicKeyCache,
  authenticate,
  refreshAccessToken,
  startPurchaseInvoiceExport,
  waitForExport,
  downloadExportPart,
};
