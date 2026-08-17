'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-prospects.js  — wymaga feature flag 'prospects' + grupy "Prospekty"
//
// POST   /api/admin/prospects/import         — upload CSV
// GET    /api/admin/prospects                — lista z filtrami + paginacja
// GET    /api/admin/prospects/export         — CSV export (wg aktywnych filtrów)
// POST   /api/admin/prospects/enrich-batch   — uruchom batch enrichmentu
// GET    /api/admin/prospects/enrich-status  — postęp batcha
// POST   /api/admin/prospects/:id/to-lead    — utwórz lead CRM z prospektu
// ─────────────────────────────────────────────────────────────────

const router  = require('express').Router();
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const { query, param, body } = require('express-validator');
const db      = require('../config/database');
const logger  = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate } = require('../middleware/errorHandler');
const enrichSvc = require('../services/prospectEnrichmentService');
const { normalizeWebsiteUrl, normalizeLinkedinUrl } = require('../utils/urlUtils');

// ── "Prospekty" group check (mirrors the group_profiles/user_group_roles
// pattern already used for SEO editorial access — no new permission system) ──
async function requireProspectsAccess(req, res, next) {
  try {
    if (req.user.is_admin) return next();
    const { rows } = await db.query(
      `SELECT 1 FROM user_group_roles ugr
         JOIN group_profiles gp ON gp.id = ugr.group_id
        WHERE ugr.user_id = $1 AND gp.tenant_id = $2 AND gp.name = 'Prospekty'`,
      [req.user.id, req.user.tenant_id],
    );
    if (!rows.length) return res.status(403).json({ error: 'Brak uprawnień do modułu Prospekty.' });
    next();
  } catch (err) { next(err); }
}

router.use(requireAuth);
router.use(requireFeature('prospects'));
router.use(requireProspectsAccess);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ── Helper: filtr dostępu grupowego (dołącz do where + params) ────
// Dla zapytań na całej tabeli (lista, export).
// Admini widzą wszystko. Pozostali: group_id IS NULL (legacy) LUB
// są importerem LUB mają access_level='full' w grupie rekordu.

function addGroupAccess(where, params, userId, isAdmin) {
  if (isAdmin) return;
  params.push(userId);
  const p = params.length;
  where.push(`(
    prospect_companies.group_id IS NULL
    OR prospect_companies.imported_by = $${p}
    OR EXISTS (
      SELECT 1 FROM user_group_roles ugr
      WHERE ugr.user_id = $${p}
        AND ugr.group_id = prospect_companies.group_id
        AND ugr.access_level = 'full'
    )
  )`);
}

// Dla zapytań na pojedynczym rekordzie — zwraca fragment AND (...).
// Mutuje params (push userId jeśli nie admin).

function singleRecordAccessSQL(params, userId, isAdmin, tenantId) {
  params.push(tenantId);
  let sql = `AND tenant_id = $${params.length}`;
  if (isAdmin) return sql;
  params.push(userId);
  const p = params.length;
  return sql + ` AND (
    group_id IS NULL
    OR imported_by = $${p}
    OR EXISTS (
      SELECT 1 FROM user_group_roles ugr
      WHERE ugr.user_id = $${p}
        AND ugr.group_id = prospect_companies.group_id
        AND ugr.access_level = 'full'
    )
  )`;
}

// ── Helper: budowanie WHERE z filtrów ──────────────────────────────
// tenant_id jest zawsze pierwszym parametrem ($1) — pozwala bezpiecznie
// odwoływać się do niego w podzapytaniach (has_lead, lead_id, itd.).

function buildFilters(q, tenantId) {
  const where = ['prospect_companies.tenant_id = $1'];
  const params = [tenantId];

  if (q.status) {
    params.push(q.status);
    where.push(`enrichment_status = $${params.length}`);
  } else if (q.show_archived !== 'true') {
    where.push(`enrichment_status != 'archived'`);
  }
  if (q.imported_from) {
    params.push(q.imported_from);
    where.push(`imported_at >= $${params.length}`);
  }
  if (q.imported_to) {
    params.push(q.imported_to);
    where.push(`imported_at <= $${params.length}::date + interval '1 day'`);
  }
  if (q.enriched_from) {
    params.push(q.enriched_from);
    where.push(`enriched_at >= $${params.length}`);
  }
  if (q.enriched_to) {
    params.push(q.enriched_to);
    where.push(`enriched_at <= $${params.length}::date + interval '1 day'`);
  }
  if (q.score_min !== undefined && q.score_min !== '') {
    params.push(parseInt(q.score_min));
    where.push(`travel_potential_score >= $${params.length}`);
  }
  if (q.score_max !== undefined && q.score_max !== '') {
    params.push(parseInt(q.score_max));
    where.push(`travel_potential_score <= $${params.length}`);
  }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(company_name ILIKE $${params.length} OR nip ILIKE $${params.length} OR source_database ILIKE $${params.length})`);
  }

  return { where, params };
}

// ── Helper: wykrywanie klucza kolumny po znormalizowanej nazwie ────

function findColumnKey(rowKeys, candidates) {
  for (const c of candidates) {
    const normCandidate = c.toLowerCase().replace(/[\s\-_\.]/g, '');
    const found = rowKeys.find(k => k.toLowerCase().trim().replace(/[\s\-_\.]/g, '') === normCandidate);
    if (found) return found;
  }
  return null;
}

// Bezpieczna konwersja na integer — zwraca null jeśli niemożliwe
function safeInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).replace(/[\s,]/g, '').replace(/[^0-9\-]/g, '');
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Bezpieczna konwersja roku (1800–2099)
function safeYear(val) {
  const n = safeInt(val);
  return (n != null && n >= 1800 && n <= 2099) ? n : null;
}

// ── POST /import ───────────────────────────────────────────────────

router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });

    // Autodetekcja encodingu: UTF-8 (z BOM lub bez) → Windows-1250 (polskie CSV z Excela)
    // TextDecoder z fatal:true rzuca wyjątek przy niepoprawnych bajtach UTF-8,
    // co jest pewniejszym testem niż szukanie znaku zastępczego '?'.
    let csvText;
    let detectedEncoding = 'utf-8';
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer);
      csvText = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw; // usuń BOM jeśli jest
    } catch {
      // Nie jest poprawnym UTF-8 — próba Windows-1250 (polskie CSV z Excela)
      detectedEncoding = 'windows-1250';
      const buf = req.file.buffer;
      // Usuń UTF-8 BOM (EF BB BF) jeśli plik ma BOM ale treść w CP1250
      const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      csvText = new TextDecoder('windows-1250').decode(hasBom ? buf.subarray(3) : buf);
    }

    // Autodetekcja separatora
    const firstLine = csvText.split('\n')[0] || '';
    const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        delimiter,
      });
    } catch (e) {
      return res.status(400).json({ error: `Błąd parsowania CSV: ${e.message}` });
    }

    if (!records.length) {
      return res.status(400).json({ error: 'Plik CSV jest pusty lub nie zawiera wierszy danych.' });
    }

    // Pobierz pierwszą grupę importera z dostępem 'full'
    const { rows: groupRows } = await db.query(
      `SELECT group_id FROM user_group_roles
       WHERE user_id = $1 AND access_level = 'full'
       ORDER BY group_id LIMIT 1`,
      [req.user.id]
    );
    const importerGroupId = groupRows[0]?.group_id || null;

    // Wykryj klucze kolumn (case-insensitive, ignoruje -, _, spacje)
    const rowKeys    = Object.keys(records[0]);
    const sampleKeys = rowKeys.map(k => k.toLowerCase().trim());

    const nipKey      = findColumnKey(rowKeys, ['nip', 'nipfirmy', 'taxid']);
    // Szukaj BAZA po nazwie; fallback: pierwsza kolumna z pustym nagłówkiem (CSV bez nazwy kolumny)
    const bazaKey     = findColumnKey(rowKeys, ['baza', 'database', 'bazadanych', 'sourcedatabase', 'source', 'zrodlo'])
                        ?? (rowKeys[0] === '' ? '' : null);
    const regonKey    = findColumnKey(rowKeys, ['regon', 'regonfirmy']);
    const nameKey     = findColumnKey(rowKeys, ['companyname', 'nazwa', 'name', 'firma', 'nazwafirmy', 'nazwajednostki']);
    const krsKey   = findColumnKey(rowKeys, ['krs', 'krsnumber', 'numerkrs', 'krsnumer', 'nrkrs', 'krsno']);
    const wwwKey   = findColumnKey(rowKeys, ['www', 'website', 'strona', 'stranawww', 'url', 'webpage', 'stronainternetowa', 'adreswww']);

    const employmentKey  = findColumnKey(rowKeys, ['zatrudnienie', 'employment', 'pracownicy', 'employees', 'liczbapracownikow', 'liczbazatrudnionych']);
    const revenueKey     = findColumnKey(rowKeys, ['obrot', 'obroty', 'przychod', 'revenue', 'turnover', 'przychodyroczne']);
    const yearKey        = findColumnKey(rowKeys, ['rok', 'year', 'rokzalozenia', 'founded', 'rokpowstania', 'rokzaloz']);
    const sizeKey        = findColumnKey(rowKeys, ['wielkosc', 'size', 'rozmiar', 'kategoriarozmiaru', 'wielkoscfirmy']);
    const industryKey    = findColumnKey(rowKeys, ['branza', 'industry', 'sektor', 'sector', 'branżafirmy']);
    const profileKey     = findColumnKey(rowKeys, ['profil', 'profile', 'profildzialalnosci', 'opis', 'description']);
    const dmNameKey      = findColumnKey(rowKeys, ['osobadecyzyjna', 'decisionmaker', 'kontakt', 'contactperson', 'osobakontaktowa']);
    const dmTitleKey     = findColumnKey(rowKeys, ['stanowisko', 'position', 'title', 'rola', 'jobposition']);
    const dmDeptKey      = findColumnKey(rowKeys, ['komorka', 'department', 'dzial', 'jednostka', 'oddzial']);
    const phoneKey       = findColumnKey(rowKeys, ['telefon', 'phone', 'tel', 'mobile', 'numertelefonu', 'komorkowy']);
    const emailKey       = findColumnKey(rowKeys, ['email', 'mail', 'adresemail', 'emailkontaktowy']);
    const cityKey        = findColumnKey(rowKeys, ['miasto', 'city', 'miejscowosc']);
    const voivodeshipKey = findColumnKey(rowKeys, ['wojewodztwo', 'voivodeship', 'region', 'woj']);
    const pkdIdKey       = findColumnKey(rowKeys, ['pkdid', 'pkd', 'pkdcode', 'kodpkd']);
    const pkdDescKey     = findColumnKey(rowKeys, ['pkdopis', 'pkddescription', 'opisdzialalnosci', 'pkdopis']);
    const facebookKey    = findColumnKey(rowKeys, ['facebook', 'fb', 'facebookurl', 'fburl', 'facebooklink', 'facebook_url']);
    const linkedinKey    = findColumnKey(rowKeys, ['linkedin', 'li', 'lnkd', 'linkedinurl', 'linkedinfirma', 'linkedincompany', 'linkedin_url', 'linkedinpage']);
    const linkedinInKey  = findColumnKey(rowKeys, ['linkedin_in', 'linkedinkontakt', 'linkedinpersonal', 'linkedin_kontakt', 'linkedin_os']);
    const fbPersonalKey  = findColumnKey(rowKeys, ['facebook_kontakt', 'facebook_in', 'facebookpersonal', 'facebook_os', 'fbkontakt']);

    // Zestaw już obsłużonych kluczy — przy skanowaniu URL pomijamy te kolumny
    const handledKeys = new Set([
      bazaKey, nipKey, regonKey, nameKey, krsKey, wwwKey, facebookKey,
      linkedinKey, linkedinInKey, fbPersonalKey,
      employmentKey, revenueKey, yearKey, sizeKey, industryKey, profileKey,
      dmNameKey, dmTitleKey, dmDeptKey, phoneKey, emailKey, cityKey,
      voivodeshipKey, pkdIdKey, pkdDescKey,
    ].filter(Boolean));

    if (!nipKey) {
      return res.status(400).json({
        error: `Brak kolumny "nip" w pliku CSV. Znalezione kolumny: ${sampleKeys.join(', ')}`,
      });
    }
    if (!bazaKey) {
      return res.status(400).json({
        error: `Brak wymaganej kolumny "BAZA" w pliku CSV. Znalezione kolumny: ${sampleKeys.join(', ')}`,
      });
    }
    // Walidacja: każdy wiersz musi mieć wartość BAZA
    const missingBaza = records
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => !String(row[bazaKey] || '').trim())
      .map(({ i }) => i + 2); // +2 bo nagłówek = wiersz 1, dane od wiersza 2
    if (missingBaza.length > 0) {
      return res.status(400).json({
        error: `Kolumna BAZA musi mieć wartość w każdym wierszu. Brakuje wartości w wierszach: ${missingBaza.slice(0, 10).join(', ')}${missingBaza.length > 10 ? ` i ${missingBaza.length - 10} kolejnych` : ''}.`,
      });
    }

    const getStr = (row, key) => key ? (row[key] || '').trim() || null : null;

    let added = 0, skipped = 0;
    const errorDetails = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rawNip = String(row[nipKey] || '').replace(/\D/g, '');

      if (!rawNip) { errorDetails.push(`Wiersz ${i + 2}: pusta wartość NIP`); continue; }
      if (rawNip.length !== 10) {
        errorDetails.push(`Wiersz ${i + 2}: NIP "${rawNip}" ma ${rawNip.length} cyfr (wymagane 10)`);
        continue;
      }

      const sourceDatabase = String(row[bazaKey] || '').trim() || null;
      const regon          = regonKey ? String(row[regonKey] || '').replace(/\D/g, '') || null : null;
      const name           = getStr(row, nameKey);
      const krsNumber = krsKey
        ? String(row[krsKey] || '').replace(/\D/g, '').padStart(10, '0').replace(/^0+$/, '') || null
        : null;

      // Strona WWW — pełna normalizacja (literówki w protokole, brak prefiksu, spacje)
      const websiteUrl = normalizeWebsiteUrl(getStr(row, wwwKey));

      // Facebook URL — normalizuj protokół
      let facebookUrl = facebookKey ? getStr(row, facebookKey) : null;
      if (facebookUrl && !/^https?:\/\//i.test(facebookUrl)) {
        facebookUrl = `https://${facebookUrl}`;
      }

      // LinkedIn URL (firmowy) — z dedykowanej kolumny lub z nazwy kolumny
      let linkedinUrl = linkedinKey ? getStr(row, linkedinKey) : null;
      if (linkedinUrl && !/^https?:\/\//i.test(linkedinUrl)) linkedinUrl = `https://${linkedinUrl}`;

      // Osobiste linki kontaktu
      let dmLinkedin = linkedinInKey ? getStr(row, linkedinInKey) : null;
      if (dmLinkedin && !/^https?:\/\//i.test(dmLinkedin)) dmLinkedin = `https://${dmLinkedin}`;
      let dmFacebook = fbPersonalKey ? getStr(row, fbPersonalKey) : null;
      if (dmFacebook && !/^https?:\/\//i.test(dmFacebook)) dmFacebook = `https://${dmFacebook}`;

      // Skanuj pozostałe kolumny — szukaj URL-i LinkedIn nieobsłużonych przez nazwy kolumn
      for (const colKey of Object.keys(row)) {
        if (handledKeys.has(colKey)) continue;
        const v = String(row[colKey] || '').trim();
        if (!v || v.length < 10) continue;
        const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
        try {
          const parsed = new URL(withProto);
          const host = parsed.hostname.replace(/^www\./, '');
          if (host === 'linkedin.com' || host === 'lnkd.in') {
            const path = parsed.pathname;
            if ((path.startsWith('/company/') || path.startsWith('/school/') || path.startsWith('/showcase/')) && !linkedinUrl) {
              linkedinUrl = withProto;
            } else if (path.startsWith('/in/') && !dmLinkedin) {
              dmLinkedin = withProto;
            } else if (!linkedinUrl) {
              linkedinUrl = withProto; // fallback — nieznana ścieżka LI traktuj jako firmowy
            }
          } else if ((host === 'facebook.com' || host === 'fb.com') && !facebookUrl) {
            facebookUrl = withProto;
          }
        } catch { /* pomiń nieprawidłowe URL */ }
      }

      const employmentCount = safeInt(getStr(row, employmentKey));
      // Revenue: może być z separatorami tysięcy (spacje lub kropki)
      const revenueRaw = getStr(row, revenueKey);
      const annualRevenue = revenueRaw
        ? safeInt(revenueRaw.replace(/[\s\.]/g, '').replace(',', '.'))
        : null;
      const foundingYear   = safeYear(getStr(row, yearKey));
      const companySize    = getStr(row, sizeKey);
      const industry       = getStr(row, industryKey);
      const companyProfile = getStr(row, profileKey);
      const dmName         = getStr(row, dmNameKey);
      const dmTitle        = getStr(row, dmTitleKey);
      const dmDept         = getStr(row, dmDeptKey);
      const dmPhone        = getStr(row, phoneKey);
      const dmEmail        = getStr(row, emailKey);
      const city           = getStr(row, cityKey);
      const voivodeship    = getStr(row, voivodeshipKey);
      const pkdId          = getStr(row, pkdIdKey);
      const pkdDescription = getStr(row, pkdDescKey);

      try {
        const result = await db.query(
          `INSERT INTO prospect_companies (
             tenant_id, nip, regon, company_name, krs_number, website_url,
             employment_count, annual_revenue, founding_year, company_size,
             industry, company_profile,
             decision_maker_name, decision_maker_title, decision_maker_dept,
             decision_maker_phone, decision_maker_email,
             city, voivodeship, pkd_id, pkd_description,
             source_database, facebook_url,
             linkedin_url, decision_maker_linkedin, decision_maker_facebook,
             group_id, imported_by
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
           ON CONFLICT (tenant_id, nip) DO UPDATE SET
             regon                = COALESCE(EXCLUDED.regon,         prospect_companies.regon),
             company_name         = COALESCE(EXCLUDED.company_name,  prospect_companies.company_name),
             krs_number           = COALESCE(EXCLUDED.krs_number,    prospect_companies.krs_number),
             website_url          = CASE
               WHEN EXCLUDED.website_url IS NOT NULL THEN EXCLUDED.website_url
               ELSE prospect_companies.website_url
             END,
             employment_count     = COALESCE(EXCLUDED.employment_count,    prospect_companies.employment_count),
             annual_revenue       = COALESCE(EXCLUDED.annual_revenue,      prospect_companies.annual_revenue),
             founding_year        = COALESCE(EXCLUDED.founding_year,       prospect_companies.founding_year),
             company_size         = COALESCE(EXCLUDED.company_size,        prospect_companies.company_size),
             industry             = COALESCE(EXCLUDED.industry,            prospect_companies.industry),
             company_profile      = COALESCE(EXCLUDED.company_profile,     prospect_companies.company_profile),
             decision_maker_name  = COALESCE(EXCLUDED.decision_maker_name,  prospect_companies.decision_maker_name),
             decision_maker_title = COALESCE(EXCLUDED.decision_maker_title, prospect_companies.decision_maker_title),
             decision_maker_dept  = COALESCE(EXCLUDED.decision_maker_dept,  prospect_companies.decision_maker_dept),
             decision_maker_phone = COALESCE(EXCLUDED.decision_maker_phone, prospect_companies.decision_maker_phone),
             decision_maker_email = COALESCE(EXCLUDED.decision_maker_email, prospect_companies.decision_maker_email),
             city                 = COALESCE(EXCLUDED.city,            prospect_companies.city),
             voivodeship          = COALESCE(EXCLUDED.voivodeship,     prospect_companies.voivodeship),
             pkd_id               = COALESCE(EXCLUDED.pkd_id,          prospect_companies.pkd_id),
             pkd_description      = COALESCE(EXCLUDED.pkd_description, prospect_companies.pkd_description),
             source_database           = EXCLUDED.source_database,
             facebook_url              = COALESCE(EXCLUDED.facebook_url,              prospect_companies.facebook_url),
             linkedin_url              = COALESCE(EXCLUDED.linkedin_url,              prospect_companies.linkedin_url),
             decision_maker_linkedin   = COALESCE(EXCLUDED.decision_maker_linkedin,   prospect_companies.decision_maker_linkedin),
             decision_maker_facebook   = COALESCE(EXCLUDED.decision_maker_facebook,   prospect_companies.decision_maker_facebook),
             group_id             = COALESCE(prospect_companies.group_id,    EXCLUDED.group_id),
             imported_by          = COALESCE(prospect_companies.imported_by, EXCLUDED.imported_by),
             enrichment_status    = CASE
               WHEN EXCLUDED.website_url IS NOT NULL
                AND (prospect_companies.website_url IS NULL
                     OR prospect_companies.enrichment_status = 'no_website')
               THEN 'pending'
               WHEN EXCLUDED.krs_number IS NOT NULL
                AND prospect_companies.krs_number IS NULL
               THEN 'pending'
               ELSE prospect_companies.enrichment_status
             END
           RETURNING (xmax = 0) AS inserted`,
          [
            req.user.tenant_id, rawNip, regon, name, krsNumber, websiteUrl,
            employmentCount, annualRevenue, foundingYear, companySize,
            industry, companyProfile,
            dmName, dmTitle, dmDept, dmPhone, dmEmail,
            city, voivodeship, pkdId, pkdDescription,
            sourceDatabase, facebookUrl,
            linkedinUrl, dmLinkedin, dmFacebook,
            importerGroupId, req.user.id,
          ]
        );
        if (result.rows[0]?.inserted) added++;
        else skipped++;
      } catch (e) {
        logger.warn('[Prospects] Import row error', { nip: rawNip, error: e.message });
        errorDetails.push(`Wiersz ${i + 2} (NIP ${rawNip}): ${e.message}`);
      }
    }

    res.json({
      added,
      skipped,
      errors: errorDetails.length,
      total: records.length,
      detected_encoding: detectedEncoding,
      detected_columns: sampleKeys,
      krs_column_detected: krsKey || null,
      www_column_detected: wwwKey || null,
      error_details: errorDetails.slice(0, 10),
      linkedin_column_detected: linkedinKey || null,
      facebook_column_detected: facebookKey || null,
    });
  } catch (err) { next(err); }
});

// ── GET / — lista z filtrami ────────────────────────────────────────

router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('status').optional().isString(),
    query('imported_from').optional().isDate(),
    query('imported_to').optional().isDate(),
    query('enriched_from').optional().isDate(),
    query('enriched_to').optional().isDate(),
    query('score_min').optional().isInt({ min: 0, max: 100 }),
    query('score_max').optional().isInt({ min: 0, max: 100 }),
    query('search').optional().isString().isLength({ max: 100 }),
    query('sort').optional().isIn(['imported_at', 'enriched_at', 'travel_potential_score', 'company_name']),
    query('dir').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page  = req.query.page  || 1;
      const limit = req.query.limit || 50;
      const sort  = req.query.sort  || 'imported_at';
      const dir   = req.query.dir   || 'desc';
      const offset = (page - 1) * limit;

      const { where, params } = buildFilters(req.query, req.user.tenant_id);
      addGroupAccess(where, params, req.user.id, req.user.is_admin);
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // Grand total: non-archived, group-access-aware, no user filters
      const gtWhere = [`tenant_id = $1`, `enrichment_status != 'archived'`];
      const gtParams = [req.user.tenant_id];
      addGroupAccess(gtWhere, gtParams, req.user.id, req.user.is_admin);

      params.push(limit, offset);
      const [dataResult, grandTotalResult] = await Promise.all([
        db.query(
          `SELECT
             id, nip, regon, company_name, imported_at,
             krs_number, legal_form, branches_count, branches_scope,
             website_url, employment_range,
             employment_count, annual_revenue, founding_year, company_size,
             industry, company_profile,
             decision_maker_name, decision_maker_title, decision_maker_dept,
             decision_maker_phone, decision_maker_email,
             city, voivodeship, pkd_id, pkd_description,
             source_database, facebook_url,
             linkedin_url, linkedin_status, decision_maker_linkedin, decision_maker_facebook,
             fb_about, fb_category, fb_fan_count,
             website_status,
             travel_potential_score, travel_signals, travel_scope,
             field_teams_likely, ai_summary, key_contacts,
             enriched_at, enrichment_status, enrichment_error, enrichment_log,
             note, note_author, note_updated_at,
             crm_lead_id,
             (prospect_companies.nip IS NOT NULL AND EXISTS(SELECT 1 FROM crm_leads WHERE tenant_id = $1 AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(prospect_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)) AS has_lead,
             (SELECT id FROM crm_leads WHERE tenant_id = $1 AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(prospect_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL LIMIT 1) AS lead_id,
             (prospect_companies.nip IS NOT NULL AND EXISTS(SELECT 1 FROM crm_partners WHERE tenant_id = $1 AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(prospect_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)) AS has_partner,
             (SELECT id::text FROM crm_partners WHERE tenant_id = $1 AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(prospect_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL LIMIT 1) AS partner_nav_id,
             COUNT(*) OVER ()::int AS total_count
           FROM prospect_companies
           ${whereSQL}
           ORDER BY ${sort} ${dir} NULLS LAST
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        ),
        db.query(
          `SELECT COUNT(*) FROM prospect_companies WHERE ${gtWhere.join(' AND ')}`,
          gtParams
        ),
      ]);

      const total = dataResult.rows[0]?.total_count || 0;
      const grand_total = parseInt(grandTotalResult.rows[0]?.count || '0');
      res.json({
        rows: dataResult.rows.map(r => { const { total_count, ...rest } = r; return rest; }),
        total,
        grand_total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    } catch (err) { next(err); }
  }
);

// ── GET /export — CSV export ────────────────────────────────────────

router.get('/export', async (req, res, next) => {
  try {
    const { where, params } = buildFilters(req.query, req.user.tenant_id);
    addGroupAccess(where, params, req.user.id, req.user.is_admin);
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT
         nip, regon, company_name, source_database, imported_at,
         krs_number, legal_form, registered_address, registration_date,
         branches_count, branches_scope, website_url,
         employment_range,
         travel_potential_score, travel_scope, field_teams_likely, ai_summary,
         enriched_at, enrichment_status, crm_lead_id
       FROM prospect_companies
       ${whereSQL}
       ORDER BY travel_potential_score DESC NULLS LAST, company_name ASC`,
      params
    );

    const headers = [
      'NIP', 'REGON', 'Nazwa firmy', 'Baza źródłowa', 'Data importu',
      'KRS', 'Forma prawna', 'Adres', 'Data rejestracji',
      'Liczba oddziałów', 'Zasięg oddziałów', 'Strona WWW', 'Facebook URL',
      'FB Kategoria', 'FB Obserwujący', 'FB Opis',
      'Zatrudnienie',
      'Score (0-100)', 'Zasięg podróży', 'Zespoły terenowe', 'Podsumowanie AI',
      'Data enrichmentu', 'Status', 'Lead CRM',
    ];

    const esc = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const csvLines = [
      headers.join(','),
      ...rows.map(r => [
        esc(r.nip), esc(r.regon), esc(r.company_name), esc(r.source_database),
        esc(r.imported_at?.toISOString().split('T')[0]),
        esc(r.krs_number), esc(r.legal_form), esc(r.registered_address),
        esc(r.registration_date?.toISOString?.()?.split('T')[0]),
        esc(r.branches_count), esc(r.branches_scope), esc(r.website_url),
        esc(r.facebook_url), esc(r.fb_category), esc(r.fb_fan_count), esc(r.fb_about),
        esc(r.employment_range),
        esc(r.travel_potential_score), esc(r.travel_scope),
        esc(r.field_teams_likely === true ? 'tak' : r.field_teams_likely === false ? 'nie' : ''),
        esc(r.ai_summary),
        esc(r.enriched_at?.toISOString().split('T')[0]),
        esc(r.enrichment_status), esc(r.crm_lead_id || ''),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prospekty_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('﻿' + csvLines.join('\n')); // BOM dla Excel
  } catch (err) { next(err); }
});

// ── PATCH /:id/status — zmiana statusu (hold / archived / pending) ─

// ── PATCH /:id/note ────────────────────────────────────────────────

router.patch('/:id/note', async (req, res, next) => {
  try {
    const id   = parseInt(req.params.id);
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : null;
    const u    = req.user;
    const author = u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;

    // params order: $1=id, $2=note, $3=author — then singleRecordAccessSQL appends userId as $4 (non-admin)
    const noteParams = [id, note || null, note ? author : null];
    const accessClause = singleRecordAccessSQL(noteParams, u.id, u.is_admin, u.tenant_id);
    const { rows } = await db.query(
      `UPDATE prospect_companies
       SET note = $2, note_author = $3, note_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1 ${accessClause}
       RETURNING id, note, note_author, note_updated_at`,
      noteParams
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id/status',
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('status').isIn(['hold', 'archived', 'pending']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const statusParams = [req.params.id, req.body.status];
      const accessClause = singleRecordAccessSQL(statusParams, req.user.id, req.user.is_admin, req.user.tenant_id);
      const { rows } = await db.query(
        `UPDATE prospect_companies
         SET enrichment_status = $2, updated_at = NOW()
         WHERE id = $1 ${accessClause}
         RETURNING id, enrichment_status`,
        statusParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Prospekt nie znaleziony' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── POST /:id/re-process — wyczyść i kolejkuj ponowny enrichment ───

router.post('/:id/re-process',
  [param('id').isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const manualUrl      = normalizeWebsiteUrl(
        typeof req.body?.website_url === 'string' ? req.body.website_url : null
      );
      const manualLinkedin = normalizeLinkedinUrl(
        typeof req.body?.linkedin_url === 'string' ? req.body.linkedin_url : null
      );
      // NIP: tylko cyfry, dokładnie 10 znaków
      const rawNip = typeof req.body?.nip === 'string' ? req.body.nip.replace(/\D/g, '') : '';
      const manualNip = rawNip.length === 10 ? rawNip : null;

      const processLinkedin = req.body?.process_linkedin === true;

      // Odczytaj aktualny stan przed UPDATE — do wyznaczenia co faktycznie się zmieniło
      const { rows: currRows } = await db.query(
        `SELECT website_url, website_status, linkedin_url, linkedin_status FROM prospect_companies WHERE id = $1`,
        [req.params.id]
      );
      const curr = currRows[0] || {};

      const websiteChanged  = !!manualUrl      && manualUrl      !== curr.website_url;
      const linkedinChanged = !!manualLinkedin && manualLinkedin !== curr.linkedin_url;

      // Pomiń re-scraping gdy URL się nie zmienił i poprzednie przetwarzanie zakończyło się sukcesem
      const skipWebsite  = !websiteChanged  && curr.website_status  === 'ok';
      const skipLinkedin = !linkedinChanged && curr.linkedin_status === 'ok';
      const effectiveProcessLinkedin = processLinkedin && !skipLinkedin;

      const reprocessParams = [req.params.id, manualUrl, manualNip, manualLinkedin];
      const accessClause = singleRecordAccessSQL(reprocessParams, req.user.id, req.user.is_admin, req.user.tenant_id);
      const { rows } = await db.query(
        `UPDATE prospect_companies SET
           enrichment_status      = 'pending',
           enrichment_error       = NULL,
           enriched_at            = NULL,
           travel_potential_score = NULL,
           travel_signals         = NULL,
           travel_scope           = NULL,
           field_teams_likely     = NULL,
           ai_summary             = NULL,
           key_contacts           = NULL,
           legal_form             = NULL,
           registered_address     = NULL,
           registration_date      = NULL,
           branches_count         = NULL,
           branches_scope         = NULL,
           krs_website            = NULL,
           website_url            = COALESCE($2, website_url),
           nip                    = COALESCE($3::VARCHAR, nip),
           linkedin_url           = COALESCE($4, linkedin_url),
           updated_at             = NOW()
         WHERE id = $1 ${accessClause}
         RETURNING id`,
        reprocessParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Prospekt nie znaleziony' });

      // Uruchom enrichment jednej firmy w tle (ustawia batchProgress dla pollingu frontendu)
      enrichSvc.reEnrichOne(req.user.tenant_id, req.params.id, { processLinkedin: effectiveProcessLinkedin, skipWebsite });

      res.json({ queued: true, id: req.params.id });
    } catch (err) {
      if (err.code === '23505' && err.constraint?.includes('nip')) {
        return res.status(409).json({ error: 'Inny rekord ma już podany NIP. Sprawdź duplikaty.' });
      }
      next(err);
    }
  }
);

// ── DELETE /:id ────────────────────────────────────────────────────

router.delete('/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const delParams = [req.params.id];
      const accessClause = singleRecordAccessSQL(delParams, req.user.id, req.user.is_admin, req.user.tenant_id);
      const { rows } = await db.query(
        `DELETE FROM prospect_companies WHERE id = $1 ${accessClause} RETURNING id, crm_lead_id`,
        delParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Prospekt nie znaleziony' });
      res.json({ deleted: true, id: rows[0].id, had_lead: !!rows[0].crm_lead_id });
    } catch (err) { next(err); }
  }
);

// ── POST /enrich-batch ─────────────────────────────────────────────

router.post('/enrich-batch', async (req, res, next) => {
  try {
    const progress = enrichSvc.getBatchProgress(req.user.tenant_id);
    if (progress.running) {
      return res.json({ alreadyRunning: true, progress });
    }
    // Uruchom batch w tle
    enrichSvc.runBatch(req.user.tenant_id).catch(err =>
      logger.error('[Prospects] Batch failed', { error: err.message })
    );
    res.json({ started: true });
  } catch (err) { next(err); }
});

// ── GET /enrich-status ─────────────────────────────────────────────

router.get('/enrich-status', (req, res) => {
  res.json(enrichSvc.getBatchProgress(req.user.tenant_id));
});

// ── GET /:id/prompt — rekonstrukcja promptu wysłanego do Claude ────

router.get('/:id/prompt',
  [param('id').isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const promptParams = [req.params.id];
      const accessClause = singleRecordAccessSQL(promptParams, req.user.id, req.user.is_admin, req.user.tenant_id);
      const { rows } = await db.query(
        `SELECT id, nip, company_name, krs_number, legal_form,
                registered_address, registration_date,
                branches_count, branches_scope, website_url,
                enrichment_log
         FROM prospect_companies WHERE id = $1 ${accessClause}`,
        promptParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Prospekt nie znaleziony' });
      const p = rows[0];
      const log = p.enrichment_log || {};

      // Rekonstrukcja krsData ze stored fields
      const krsData = log.krs?.found ? {
        companyName:       p.company_name,
        legalForm:         p.legal_form,
        registeredAddress: p.registered_address,
        registrationDate:  p.registration_date,
        branchesCount:     log.krs.branches_count,
        branchesScope:     log.krs.branches_scope,
      } : null;

      // Placeholder zamiast treści strony (nie przechowujemy)
      const websiteStats = log.website?.url
        ? `[TREŚĆ ZE STRONY WWW — nie przechowywana w bazie]\n` +
          `URL: ${log.website.url}\n` +
          `Metoda odkrycia: ${log.website.method || '?'}\n` +
          `Stron scraped: ${log.website.pages_count ?? '?'}\n` +
          `Znaków tekstu: ${log.website.chars_extracted ?? '?'}\n\n` +
          `Powyższe dane zastępują tutaj pełną treść scraped — w rzeczywistym prompcie\n` +
          `znajdowała się concatenacja tekstów ze wszystkich podstron.`
        : null;

      const promptText = enrichSvc.buildPromptText(p, krsData, websiteStats);
      res.json({ prompt: promptText });
    } catch (err) { next(err); }
  }
);

// ── POST /:id/to-lead ──────────────────────────────────────────────

router.post('/:id/to-lead',
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('assigned_to').optional({ nullable: true }).isUUID(),
    body('tag').optional({ nullable: true }).isString().trim().isLength({ max: 50 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Opcjonalna korekta NIP przed utworzeniem leada
      const rawNip = typeof req.body?.nip === 'string' ? req.body.nip.replace(/\D/g, '') : '';
      const confirmedNip = rawNip.length === 10 ? rawNip : null;

      const toLeadParams = [req.params.id];
      const accessClause = singleRecordAccessSQL(toLeadParams, req.user.id, req.user.is_admin, req.user.tenant_id);
      const { rows } = await db.query(
        `SELECT * FROM prospect_companies WHERE id = $1 ${accessClause}`,
        toLeadParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Prospekt nie znaleziony' });
      let p = rows[0];
      const assignedTo = req.body.assigned_to || req.user.id;

      // Jeśli user podał inny NIP — zaktualizuj prospekt przed stworzeniem leada
      if (confirmedNip && confirmedNip !== p.nip) {
        try {
          await db.query(
            `UPDATE prospect_companies SET nip = $2, updated_at = NOW() WHERE id = $1`,
            [p.id, confirmedNip]
          );
          p = { ...p, nip: confirmedNip };
        } catch (nipErr) {
          if (nipErr.code === '23505' && nipErr.constraint?.includes('nip')) {
            return res.status(409).json({ error: 'Inny prospekt ma już ten NIP. Sprawdź duplikaty.', nip_conflict: true });
          }
          throw nipErr;
        }
      }

      if (p.crm_lead_id) {
        // Spróbuj zsynchronizować kontakty jeśli wcześniejsza konwersja ich nie zapisała
        let contacts409 = p.key_contacts;
        if (typeof contacts409 === 'string') {
          try { contacts409 = JSON.parse(contacts409); } catch { contacts409 = []; }
        }
        if (Array.isArray(contacts409) && contacts409.length) {
          const { rows: existingC } = await db.query(
            'SELECT COUNT(*) AS cnt FROM crm_lead_contacts WHERE lead_id = $1',
            [p.crm_lead_id]
          );
          if (parseInt(existingC[0].cnt) === 0) {
            for (const c of contacts409) {
              if (!c.name && !c.email) continue;
              try {
                await db.query(
                  `INSERT INTO crm_lead_contacts (lead_id, contact_name, contact_title, email, phone)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [p.crm_lead_id, c.name || null, c.title || null, c.email || null, c.phone || null]
                );
              } catch (e) {
                logger.warn('[Prospects] Could not sync contact to existing lead', { error: e.message });
              }
            }
          }
        }
        return res.status(409).json({
          error: 'Lead już istnieje',
          crm_lead_id: p.crm_lead_id,
        });
      }

      // Sprawdź duplikat NIP tylko w crm_leads (partnerzy i DWH to inne byty)
      if (p.nip) {
        const { rows: nipCheck } = await db.query(
          `SELECT 1 FROM crm_leads
           WHERE tenant_id = $2 AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = $1 AND nip IS NOT NULL
           LIMIT 1`,
          [p.nip, req.user.tenant_id]
        );
        if (nipCheck.length) {
          return res.status(409).json({ error: 'Lead z tym NIP już istnieje w CRM.' });
        }
      }

      // Sprawdź duplikat nazwy firmy — miękkie ostrzeżenie, user może potwierdzić (force)
      const force = req.body.force === true || req.body.force === 'true';
      if (!force) {
        const companyName = p.company_name || p.nip;
        const { rows: companyCheck } = await db.query(
          `SELECT 'lead' AS src, id::text, company FROM crm_leads WHERE tenant_id = $2 AND company ILIKE $1
           UNION ALL
           SELECT 'partner' AS src, id::text, company FROM crm_partners WHERE tenant_id = $2 AND company ILIKE $1
           LIMIT 1`,
          [`%${companyName}%`, req.user.tenant_id]
        );
        if (companyCheck.length) {
          const found = companyCheck[0];
          return res.status(409).json({
            error: 'duplicate_company',
            existing: { src: found.src, id: found.id, company: found.company },
          });
        }
      }

      // Zbuduj tagi z sygnałów
      const signals = Array.isArray(p.travel_signals) ? p.travel_signals : [];
      const userTag = typeof req.body.tag === 'string' ? req.body.tag.trim() : null;
      const tags = [
        p.source_database ? p.source_database : null,
        p.travel_scope ? `zasięg:${p.travel_scope}` : null,
        p.field_teams_likely ? 'zespoły-terenowe' : null,
        p.travel_potential_score >= 70 ? 'high-travel-potential' : null,
        'prospekt',
        userTag || null,
      ].filter(Boolean);

      // crm_leads w CRMtree nie ma kolumn facebook_url/linkedin_url (inaczej niż
      // w worktrips-doc) — dopisujemy je do notatek, żeby nie zgubić danych z enrichmentu.
      const notes = [
        p.ai_summary || '',
        signals.length ? `Sygnały: ${signals.join('; ')}` : '',
        p.travel_potential_score != null ? `Travel Potential Score: ${p.travel_potential_score}/100` : '',
        p.facebook_url ? `Facebook: ${p.facebook_url}` : '',
        p.linkedin_url ? `LinkedIn: ${p.linkedin_url}` : '',
      ].filter(Boolean).join('\n\n');

      const nipForLead = p.nip ? `PL${p.nip}` : null;

      const { rows: leadRows } = await db.query(
        `INSERT INTO crm_leads
           (tenant_id, company, nip, notes, tags, stage, probability, source, website, assigned_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'new', $6, 'Prospekt', $7, $8, NOW(), NOW())
         RETURNING id`,
        [
          req.user.tenant_id,
          p.company_name || p.nip,
          nipForLead,
          notes || null,
          tags,
          p.travel_potential_score != null ? p.travel_potential_score : null,
          p.website_url || null,
          assignedTo,
        ]
      );
      const leadId = leadRows[0].id;

      await db.query(
        `UPDATE prospect_companies
         SET crm_lead_id = $2, enrichment_status = 'lead'
         WHERE id = $1`,
        [p.id, leadId]
      );

      // Zbierz kontakty: (1) osoba decyzyjna z importu, (2) kontakty znalezione przez AI
      const allContacts = [];

      // Kontakt z pliku importu
      if (p.decision_maker_name || p.decision_maker_email) {
        const titleParts = [p.decision_maker_title, p.decision_maker_dept].filter(Boolean);
        allContacts.push({
          name:  p.decision_maker_name  || null,
          title: titleParts.join(' / ')  || null,
          email: p.decision_maker_email  || null,
          phone: p.decision_maker_phone  || null,
        });
      }

      // Kontakty z AI (key_contacts) — pomiń duplikaty po emailu lub nazwisku
      let aiContacts = p.key_contacts;
      if (typeof aiContacts === 'string') {
        try { aiContacts = JSON.parse(aiContacts); } catch { aiContacts = []; }
      }
      if (Array.isArray(aiContacts)) {
        for (const c of aiContacts) {
          if (!c.name && !c.email) continue;
          const dupEmail = c.email && allContacts.some(x => x.email && x.email.toLowerCase() === c.email.toLowerCase());
          const dupName  = c.name  && allContacts.some(x => x.name  && x.name.toLowerCase()  === c.name.toLowerCase());
          if (!dupEmail && !dupName) allContacts.push(c);
        }
      }

      for (const c of allContacts) {
        try {
          await db.query(
            `INSERT INTO crm_lead_contacts (lead_id, contact_name, contact_title, email, phone)
             VALUES ($1, $2, $3, $4, $5)`,
            [leadId, c.name || null, c.title || null, c.email || null, c.phone || null]
          );
        } catch (e) {
          logger.warn('[Prospects] Could not insert lead contact', { error: e.message });
        }
      }

      res.json({ crm_lead_id: leadId });
    } catch (err) { next(err); }
  }
);

module.exports = router;
