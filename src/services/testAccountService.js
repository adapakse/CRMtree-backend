'use strict';
// src/services/testAccountService.js
//
// Integracja z HTCD API — zakładanie konta testowego dla Partnera.
// Endpoint: POST https://api-htcd.worktrips.com/v3/hooks/crm/partners
// Auth: ApiKey w nagłówku Authorization

const https  = require('https');
const http   = require('http');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Zakłada konto testowe w systemie HTCD.
 *
 * @param {Object} p
 * @param {string} p.companyName
 * @param {string} p.nip
 * @param {string} p.subdomain
 * @param {string} p.language          - np. "PL"
 * @param {string} p.partnerCurrency   - np. "PLN"
 * @param {string} p.country           - np. "PL"
 * @param {string} p.billingAddress
 * @param {string} p.billingZip
 * @param {string} p.billingCity
 * @param {string} p.billingCountry
 * @param {string} p.billingEmail
 * @param {string} p.adminFirstName
 * @param {string} p.adminLastName
 * @param {string} p.adminEmail
 * @param {string} p.creatorEmail      - email zalogowanego usera (Google IDP)
 * @param {Array}  p.formConfigs       - z app_settings.ta_form_configs
 * @param {Object} p.partnerConfig     - z app_settings.ta_partner_config
 *
 * @returns {Promise<{ success: boolean, htcdPartnerId?: number, priceListUrl?: string, error?: string }>}
 */
async function createTestAccount(p) {
  const apiUrl = config.htcd?.apiUrl;
  const apiKey = config.htcd?.apiKey;

  if (!apiKey) {
    logger.warn('[testAccountService] HTCD_API_KEY nie skonfigurowany — używam STUB (tryb lokalny)');
    return _stub(p);
  }

  const pc = p.partnerConfig || {};

  const body = JSON.stringify({
    wh: {
      whitelabelHeader:                   pc.whitelabelHeader || '#1D2951',
      whitelabelColor:                    pc.whitelabelColor  || '#1D2951',
      currency:                           p.partnerCurrency,
      lang:                               p.language,
      enableMealSelection:                pc.enableMealSelection !== false,
      internalCommunicatorNotifications:  pc.internalCommunicatorNotifications !== false,
      whitelabelName:                     p.subdomain,
      whitelabelSubdomain:                p.subdomain,
      gdsProfileLocator:                  pc.gdsProfileLocator     || '',
      gdsProfileLocatorManual:            pc.gdsProfileLocatorManual || '',
      whitelabelCountry:                  p.country,
      defaultBillingAddress: {
        companyName:    p.companyName,
        address:        p.billingAddress,
        zipCode:        p.billingZip,
        town:           p.billingCity,
        country:        p.billingCountry,
        taxNumber:      p.nip || '',
        emailAddress:   [p.billingEmail],
        currency:       p.partnerCurrency,
        issuer:         pc.issuer || 'WT',
        language:       p.language,
      },
    },
    selectedPartnerType:        pc.selectedPartnerType        || 'PARTNER_BASIC',
    testAccount:                true,
    defaultServicesProcessType: pc.defaultServicesProcessType || 'ONLINE',
    isContractSigned:           false,
    formConfigs:                p.formConfigs,
    admin: {
      email:   p.adminEmail,
      name:    p.adminFirstName,
      surname: p.adminLastName,
    },
    travelerConfig: pc.travelerConfig || {
      searchTravelerBy:                    'byPhrasesNameSurnameEmail',
      travelersMaxLimit:                   9,
      partnerCountryAsDefaultNationality:  false,
      hotelOffersWithMealsOnly:            false,
      refundableHotelOffersOnly:           false,
      accommodationsWithParkingOnly:       false,
      allowedMealTypes:                    ['BF', 'HB', 'FB', 'AI'],
    },
    creatorEmail: p.creatorEmail,
  });

  const url     = new URL('/v3/hooks/crm/partners', apiUrl);
  const isHttps = url.protocol === 'https:';
  const mod     = isHttps ? https : http;

  logger.info('[testAccountService] Wywołanie HTCD API', {
    url:      url.toString(),
    subdomain: p.subdomain,
    company:   p.companyName,
    creator:   p.creatorEmail,
  });

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const req = mod.request(url.toString(), {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Authorization':  `ApiKey ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, body: {} });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout połączenia z HTCD API (20s)')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (networkErr) {
    logger.error('[testAccountService] Błąd sieciowy HTCD', { error: networkErr.message });
    throw networkErr;
  }

  logger.info('[testAccountService] Odpowiedź HTCD', {
    status: response.status,
    body:   JSON.stringify(response.body).slice(0, 300),
  });

  // 201 — sukces
  if (response.status === 201 && response.body?.success) {
    return {
      success:       true,
      htcdPartnerId: response.body.data?.id        || null,
      priceListUrl:  response.body.data?.priceListUrl || null,
    };
  }

  // 400 P0007 — partner już istnieje
  if (response.status === 400 && response.body?.reason?.errorCode === 'P0007') {
    return {
      success: false,
      error:   'Konto testowe dla tej subdomeny już istnieje w systemie HTCD (P0007).',
    };
  }

  // Inne błędy walidacji (CE0001 itp.)
  if (response.status === 400 && response.body?.reason?.details?.length) {
    const details = response.body.reason.details
      .map(d => `${d.property}: ${d.errorMessage}`)
      .join('; ');
    return {
      success: false,
      error:   `Błąd walidacji HTCD: ${details}`,
    };
  }

  // Ogólny błąd
  const errorCode = response.body?.reason?.errorCode || '';
  return {
    success: false,
    error:   `Błąd HTCD (HTTP ${response.status}${errorCode ? ', ' + errorCode : ''}): ${JSON.stringify(response.body?.reason || response.body).slice(0, 200)}`,
  };
}

// ── STUB (lokalny) — aktywny gdy brak HTCD_API_KEY ───────────────────────────
async function _stub(p) {
  await new Promise(r => setTimeout(r, 600));
  if (p.subdomain && p.subdomain.includes('error')) {
    return { success: false, error: '[STUB] Subdomena jest już zajęta. Wybierz inną subdomenę.' };
  }
  const fakeId = Math.floor(Math.random() * 9000) + 1000;
  return {
    success:       true,
    htcdPartnerId: fakeId,
    priceListUrl:  `https://hotailor.htcd.pl/office/partners/${fakeId}/(partner:price-list)`,
  };
}

module.exports = { createTestAccount };
