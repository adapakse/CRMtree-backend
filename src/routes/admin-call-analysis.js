'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-call-analysis.js
//
// POST   /api/admin/call-analysis/import              — upload CSV
// POST   /api/admin/call-analysis/upsert-from-call   — upsert z rozmowy telefonicznej (JSON)
// GET    /api/admin/call-analysis                     — lista (paginacja + filtry)
// POST   /api/admin/call-analysis/analyze-batch       — uruchom batch analizy
// GET    /api/admin/call-analysis/batch-status        — postęp batcha
// DELETE /api/admin/call-analysis/:nip                — usuń rekord
//
// Dostęp: admin lub sales_manager
// Widoczność danych: group-based (identycznie jak admin-prospects)
// ─────────────────────────────────────────────────────────────────

const router  = require('express').Router();
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const { query } = require('express-validator');
const db      = require('../config/database');
const logger  = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate } = require('../middleware/errorHandler');
const callAnalysisSvc = require('../services/callAnalysisService');

// ── Auth: dedykowane uprawnienie feature 'call_analysis' ────────────────────
router.use(requireAuth);

// ── GET /context/:nip — kontekst AI bez wymogu feature 'call_analysis' ──────
// Dostępny dla każdego zalogowanego usera, który ma przypisane zadanie
// z danym call_analysis_nip (lub jest adminem). Używany w widoku Zadań kalendarza.
router.get('/context/:nip', async (req, res, next) => {
  try {
    const nip = String(req.params.nip).replace(/\D/g, '');
    if (!nip || nip.length !== 10) return res.status(400).json({ error: 'Nieprawidłowy NIP' });

    if (!req.user.is_admin) {
      const { rows: access } = await db.query(`
        SELECT 1 FROM crm_lead_activities a
        JOIN crm_leads l ON l.id = a.lead_id
        WHERE a.call_analysis_nip = $1 AND a.tenant_id = $3
          AND COALESCE(a.created_by, l.assigned_to) = $2::uuid
        UNION ALL
        SELECT 1 FROM crm_partner_activities a
        JOIN crm_partners p ON p.id = a.partner_id
        WHERE a.call_analysis_nip = $1 AND a.tenant_id = $3
          AND COALESCE(a.created_by, p.manager_id) = $2::uuid
        LIMIT 1
      `, [nip, req.user.id, req.tenantId]);
      if (!access.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const { rows } = await db.query(`
      SELECT nip, company_name, city, calls_count, last_call_date, first_call_date,
             salesperson_name, score, ai_summary, ai_signals, ai_objections,
             follow_up_required, follow_up_date, analysis_status
      FROM call_analysis_companies
      WHERE nip = $1 AND tenant_id = $2
    `, [nip, req.tenantId]);

    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /upsert-from-call ────────────────────────────────────────
// Dostępny dla każdego zalogowanego usera (bez wymogu feature 'call_analysis').
// Handlowiec po rozmowie przekazuje transkrypcję — nie musi mieć dostępu do panelu Analizatora.

router.post('/upsert-from-call', async (req, res, next) => {
  try {
    const {
      nip: rawNip, company_name, city, salesperson, note, call_date,
      salesperson_id, salesperson_name,
    } = req.body;
    const nip = String(rawNip || '').replace(/\D/g, '');
    if (nip.length !== 10) return res.status(400).json({ error: 'Nieprawidłowy NIP (wymagane 10 cyfr)' });
    if (!note || !String(note).trim()) return res.status(400).json({ error: 'Brak treści notatki' });

    const { rows: groupRows } = await db.query(
      `SELECT group_id FROM user_group_roles
       WHERE user_id = $1 AND access_level = 'full'
       ORDER BY group_id LIMIT 1`,
      [req.user.id]
    );
    const groupId = groupRows[0]?.group_id || null;

    const callDate     = call_date ? String(call_date).slice(0, 10) : null;
    const callDatetime = call_date ? String(call_date).slice(0, 16) : null;
    const noteText = (callDatetime ? `[CALL_DATE:${callDatetime}]\n` : '') + String(note).trim();

    // Sprawdź czy rekord już istnieje (przed upsert)
    const { rows: existRows } = await db.query(
      `SELECT 1 FROM call_analysis_companies WHERE tenant_id = $1 AND nip = $2`, [req.tenantId, nip]
    );
    const wasExisting = existRows.length > 0;

    // salesperson_id: z requesta lub z zalogowanego usera
    const spId = salesperson_id || req.user.id || null;
    // salesperson_name: z requesta lub display_name zalogowanego usera
    const spName = salesperson_name || salesperson || null;

    await db.query(`
      INSERT INTO call_analysis_companies
        (tenant_id, nip, company_name, city, calls_count, notes_text, group_id, imported_by,
         salesperson, salesperson_id, salesperson_name,
         first_call_date, last_call_date, last_call_end_date, analysis_status)
      VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::uuid, $10, $11::date, $11::date, $11::date, 'pending')
      ON CONFLICT (tenant_id, nip) DO UPDATE SET
        company_name       = COALESCE(call_analysis_companies.company_name, EXCLUDED.company_name),
        city               = COALESCE(call_analysis_companies.city, EXCLUDED.city),
        salesperson        = COALESCE(EXCLUDED.salesperson, call_analysis_companies.salesperson),
        salesperson_id     = COALESCE(EXCLUDED.salesperson_id, call_analysis_companies.salesperson_id),
        salesperson_name   = COALESCE(EXCLUDED.salesperson_name, call_analysis_companies.salesperson_name),
        calls_count        = call_analysis_companies.calls_count + 1,
        last_call_date     = GREATEST(call_analysis_companies.last_call_date, EXCLUDED.last_call_date),
        last_call_end_date = GREATEST(call_analysis_companies.last_call_end_date, EXCLUDED.last_call_end_date),
        first_call_date    = CASE
          WHEN call_analysis_companies.first_call_date IS NULL THEN EXCLUDED.first_call_date
          ELSE LEAST(call_analysis_companies.first_call_date, EXCLUDED.first_call_date) END,
        notes_text         = CASE
          WHEN call_analysis_companies.notes_text IS NULL THEN EXCLUDED.notes_text
          WHEN EXCLUDED.notes_text IS NULL   THEN call_analysis_companies.notes_text
          ELSE call_analysis_companies.notes_text || E'\\n\\n---\\n\\n' || EXCLUDED.notes_text END,
        analysis_status    = CASE
          WHEN call_analysis_companies.analysis_status IN ('hold', 'archived')
            THEN call_analysis_companies.analysis_status
          ELSE 'pending' END,
        updated_at         = NOW()
    `, [req.tenantId, nip, company_name || null, city || null, noteText, groupId, req.user.id,
        spName, spId, spName, callDate]);

    res.json({ nip, was_existing: wasExisting });

    // auto-analiza po każdym nowym upsert (fire & forget)
    callAnalysisSvc.analyzeOne(req.tenantId, nip).catch(err =>
      logger.warn('[CallAnalysis] auto-analyze after upsert failed', { nip, error: err.message })
    );
  } catch (err) { next(err); }
});

router.use(requireFeature('call_analysis'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Group access helpers ───────────────────────────────────────────

// tenant_id jest ZAWSZE wymagany — nawet dla admina (tenant-admina, nie superadmina,
// więc nadal ograniczony do własnego tenanta). Dostęp grupowy to DODATKOWA warstwa
// widoczności wewnątrz jednego tenanta, nie substytut izolacji między tenantami.
function addGroupAccess(where, params, userId, tenantId, isAdmin) {
  params.push(tenantId);
  where.push(`call_analysis_companies.tenant_id = $${params.length}`);
  if (isAdmin) return;
  params.push(userId);
  const p = params.length;
  where.push(`(
    call_analysis_companies.group_id IS NULL
    OR call_analysis_companies.imported_by = $${p}
    OR EXISTS (
      SELECT 1 FROM user_group_roles ugr
      WHERE ugr.user_id = $${p}
        AND ugr.group_id = call_analysis_companies.group_id
        AND ugr.access_level = 'full'
    )
  )`);
}

function singleAccessSQL(params, userId, tenantId, isAdmin) {
  params.push(tenantId);
  const tenantClause = `AND tenant_id = $${params.length}`;
  if (isAdmin) return tenantClause;
  params.push(userId);
  const p = params.length;
  return `${tenantClause} AND (
    group_id IS NULL
    OR imported_by = $${p}
    OR EXISTS (
      SELECT 1 FROM user_group_roles ugr
      WHERE ugr.user_id = $${p}
        AND ugr.group_id = call_analysis_companies.group_id
        AND ugr.access_level = 'full'
    )
  )`;
}

// ── Helpers ────────────────────────────────────────────────────────

function normalizeKey(s) {
  return String(s).toLowerCase().trim()
    .replace(/ą/g, 'a').replace(/ę/g, 'e').replace(/ó/g, 'o')
    .replace(/ś/g, 's').replace(/ł/g, 'l').replace(/ż/g, 'z')
    .replace(/ź/g, 'z').replace(/ć/g, 'c').replace(/ń/g, 'n')
    .replace(/[\s\-_\.]/g, '');
}

function findCol(rowKeys, candidates) {
  for (const c of candidates) {
    const norm = normalizeKey(c);
    const found = rowKeys.find(k => normalizeKey(k) === norm);
    if (found) return found;
  }
  return null;
}

// Parsuje datę z różnych formatów: DD.MM.YYYY HH:MM, YYYY-MM-DD, DD-MM-YYYY
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // DD.MM.YYYY lub DD.MM.YYYY HH:MM(:SS)
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

// ── POST /import ───────────────────────────────────────────────────

router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });

    let csvText;
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer);
      csvText = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    } catch {
      const buf = req.file.buffer;
      const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      csvText = new TextDecoder('windows-1250').decode(hasBom ? buf.subarray(3) : buf);
    }

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

    if (!records.length) return res.status(400).json({ error: 'Plik CSV jest pusty' });

    const rowKeys = Object.keys(records[0]);

    // Detekcja kolumn (zgodna ze specyfikacją formatu)
    const nipKey          = findCol(rowKeys, ['nipleada', 'nip', 'nipfirmy', 'taxid']);
    const nameKey         = findCol(rowKeys, ['nazwaleada', 'nazwafirmy', 'nazwa', 'firma', 'name', 'company']);
    const cityKey         = findCol(rowKeys, ['miastoleada', 'miasto', 'city', 'miejscowosc']);
    const startDateKey    = findCol(rowKeys, ['rozpoczeciepolaczenia', 'datawpisu', 'datarozpoczecia', 'data', 'date']);
    const endDateKey      = findCol(rowKeys, ['zakonczeniepolaczenia', 'zakonczenie', 'koniecpolaczenia', 'endtime', 'enddate']);
    const salespersonKey  = findCol(rowKeys, ['handlowiec', 'salesperson', 'sprzedawca', 'agent', 'uzytkownik', 'uzytkowniksystemu']);
    const note1Key        = findCol(rowKeys, ['notatkipodleadem', 'notatki pod leadem', 'notatki1', 'notatkileada']);
    const note2Key        = findCol(rowKeys, ['notatkipodszansasprzedazy', 'notatki pod szansa sprzedazy', 'notatki pod szansą sprzedazy', 'notatki2', 'notatkiszansy']);

    if (!nipKey) {
      return res.status(400).json({
        error: 'Brak kolumny NIP leada w pliku CSV.',
        detected_columns: rowKeys.map(k => k.toLowerCase()),
      });
    }

    // Pobierz grupę importera
    const { rows: groupRows } = await db.query(
      `SELECT group_id FROM user_group_roles
       WHERE user_id = $1 AND access_level = 'full'
       ORDER BY group_id LIMIT 1`,
      [req.user.id]
    );
    const importerGroupId = groupRows[0]?.group_id || null;

    // Grupuj wszystkie wiersze po NIP
    const byNip = new Map();
    for (const row of records) {
      const nip = String(row[nipKey] || '').replace(/\D/g, '');
      if (!nip || nip.length !== 10) continue;

      if (!byNip.has(nip)) {
        byNip.set(nip, {
          nip,
          company_name: null,
          city: null,
          salesperson: null,
          start_dates: [],
          end_dates: [],
          notes_parts: [],
          row_count: 0,
        });
      }

      const entry = byNip.get(nip);
      entry.row_count++;

      if (!entry.company_name && nameKey)    entry.company_name = (row[nameKey] || '').trim() || null;
      if (!entry.city        && cityKey)     entry.city         = (row[cityKey] || '').trim() || null;
      if (!entry.salesperson && salespersonKey) entry.salesperson = (row[salespersonKey] || '').trim() || null;

      const d    = parseDate(startDateKey ? row[startDateKey] : null);
      if (d) entry.start_dates.push(d);
      const dEnd = parseDate(endDateKey   ? row[endDateKey]   : null);
      if (dEnd) entry.end_dates.push(dEnd);

      const dateRaw = startDateKey ? (row[startDateKey] || '').trim() : '';
      const n1 = note1Key ? (row[note1Key] || '').trim() : '';
      const n2 = note2Key ? (row[note2Key] || '').trim() : '';
      const combined = [n1, n2].filter(Boolean).join('\n');
      if (combined) {
        const dateLine = dateRaw ? `[CALL_DATE:${dateRaw}]\n` : '';
        entry.notes_parts.push(dateLine + combined);
      }
    }

    // Sprawdź które NIPy już istnieją — do śledzenia created vs appended
    const nipsList = Array.from(byNip.keys());
    const { rows: existingRows } = nipsList.length
      ? await db.query(`SELECT nip FROM call_analysis_companies WHERE tenant_id = $1 AND nip = ANY($2::varchar[])`, [req.tenantId, nipsList])
      : { rows: [] };
    const existingNips = new Set(existingRows.map(r => r.nip));

    let upserted = 0, created = 0, appended = 0;
    const errors = [];

    for (const entry of byNip.values()) {
      const notesText    = entry.notes_parts.join('\n\n---\n\n') || null;
      const sortedStart  = [...entry.start_dates].sort();
      const firstCallDate    = sortedStart.length ? sortedStart[0] : null;
      const lastCallDate     = sortedStart.length ? sortedStart[sortedStart.length - 1] : null;
      const lastCallEndDate  = entry.end_dates.length ? [...entry.end_dates].sort().reverse()[0] : null;

      try {
        await db.query(
          `INSERT INTO call_analysis_companies
             (tenant_id, nip, company_name, city, calls_count, last_call_date, notes_text, group_id, imported_by,
              salesperson, first_call_date, last_call_end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (tenant_id, nip) DO UPDATE SET
             company_name       = COALESCE(EXCLUDED.company_name,    call_analysis_companies.company_name),
             city               = COALESCE(EXCLUDED.city,            call_analysis_companies.city),
             salesperson        = COALESCE(call_analysis_companies.salesperson, EXCLUDED.salesperson),
             calls_count        = call_analysis_companies.calls_count + EXCLUDED.calls_count,
             last_call_date     = GREATEST(call_analysis_companies.last_call_date, EXCLUDED.last_call_date),
             first_call_date    = CASE
               WHEN call_analysis_companies.first_call_date IS NULL THEN EXCLUDED.first_call_date
               WHEN EXCLUDED.first_call_date IS NULL THEN call_analysis_companies.first_call_date
               ELSE LEAST(call_analysis_companies.first_call_date, EXCLUDED.first_call_date) END,
             last_call_end_date = GREATEST(call_analysis_companies.last_call_end_date, EXCLUDED.last_call_end_date),
             notes_text         = CASE
               WHEN call_analysis_companies.notes_text IS NULL THEN EXCLUDED.notes_text
               WHEN EXCLUDED.notes_text IS NULL THEN call_analysis_companies.notes_text
               ELSE call_analysis_companies.notes_text || E'\\n\\n---\\n\\n' || EXCLUDED.notes_text
             END,
             group_id           = COALESCE(call_analysis_companies.group_id,    EXCLUDED.group_id),
             imported_by        = COALESCE(call_analysis_companies.imported_by, EXCLUDED.imported_by),
             updated_at         = NOW()`,
          [req.tenantId, entry.nip, entry.company_name, entry.city, entry.row_count, lastCallDate, notesText,
           importerGroupId, req.user.id, entry.salesperson, firstCallDate, lastCallEndDate]
        );
        upserted++;
        if (existingNips.has(entry.nip)) appended++; else created++;
      } catch (e) {
        logger.warn('[CallAnalysis] Upsert error', { nip: entry.nip, error: e.message });
        errors.push(`NIP ${entry.nip}: ${e.message}`);
      }
    }

    res.json({
      created,
      appended,
      upserted,
      nips: byNip.size,
      total_rows: records.length,
      errors: errors.length,
      error_details: errors.slice(0, 5),
      note1_column_detected: note1Key || null,
      note2_column_detected: note2Key || null,
    });
  } catch (err) { next(err); }
});

// ── GET / — lista z filtrami ───────────────────────────────────────

router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('status').optional().isString(),
    query('score_min').optional().isInt({ min: 0, max: 100 }),
    query('score_max').optional().isInt({ min: 0, max: 100 }),
    query('search').optional().isString().isLength({ max: 100 }),
    query('sort').optional().isIn(['imported_at','analyzed_at','score','company_name','calls_count','first_call_date','last_call_end_date','salesperson','follow_up_date']),
    query('dir').optional().isIn(['asc','desc']),
    query('follow_up').optional().isIn(['required','done']),
    query('follow_up_date_from').optional().isDate(),
    query('follow_up_date_to').optional().isDate(),
    query('salesperson').optional().isString().isLength({ max: 100 }),
    query('first_call_from').optional().isDate(),
    query('first_call_to').optional().isDate(),
    query('last_call_from').optional().isDate(),
    query('last_call_to').optional().isDate(),
    query('link').optional().isIn(['lead','partner','prospect','none']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page   = req.query.page  || 1;
      const limit  = req.query.limit || 50;
      const sort   = req.query.sort  || 'imported_at';
      const dir    = req.query.dir   || 'desc';
      const offset = (page - 1) * limit;

      const where  = [];
      const params = [];

      if (req.query.status) {
        params.push(req.query.status);
        where.push(`analysis_status = $${params.length}`);
      }
      if (req.query.score_min !== undefined && req.query.score_min !== '') {
        params.push(parseInt(req.query.score_min));
        where.push(`score >= $${params.length}`);
      }
      if (req.query.score_max !== undefined && req.query.score_max !== '') {
        params.push(parseInt(req.query.score_max));
        where.push(`score <= $${params.length}`);
      }
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        where.push(`(company_name ILIKE $${params.length} OR nip ILIKE $${params.length})`);
      }
      if (req.query.follow_up === 'required') {
        where.push(`follow_up_required = true AND follow_up_done = false`);
      } else if (req.query.follow_up === 'done') {
        where.push(`follow_up_done = true`);
      }
      if (req.query.follow_up_date_from) {
        params.push(req.query.follow_up_date_from);
        where.push(`follow_up_date >= $${params.length}`);
      }
      if (req.query.follow_up_date_to) {
        params.push(req.query.follow_up_date_to);
        where.push(`follow_up_date <= $${params.length}`);
      }
      if (req.query.salesperson) {
        params.push(`%${req.query.salesperson}%`);
        where.push(`salesperson ILIKE $${params.length}`);
      }
      if (req.query.first_call_from) {
        params.push(req.query.first_call_from);
        where.push(`first_call_date >= $${params.length}`);
      }
      if (req.query.first_call_to) {
        params.push(req.query.first_call_to);
        where.push(`first_call_date <= $${params.length}`);
      }
      if (req.query.last_call_from) {
        params.push(req.query.last_call_from);
        where.push(`last_call_end_date >= $${params.length}`);
      }
      if (req.query.last_call_to) {
        params.push(req.query.last_call_to);
        where.push(`last_call_end_date <= $${params.length}`);
      }
      if (req.query.link === 'lead') {
        where.push(`EXISTS(SELECT 1 FROM crm_leads WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)`);
      } else if (req.query.link === 'partner') {
        where.push(`EXISTS(SELECT 1 FROM crm_partners WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)`);
      } else if (req.query.link === 'prospect') {
        where.push(`EXISTS(SELECT 1 FROM prospect_companies WHERE tenant_id = call_analysis_companies.tenant_id AND nip = call_analysis_companies.nip)`);
      } else if (req.query.link === 'none') {
        where.push(`NOT EXISTS(SELECT 1 FROM crm_leads WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)`);
        where.push(`NOT EXISTS(SELECT 1 FROM crm_partners WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL)`);
        where.push(`NOT EXISTS(SELECT 1 FROM prospect_companies WHERE tenant_id = call_analysis_companies.tenant_id AND nip = call_analysis_companies.nip)`);
      }

      addGroupAccess(where, params, req.user.id, req.tenantId, req.user.is_admin);
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT
           nip, company_name, city, calls_count, last_call_date,
           salesperson, first_call_date, last_call_end_date,
           score, ai_summary, ai_signals, ai_objections,
           follow_up_required, follow_up_done, follow_up_date,
           analysis_status, analysis_error, analyzed_at, imported_at, crm_lead_id,
           notes_text,
           EXISTS(SELECT 1 FROM prospect_companies WHERE tenant_id = call_analysis_companies.tenant_id AND nip = call_analysis_companies.nip) AS has_prospect,
           EXISTS(SELECT 1 FROM crm_leads    WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL) AS has_lead,
           (SELECT id FROM crm_leads         WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL LIMIT 1) AS lead_id,
           EXISTS(SELECT 1 FROM crm_partners WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL) AS has_partner,
           (SELECT id::text FROM crm_partners WHERE tenant_id = call_analysis_companies.tenant_id AND REGEXP_REPLACE(nip, '[^0-9]', '', 'g') = REGEXP_REPLACE(call_analysis_companies.nip, '[^0-9]', '', 'g') AND nip IS NOT NULL LIMIT 1) AS partner_nav_id,
           COUNT(*) OVER ()::int AS total_count
         FROM call_analysis_companies
         ${whereSQL}
         ORDER BY ${sort} ${dir} NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const total = rows[0]?.total_count || 0;
      res.json({
        rows: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    } catch (err) { next(err); }
  }
);

// ── POST /analyze-batch ────────────────────────────────────────────

router.post('/analyze-batch', async (req, res, next) => {
  try {
    if (callAnalysisSvc.isBatchRunning()) return res.json({ alreadyRunning: true });
    const { rows: chk } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM call_analysis_companies WHERE tenant_id = $1 AND analysis_status = 'analyzing'`,
      [req.tenantId]
    );
    if (chk[0].cnt > 0) return res.json({ alreadyRunning: true });
    callAnalysisSvc.runBatch(req.tenantId).catch(err =>
      logger.error('[CallAnalysis] Batch failed', { error: err.message })
    );
    res.json({ started: true });
  } catch (err) { next(err); }
});

// ── GET /batch-status ──────────────────────────────────────────────

router.get('/batch-status', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE analysis_status = 'analyzing')::int AS analyzing,
        COUNT(*) FILTER (WHERE analysis_status = 'pending')::int   AS pending
      FROM call_analysis_companies
      WHERE tenant_id = $1
    `, [req.tenantId]);
    const r = rows[0];
    const svcRunning = callAnalysisSvc.isBatchRunning();
    const running    = svcRunning || r.analyzing > 0;

    // Użyj in-memory progress serwisu — śledzi tylko bieżący batch (total startuje od 0)
    // Fallback na total=0 gdy serwis jeszcze nie uruchomił batcha (np. po restarcie)
    const bp = callAnalysisSvc.getBatchProgress();
    res.json({
      total:     bp.total,
      done:      bp.done,
      errors:    bp.errors,
      analyzing: r.analyzing,
      pending:   r.pending,
      running,
    });
  } catch (err) { next(err); }
});

// ── PATCH /:nip/follow-up-done ─────────────────────────────────────

router.patch('/:nip/follow-up-done', async (req, res, next) => {
  try {
    const nip  = String(req.params.nip).replace(/\D/g, '');
    const done = req.body.done === true;
    const params = [nip, done];
    const access = singleAccessSQL(params, req.user.id, req.tenantId, req.user.is_admin);
    const { rows } = await db.query(
      `UPDATE call_analysis_companies SET follow_up_done = $2, updated_at = NOW()
       WHERE nip = $1 ${access} RETURNING nip`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    res.json({ updated: true, nip: rows[0].nip, follow_up_done: done });
  } catch (err) { next(err); }
});

// ── PATCH /:nip/status ─────────────────────────────────────────────

router.patch('/:nip/status', async (req, res, next) => {
  try {
    const nip = String(req.params.nip).replace(/\D/g, '');
    const { status } = req.body;
    const allowed = ['pending', 'hold', 'archived'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Nieprawidłowy status' });

    const params = [nip, status];
    const access = singleAccessSQL(params, req.user.id, req.tenantId, req.user.is_admin);
    const { rows } = await db.query(
      `UPDATE call_analysis_companies SET analysis_status = $2, updated_at = NOW()
       WHERE nip = $1 ${access} RETURNING nip`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    res.json({ updated: true, nip: rows[0].nip, status });
  } catch (err) { next(err); }
});

// ── POST /:nip/re-analyze ───────────────────────────────────────────

router.post('/:nip/re-analyze', async (req, res, next) => {
  try {
    const nip = String(req.params.nip).replace(/\D/g, '');
    const params = [nip];
    const access = singleAccessSQL(params, req.user.id, req.tenantId, req.user.is_admin);
    const { rows } = await db.query(
      `UPDATE call_analysis_companies
       SET analysis_status = 'pending', analysis_error = NULL, updated_at = NOW()
       WHERE nip = $1 AND analysis_status NOT IN ('analyzing') ${access}
       RETURNING nip`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony lub aktualnie analizowany' });

    if (!callAnalysisSvc.isBatchRunning()) {
      callAnalysisSvc.runBatch(req.tenantId).catch(err =>
        logger.error('[CallAnalysis] Re-analyze batch failed', { error: err.message })
      );
    }

    res.json({ queued: true, nip });
  } catch (err) { next(err); }
});

// ── POST /bulk ──────────────────────────────────────────────────────

router.post('/bulk', async (req, res, next) => {
  try {
    const { action, nips, status } = req.body;
    if (!Array.isArray(nips) || !nips.length) return res.status(400).json({ error: 'Brak NIP-ów' });
    const validNips = nips.map(n => String(n).replace(/\D/g, '')).filter(n => n.length === 10);
    if (!validNips.length) return res.status(400).json({ error: 'Brak prawidłowych NIP-ów' });

    const isAdmin = req.user.is_admin;
    const userId  = req.user.id;

    const buildAccess = (params) => {
      params.push(req.tenantId);
      const tenantClause = `AND tenant_id = $${params.length}`;
      if (isAdmin) return tenantClause;
      params.push(userId);
      const p = params.length;
      return `${tenantClause} AND (group_id IS NULL OR imported_by = $${p} OR EXISTS (
        SELECT 1 FROM user_group_roles ugr
        WHERE ugr.user_id = $${p}
          AND ugr.group_id = call_analysis_companies.group_id
          AND ugr.access_level = 'full'
      ))`;
    };

    let result;

    if (action === 'delete') {
      const params = [validNips];
      result = await db.query(
        `DELETE FROM call_analysis_companies WHERE nip = ANY($1::varchar[]) ${buildAccess(params)} RETURNING nip`,
        params
      );
    } else if (action === 'set-status') {
      const allowed = ['pending', 'hold', 'archived'];
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Nieprawidłowy status' });
      const params = [validNips, status];
      result = await db.query(
        `UPDATE call_analysis_companies SET analysis_status = $2, updated_at = NOW()
         WHERE nip = ANY($1::varchar[]) ${buildAccess(params)} RETURNING nip`,
        params
      );
    } else if (action === 're-analyze') {
      const params = [validNips];
      result = await db.query(
        `UPDATE call_analysis_companies
         SET analysis_status = 'pending', analysis_error = NULL, updated_at = NOW()
         WHERE nip = ANY($1::varchar[]) AND analysis_status NOT IN ('analyzing') ${buildAccess(params)} RETURNING nip`,
        params
      );
    } else {
      return res.status(400).json({ error: 'Nieznana akcja' });
    }

    res.json({ affected: result.rows.length, action });
  } catch (err) { next(err); }
});

// ── GET /:nip/inspect ──────────────────────────────────────────────

router.get('/:nip/inspect', async (req, res, next) => {
  try {
    const nip = String(req.params.nip).replace(/\D/g, '');
    if (!nip || nip.length !== 10) return res.status(400).json({ error: 'Nieprawidłowy NIP' });

    const params = [nip];
    const access = singleAccessSQL(params, req.user.id, req.tenantId, req.user.is_admin);
    const { rows } = await db.query(
      `SELECT nip, company_name, notes_text, score, ai_summary, ai_signals, ai_objections,
              follow_up_required, follow_up_date, analysis_status, analyzed_at
       FROM call_analysis_companies WHERE nip = $1 ${access}`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    const row = rows[0];

    const sys   = callAnalysisSvc.getSystemPrompt();
    const notes = row.notes_text || '(brak notatek)';
    const bar   = '='.repeat(70);

    let promptText = `${bar}\nSYSTEM PROMPT (DeepSeek)\n${bar}\n\n${sys}`;
    promptText += `\n\n${bar}\nWIADOMOŚĆ UŻYTKOWNIKA — notatki z rozmów (${row.notes_text ? row.notes_text.length + ' znaków' : 'brak'})\n${bar}\n\n${notes}`;

    if (row.analysis_status === 'done' && row.score !== null) {
      const aiJson = JSON.stringify({
        score: row.score,
        summary: row.ai_summary,
        signals: row.ai_signals || [],
        objections: row.ai_objections || [],
        follow_up_required: row.follow_up_required,
        follow_up_date_hint: `[nie przechowywany — data obliczona: ${row.follow_up_date || 'brak'}]`,
      }, null, 2);
      promptText += `\n\n${bar}\nODPOWIEDŹ AI (rekonstrukcja z bazy)\n${bar}\n\n${aiJson}`;
    }

    res.json({ promptText });
  } catch (err) { next(err); }
});

// ── DELETE /:nip ───────────────────────────────────────────────────

router.delete('/:nip', async (req, res, next) => {
  try {
    const nip = String(req.params.nip).replace(/\D/g, '');
    if (!nip) return res.status(400).json({ error: 'Nieprawidłowy NIP' });

    const delParams = [nip];
    const accessClause = singleAccessSQL(delParams, req.user.id, req.tenantId, req.user.is_admin);
    const { rows } = await db.query(
      `DELETE FROM call_analysis_companies WHERE nip = $1 ${accessClause} RETURNING nip`,
      delParams
    );
    if (!rows.length) return res.status(404).json({ error: 'Rekord nie znaleziony' });
    res.json({ deleted: true, nip: rows[0].nip });
  } catch (err) { next(err); }
});

module.exports = router;
