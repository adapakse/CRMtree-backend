'use strict';
/**
 * Competitor Discovery Service — "Znajdź konkurencję"
 *
 * Port mechanizmu z worktrips-doc (tam zbudowany i sprawdzony w realnym użyciu).
 * Pipeline jest ten sam, zmiany dotyczą WYŁĄCZNIE rzeczy, których aplikacja
 * jednotenantowa nie musiała rozwiązywać:
 *
 *   1. Claude — identyfikuje branżę + listuje do MAX_RESULTS polskich konkurentów
 *   2. GUS REGON BIR1.1 — waliduje NIP, pobiera oficjalną nazwę + kody PKD
 *   3. SQL — sprawdza obecność firm W ZASOBACH TEGO TENANTA (prospekty/leady/partnerzy)
 *
 * RÓŻNICE WZGLĘDEM WORKTRIPS (świadome, nie przeoczenia):
 *   - `checkTenantPresence` filtruje po tenant_id. W worktrips-doc te same trzy
 *     EXISTS nie mają filtra, bo tam istnieje jeden klient. Przeniesione
 *     dosłownie ujawniłyby tenantowi A, że firma X jest leadem/partnerem
 *     tenanta B — to dane handlowe innego klienta, nie metadana.
 *   - klucz cache zawiera tenant_id (ten sam seed u dwóch tenantów daje inne
 *     flagi obecności, więc wynik nie jest współdzielony).
 *
 * Limity (MAX_RESULTS, PAGE_SIZE, TTL cache, max_uses web_search, timeouty) są
 * takie same jak w worktrips-doc. Poza globalnym rate limitem HTTP (200 żądań
 * / 15 min, app.js) NIE ma limitu użyć — świadoma decyzja: zasady mają być te
 * same co w worktrips-doc.
 *
 * Cache in-memory (klucz: tenantId_userId_seedNip, TTL: CACHE_TTL_MS). Na wielu
 * replikach Container Appa cache jest per-replika — to akceptowalne, bo służy
 * wyłącznie paginacji wyników (offset 5/10) w ciągu jednej sesji użytkownika,
 * a nie spójności danych.
 */

const axios    = require('axios');
const gusRegon = require('./gusRegonService');
const db       = require('../config/database');
const logger   = require('../utils/logger');

const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages';
const DISCOVERY_MODEL  = 'claude-sonnet-4-6';
const NIP_SEARCH_MODEL = 'claude-haiku-4-5-20251001';
const PAGE_SIZE        = 5;
const MAX_RESULTS      = 15;
const CACHE_TTL_MS     = 15 * 60 * 1000; // 15 min


// ── In-memory cache ────────────────────────────────────────────────
const cache = new Map(); // key → { companies: [], expiresAt: number }

function cacheKey(tenantId, userId, seedNip) {
  return `${tenantId}_${userId}_${String(seedNip).replace(/\D/g, '')}`;
}

function getCache(tenantId, userId, seedNip) {
  const key = cacheKey(tenantId, userId, seedNip);
  const e = cache.get(key);
  if (!e || Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.companies;
}

function setCache(tenantId, userId, seedNip, companies) {
  cache.set(cacheKey(tenantId, userId, seedNip), { companies, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Helper: pętla Claude z web_search ─────────────────────────────

async function claudeWebSearch(prompt, maxTokens, maxUses, timeoutMs, model = DISCOVERY_MODEL) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const headers = {
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type':      'application/json',
  };

  const messages = [{ role: 'user', content: prompt }];
  let finalText  = null;

  for (let turn = 0; turn < 8; turn++) {
    let data;
    try {
      ({ data } = await axios.post(ANTHROPIC_API, {
        model,
        max_tokens: maxTokens,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, allowed_callers: ['direct'] }],
        messages,
      }, { headers, timeout: timeoutMs }));
    } catch (axiosErr) {
      logger.error('[Discovery] Anthropic API error', {
        status: axiosErr.response?.status, message: axiosErr.message,
      });
      throw axiosErr;
    }

    const { stop_reason, content } = data;
    finalText = content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || finalText;
    if (stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content });
  }

  return finalText || '';
}

// ── Claude: generuj listę konkurentów ─────────────────────────────

async function askClaude(companyName, seedNip, seedPkd) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const pkdLine = seedPkd ? `Kody PKD (z rejestru GUS): ${seedPkd}\n` : '';

  const prompt =
    `Jesteś ekspertem ds. analizy rynku B2B w Polsce.\n\n` +
    `FIRMA WEJŚCIOWA: "${companyName}" (NIP: ${seedNip})\n` +
    pkdLine +
    `\n` +
    `Na podstawie swojej wiedzy o tej firmie i polskim rynku znajdź do ${MAX_RESULTS} firm, które:\n` +
    `✓ Oferują DOKŁADNIE te same lub bardzo zbliżone produkty/usługi co "${companyName}"\n` +
    `✓ Działają w Polsce (polska rejestracja lub oddział z polskim NIP)\n` +
    `✓ Mają PODOBNĄ skalę działalności — mogą realnie walczyć o tego samego klienta\n` +
    `  (pomiń lokalne firmy-miniatury; pomiń korporacje z zupełnie innej ligi cenowej)\n\n` +
    `WYKLUCZ:\n` +
    `✗ Samą firmę "${companyName}" i jej spółki zależne / powiązane\n` +
    `✗ Firmy w likwidacji lub upadłości\n` +
    `✗ Dystrybutorów / pośredników (o ile firma wejściowa jest producentem)\n\n` +
    `SORTUJ: od najbardziej do najmniej zbliżonej skali i profilu.\n\n` +
    `Dla każdej firmy podaj:\n` +
    `- company_name: pełna nazwa rejestrowa (jak w KRS/CEIDG)\n` +
    `- nip: NIP jeśli znasz (10 cyfr bez kresek), null jeśli nie wiesz na pewno\n` +
    `- website_url: główna strona WWW jeśli znasz (pełny URL z https://), null tylko jeśli naprawdę nie wiesz\n\n` +
    `Odpowiedz WYŁĄCZNIE jako JSON (bez markdown, bez komentarzy):\n` +
    `{"industry":"krótki opis profilu firmy (2-5 słów)","companies":[{"company_name":"Przykład Sp. z o.o.","nip":"1234567890","website_url":"https://www.przyklad.pl"}]}`;

  const { data } = await axios.post(ANTHROPIC_API, {
    model:      DISCOVERY_MODEL,
    max_tokens: 2000,
    messages:   [{ role: 'user', content: prompt }],
  }, {
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    timeout: 30_000,
  });

  const text = data.content?.find(b => b.type === 'text')?.text || '';

  try {
    const cleaned = text.replace(/^```json\s*|```\s*$/g, '').trim();
    const json = JSON.parse(cleaned);
    return {
      industry:  json.industry || null,
      companies: Array.isArray(json.companies) ? json.companies.slice(0, MAX_RESULTS) : [],
    };
  } catch (err) {
    logger.warn('[Discovery] Claude JSON parse error', { preview: text.slice(0, 300), error: err.message });
    return { industry: null, companies: [] };
  }
}

// ── Web search: znajdź NIP firmy ──────────────────────────────────

async function findNipViaSearch(companyName) {
  try {
    const prompt =
      `Znajdź dane rejestrowe polskiej firmy "${companyName}".\n` +
      `Wyszukaj w internecie: "${companyName} NIP kontakt" — NIP i strona WWW zwykle pojawiają się na stronie kontaktowej firmy.\n\n` +
      `Odpowiedz jako JSON (bez markdown):\n` +
      `{"nip":"1234567890","website_url":"https://..."}\n\n` +
      `Jeśli nie znalazłeś pewnego NIP, wpisz null. Jeśli nie znalazłeś strony WWW, wpisz null.`;

    const text = await claudeWebSearch(prompt, 300, 3, 30_000, NIP_SEARCH_MODEL);

    try {
      const cleaned = text.replace(/^```json\s*|```\s*$/g, '').trim();
      const json    = JSON.parse(cleaned);
      const nip     = String(json.nip || '').replace(/\D/g, '');
      if (nip.length === 10) return { nip, website_url: json.website_url || null };
    } catch {
      const match = text.match(/\b(\d{10})\b/);
      if (match) return { nip: match[1], website_url: null };
    }
  } catch (err) {
    logger.debug('[Discovery] NIP web search failed', { companyName, error: err.message });
  }
  return null;
}

// ── GUS: walidacja NIP + PKD ───────────────────────────────────────

async function validateWithGus(raw) {
  let nipClean = String(raw.nip || '').replace(/\D/g, '');

  if (nipClean.length === 10) {
    try {
      const gus = await gusRegon.getCompanyData(nipClean);
      if (gus) {
        return {
          company_name: gus.officialName || raw.company_name,
          nip:          nipClean,
          website_url:  raw.website_url || null,
          pkd_main:     gus.pkdMain || null,
          pkd_codes:    gus.pkdCodes?.map(c => c.kod) || [],
          regon:        gus.regon || null,
          nip_verified: true,
        };
      }
    } catch (err) {
      logger.debug('[Discovery] GUS by NIP failed', { nip: nipClean, error: err.message });
    }
  }

  let searchedWebsite = null;
  if (raw.company_name) {
    const found = await findNipViaSearch(raw.company_name);
    searchedWebsite = found?.website_url || null;
    if (found?.nip) {
      nipClean = found.nip;
      const resolvedWebsite = found.website_url || raw.website_url || null;
      try {
        const gus = await gusRegon.getCompanyData(nipClean);
        if (gus) {
          return {
            company_name: gus.officialName || raw.company_name,
            nip:          nipClean,
            website_url:  resolvedWebsite,
            pkd_main:     gus.pkdMain || null,
            pkd_codes:    gus.pkdCodes?.map(c => c.kod) || [],
            regon:        gus.regon || null,
            nip_verified: true,
          };
        }
      } catch (err) {
        logger.debug('[Discovery] GUS by searched NIP failed', { nip: nipClean, error: err.message });
      }
    }
  }

  const resolvedWebsite = searchedWebsite || raw.website_url || null;
  if (raw.company_name) {
    try {
      const gusByName = await gusRegon.searchByName(raw.company_name);
      if (gusByName?.length > 0) {
        const match   = gusByName[0];
        const gusData = await gusRegon.getCompanyData(match.nip).catch(() => null);
        return {
          company_name: gusData?.officialName || match.name || raw.company_name,
          nip:          match.nip,
          website_url:  resolvedWebsite,
          pkd_main:     gusData?.pkdMain || null,
          pkd_codes:    gusData?.pkdCodes?.map(c => c.kod) || [],
          regon:        match.regon || null,
          nip_verified: true,
        };
      }
    } catch (err) {
      logger.debug('[Discovery] GUS search by name failed', { name: raw.company_name, error: err.message });
    }
  }

  return {
    company_name: raw.company_name,
    nip:          nipClean.length === 10 ? nipClean : null,
    website_url:  resolvedWebsite,
    pkd_main:     null,
    pkd_codes:    [],
    regon:        null,
    nip_verified: nipClean.length === 10,
  };
}

// ── SQL: obecność firm W ZASOBACH TEGO TENANTA ────────────────────
// KAŻDY z trzech EXISTS filtruje po tenant_id. Bez tego filtra tenant A
// dowiedziałby się, że firma jest leadem albo partnerem tenanta B.

async function checkTenantPresence(tenantId, nips) {
  const cleanNips = nips
    .filter(n => n && String(n).replace(/\D/g, '').length === 10)
    .map(n => String(n).replace(/\D/g, ''));

  if (!cleanNips.length || !tenantId) return new Map();

  const { rows } = await db.query(`
    SELECT
      n.nip,
      EXISTS(SELECT 1 FROM prospect_companies pc
             WHERE pc.tenant_id = $2
               AND REGEXP_REPLACE(pc.nip, '[^0-9]','','g') = n.nip) AS in_prospects,
      EXISTS(SELECT 1 FROM crm_leads cl
             WHERE cl.tenant_id = $2
               AND REGEXP_REPLACE(cl.nip, '[^0-9]','','g') = n.nip) AS in_leads,
      EXISTS(SELECT 1 FROM crm_partners cp
             WHERE cp.tenant_id = $2
               AND REGEXP_REPLACE(cp.nip, '[^0-9]','','g') = n.nip) AS in_partners
    FROM UNNEST($1::text[]) AS n(nip)
  `, [cleanNips, tenantId]);

  return new Map(rows.map(r => [r.nip, {
    inProspects: r.in_prospects,
    inLeads:     r.in_leads,
    inPartners:  r.in_partners,
  }]));
}

// ── Public API ─────────────────────────────────────────────────────

async function resolveSeedPkd(seedNip) {
  const seedGus = await gusRegon.getCompanyData(seedNip).catch(() => null);
  return seedGus?.pkdCodes?.slice(0, 3).map(c => `${c.kod} (${c.nazwa})`).join(', ') || null;
}

/**
 * Streaming discovery — wyniki trafiają do callbacków na bieżąco.
 */
async function discoverStream(tenantId, userId, companyName, seedNip, { onIndustry, onCompany }) {
  const seedPkd = await resolveSeedPkd(seedNip);
  const { industry, companies: rawList } = await askClaude(companyName, seedNip, seedPkd);
  logger.info('[Discovery] Claude returned', { tenantId, count: rawList.length, industry });
  onIndustry(industry);

  await Promise.all(rawList.map(async (raw) => {
    const company = await validateWithGus(raw);

    let inProspects = false, inLeads = false, inPartners = false;
    if (company.nip) {
      const p = (await checkTenantPresence(tenantId, [company.nip])).get(company.nip);
      inProspects = p?.inProspects || false;
      inLeads     = p?.inLeads     || false;
      inPartners  = p?.inPartners  || false;
    }

    onCompany({ ...company, industry, in_prospects: inProspects, in_leads: inLeads, in_partners: inPartners });
  }));
}

/**
 * offset 0 → pełny pipeline AI + GUS, cache, zwraca pierwsze 5
 * offset 5/10 → z cache (bez kosztu)
 */
async function discover(tenantId, userId, companyName, seedNip, offset = 0) {
  let allCompanies = getCache(tenantId, userId, seedNip);
  let industry     = null;

  if (!allCompanies) {
    const seedPkd = await resolveSeedPkd(seedNip);
    const { industry: aiIndustry, companies: rawList } = await askClaude(companyName, seedNip, seedPkd);
    industry = aiIndustry;
    logger.info('[Discovery] Claude returned', { tenantId, count: rawList.length, industry: aiIndustry });

    const enriched  = await Promise.all(rawList.map(validateWithGus));
    const validNips = enriched.map(c => c.nip).filter(Boolean);
    const presence  = await checkTenantPresence(tenantId, validNips);

    allCompanies = enriched.map(c => ({
      ...c,
      in_prospects: c.nip ? (presence.get(c.nip)?.inProspects || false) : false,
      in_leads:     c.nip ? (presence.get(c.nip)?.inLeads     || false) : false,
      in_partners:  c.nip ? (presence.get(c.nip)?.inPartners  || false) : false,
      industry:     aiIndustry,
    }));

    setCache(tenantId, userId, seedNip, allCompanies);
  } else {
    industry = allCompanies[0]?.industry || null;
  }

  return {
    companies: allCompanies.slice(offset, offset + PAGE_SIZE),
    hasMore:   offset + PAGE_SIZE < allCompanies.length,
    total:     allCompanies.length,
    industry,
  };
}

module.exports = {
  discover, discoverStream,
  // Eksport na potrzeby testów jednostkowych (bez sieci i bez AI).
  checkTenantPresence, cacheKey, getCache, setCache,
  PAGE_SIZE, MAX_RESULTS,
};
