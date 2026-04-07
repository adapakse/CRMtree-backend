'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// src/services/testAccountService.js
//
// Serwis integracji z zewnętrznym API CreateTestAccount.
//
// ─── PRZEŁĄCZENIE NA DZIAŁAJĄCE API ─────────────────────────────────────────
// 1. Ustaw zmienną środowiskową:
//      TEST_ACCOUNT_API_URL=https://api.zewnetrzny-system.pl/v1
//      TEST_ACCOUNT_API_KEY=<klucz_api>
// 2. Zmień stałą USE_STUB na: false
//      const USE_STUB = false;
// 3. Upewnij się, że konfiguracja w src/config/index.js zawiera:
//      testAccountApi: {
//        url: process.env.TEST_ACCOUNT_API_URL,
//        key: process.env.TEST_ACCOUNT_API_KEY,
//      }
// 4. Usuń blok "STUB" poniżej (lub zostaw — USE_STUB będzie false, więc nie wejdzie).
// ─────────────────────────────────────────────────────────────────────────────

const https  = require('https');
const http   = require('http');
const logger = require('../utils/logger');

// ── STUB: zmień na false gdy zewnętrzne API jest gotowe ──────────────────────
const USE_STUB = true;
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wywołuje zewnętrzne API CreateTestAccount.
 *
 * @param {Object} payload
 * @param {string} payload.companyName       - Nazwa firmy (z Leada)
 * @param {string} payload.nip               - NIP (z Leada)
 * @param {string} payload.subdomain         - Subdomena w systemie zewnętrznym
 * @param {string} payload.language          - Język interfejsu
 * @param {string} payload.partnerCurrency   - Waluta
 * @param {string} payload.country           - Kraj
 * @param {string} payload.billingAddress    - Adres rozliczeniowy
 * @param {string} payload.billingZip        - Kod pocztowy
 * @param {string} payload.billingCity       - Miasto
 * @param {string} payload.billingCountry    - Kraj rozliczeniowy
 * @param {string} payload.billingEmail      - Email rozliczeniowy
 * @param {string} payload.adminFirstName    - Imię administratora
 * @param {string} payload.adminLastName     - Nazwisko administratora
 * @param {string} payload.adminEmail        - Email administratora
 *
 * @returns {Promise<{ success: boolean, accountNumber?: string, error?: string }>}
 */
async function createTestAccount(payload) {
  if (USE_STUB) {
    return _stub(payload);
  }
  return _callRealApi(payload);
}

// ── STUB ─────────────────────────────────────────────────────────────────────
// Symuluje działanie zewnętrznego API.
// Zwraca sukces z losowym numerem konta lub losowy błąd (dla testów).
// Usuń lub zignoruj tę funkcję po przełączeniu na USE_STUB = false.
async function _stub(payload) {
  logger.info('[STUB] testAccountService.createTestAccount called', {
    company: payload.companyName,
    subdomain: payload.subdomain,
  });

  // Symulacja opóźnienia sieci
  await new Promise(r => setTimeout(r, 600));

  // Symulacja błędu walidacji (co 5. wywołanie — do testów frontendu)
  if (payload.subdomain && payload.subdomain.includes('error')) {
    return {
      success: false,
      error: '[STUB] Subdomena jest już zajęta. Wybierz inną subdomenę.',
    };
  }

  // Wygeneruj losowy numer konta testowego
  const accountNumber = 'TEST-' + Date.now().toString(36).toUpperCase();

  logger.info('[STUB] testAccountService — returning success', { accountNumber });

  return {
    success: true,
    accountNumber,
  };
}
// ── / STUB ────────────────────────────────────────────────────────────────────

// ── PRAWDZIWE API ────────────────────────────────────────────────────────────
// Odkomentuj i skonfiguruj po otrzymaniu specyfikacji od zewnętrznego systemu.
async function _callRealApi(payload) {
  const config = require('../config');
  const apiUrl = config.testAccountApi?.url;
  const apiKey = config.testAccountApi?.key;

  if (!apiUrl || !apiKey) {
    throw new Error('testAccountApi.url lub testAccountApi.key nie skonfigurowane w config/index.js');
  }

  const body = JSON.stringify({
    // ── Mapowanie pól zgodnie ze specyfikacją zewnętrznego API ──────
    // Dostosuj nazwy pól gdy otrzymasz finalną spec od zewnętrznego zespołu.
    company_name:      payload.companyName,
    nip:               payload.nip,
    subdomain:         payload.subdomain,
    language:          payload.language,
    currency:          payload.partnerCurrency,
    country:           payload.country,
    billing: {
      address:         payload.billingAddress,
      zip:             payload.billingZip,
      city:            payload.billingCity,
      country:         payload.billingCountry,
      email:           payload.billingEmail,
    },
    admin: {
      first_name:      payload.adminFirstName,
      last_name:       payload.adminLastName,
      email:           payload.adminEmail,
    },
  });

  const url    = new URL('/api/CreateTestAccount', apiUrl);
  const isHttps = url.protocol === 'https:';
  const mod    = isHttps ? https : http;

  const response = await new Promise((resolve, reject) => {
    const req = mod.request(url.toString(), {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (e) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout połączenia z zewnętrznym API')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  logger.info('testAccountService._callRealApi response', {
    status:  response.status,
    body:    response.body,
  });

  // ── Interpretacja odpowiedzi ───────────────────────────────────────
  // Dostosuj pola odpowiedzi do faktycznej specyfikacji zewnętrznego API.
  if (response.status >= 200 && response.status < 300 && response.body.accountNumber) {
    return {
      success:       true,
      accountNumber: String(response.body.accountNumber),
    };
  }

  return {
    success: false,
    error:   response.body?.message || response.body?.error || `Błąd HTTP ${response.status}`,
  };
}
// ── / PRAWDZIWE API ──────────────────────────────────────────────────────────

module.exports = { createTestAccount };
