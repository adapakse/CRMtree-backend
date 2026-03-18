'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-import.js
//
// POST /api/crm/import/leads     — upload CSV → import leadów
// POST /api/crm/import/partners  — upload CSV → import partnerów
// GET  /api/crm/import/logs      — historia importów
// GET  /api/crm/import/template/:type — pobierz szablon CSV
// ─────────────────────────────────────────────────────────────────

const router  = require('express').Router();
const multer  = require('multer');
const { parse } = require('csv-parse');
const { Readable } = require('stream');
const db    = require('../config/database');
const audit = require('../services/auditService');
const { requireAuth }                  = require('../middleware/auth');
const { injectAuditContext }           = require('../middleware/errorHandler');
const { crmAuth, requireCrmManager }   = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth);

// Multer: pamięć RAM, tylko CSV, max 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!file.originalname.match(/\.(csv|txt)$/i)) {
      return cb(new Error('Dozwolone tylko pliki .csv'), false);
    }
    cb(null, true);
  },
});

// ── Helpers normalizacji ──────────────────────────────────────────
function detectDelimiter(text) {
  const firstLine = text.split('\n')[0] || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas     = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCsvBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const records = [];
    let csvText = buffer.toString('utf8');
    if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

    const delimiter = detectDelimiter(csvText);
    console.log('[CRM Import] Wykryty separator:', JSON.stringify(delimiter));

    Readable.from(csvText)
      .pipe(parse({ columns: true, skip_empty_lines: true, trim: true, bom: true, delimiter }))
      .on('data', row => {
        const normalized = {};
        for (const [k, v] of Object.entries(row)) {
          normalized[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
        }
        records.push(normalized);
      })
      .on('error', reject)
      .on('end',   () => resolve(records));
  });
}

const nStr   = v => (v || '').trim() || null;
const nFloat = v => { const n = parseFloat((v || '').replace(',', '.')); return isNaN(n) ? null : n; };
const nInt   = v => { const n = parseInt(v);  return isNaN(n) ? null : n; };
const nDate  = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const nBool  = v => ['1','true','yes','tak','t'].includes((v || '').toLowerCase().trim());
const nTags  = v => v ? v.split(/[,;|]/).map(t => t.trim()).filter(Boolean) : [];

const LEAD_STAGES = ['new','qualification','presentation','offer','negotiation','closed_won','closed_lost'];
const PARTNER_STATUSES = ['onboarding','active','inactive','churned'];

// ── POST /api/crm/import/leads ────────────────────────────────────
router.post('/leads', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(422).json({ error: 'Plik CSV jest wymagany (pole: file)' });

  let records;
  try { records = await parseCsvBuffer(req.file.buffer); }
  catch (e) { return res.status(422).json({ error: `Błąd parsowania CSV: ${e.message}` }); }

  // Limit wierszy z app_settings
  let maxRows = 5000;
  try {
    const { rows } = await db.query("SELECT value FROM app_settings WHERE key='crm_csv_max_rows'");
    if (rows.length) maxRows = parseInt(rows[0].value) || 5000;
  } catch (_) {}

  if (records.length > maxRows) {
    return res.status(422).json({ error: `Plik zawiera ${records.length} wierszy. Limit: ${maxRows}` });
  }

  // Utwórz log importu
  const { rows: logRows } = await db.query(`
    INSERT INTO crm_import_logs (import_type, filename, rows_total, imported_by)
    VALUES ('leads', $1, $2, $3) RETURNING id
  `, [req.file.originalname, records.length, req.user.id]).catch(next);

  const importId = logRows[0].id;
  let imported = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < records.length; i++) {
    const row    = records[i];
    const rowNum = i + 2;

    if (i === 0) console.log('[CRM Import leads] Kolumny CSV:', Object.keys(row));
    const company = nStr(row.company || row.firma || row['company name'] || row.nazwa);
    if (!company) {
      errors.push({ row: rowNum, field: 'company', error: 'Pole company jest wymagane' });
      skipped++;
      continue;
    }

    const stage = nStr(row.stage || row.etap) || 'new';
    if (!LEAD_STAGES.includes(stage)) {
      errors.push({ row: rowNum, field: 'stage', error: `Nieznany etap: ${stage}` });
      skipped++;
      continue;
    }

    try {
      await db.query(`
        INSERT INTO crm_leads
          (company, contact_name, contact_title, email, phone, source, stage,
           value_pln, probability, close_date, industry,
           assigned_to, tags, notes, hot, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        company,
        nStr(row.contact_name || row.kontakt),
        nStr(row.contact_title || row.stanowisko),
        nStr(row.email),
        nStr(row.phone || row.telefon),
        nStr(row.source || row.zrodlo) || 'inne',
        stage,
        nFloat(row.value_pln || row.wartosc),
        nInt(row.probability   || row.prawdopodobienstwo),
        nDate(row.close_date   || row.data_zamkniecia),
        nStr(row.industry      || row.branza),
        req.user.id,
        nTags(row.tags || row.tagi),
        nStr(row.notes || row.notatki),
        nBool(row.hot),
        req.user.id,
      ]);
      imported++;
    } catch (e) {
      errors.push({ row: rowNum, company, error: e.message });
      skipped++;
    }
  }

  // Aktualizuj log
  await db.query(`
    UPDATE crm_import_logs
    SET rows_imported=$1, rows_skipped=$2, rows_error=$3,
        error_details=$4, status='done', finished_at=now()
    WHERE id=$5
  `, [imported, skipped - errors.length, errors.length,
      errors.length ? JSON.stringify(errors.slice(0, 100)) : null, importId])
    .catch(() => {});

  await audit.log({
    user:      req.user,
    action:    'crm_import_leads',
    afterState: { filename: req.file.originalname, imported, errors: errors.length },
    metadata:  { import_id: importId },
    ipAddress: req.auditContext?.ipAddress,
  });

  res.json({
    import_id:    importId,
    filename:     req.file.originalname,
    rows_total:   records.length,
    imported,
    skipped:      skipped - errors.length,
    errors_count: errors.length,
    errors:       errors.slice(0, 20),
  });
});

// ── POST /api/crm/import/partners ─────────────────────────────────
router.post('/partners', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(422).json({ error: 'Plik CSV jest wymagany (pole: file)' });

  let records;
  try { records = await parseCsvBuffer(req.file.buffer); }
  catch (e) { return res.status(422).json({ error: `Błąd parsowania CSV: ${e.message}` }); }

  // Załaduj mapę grup (name → id) z bazy
  const { rows: groups } = await db.query('SELECT id, name FROM crm_partner_groups').catch(() => ({ rows: [] }));
  const groupMap = {};
  groups.forEach(g => { groupMap[g.name.toLowerCase()] = g.id; });

  const { rows: logRows } = await db.query(`
    INSERT INTO crm_import_logs (import_type, filename, rows_total, imported_by)
    VALUES ('partners', $1, $2, $3) RETURNING id
  `, [req.file.originalname, records.length, req.user.id]).catch(next);

  const importId = logRows[0].id;
  let imported = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < records.length; i++) {
    const row    = records[i];
    const rowNum = i + 2;

    if (i === 0) console.log('[CRM Import partners] Kolumny CSV:', Object.keys(row));
    const company = nStr(row.company || row.firma || row['company name'] || row.nazwa);
    if (!company) {
      errors.push({ row: rowNum, field: 'company', error: 'Pole company jest wymagane' });
      skipped++;
      continue;
    }

    const statusRaw = nStr(row.status) || 'onboarding';
    const status    = PARTNER_STATUSES.includes(statusRaw) ? statusRaw : 'onboarding';

    const groupName = nStr(row.group_name || row.grupa);
    const groupId   = groupName ? (groupMap[groupName.toLowerCase()] || null) : null;

    try {
      await db.query(`
        INSERT INTO crm_partners
          (company, partner_number, nip, address, contact_name, contact_title, email, phone,
           industry, group_id, manager_id, contract_signed, contract_expires,
           contract_value, license_count, status, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT DO NOTHING
      `, [
        company,
        nStr(row.partner_number || row.numer_partnera || row.partner_nr),
        nStr(row.nip),
        nStr(row.address || row.adres),
        nStr(row.contact_name || row.kontakt),
        nStr(row.contact_title || row.stanowisko),
        nStr(row.email),
        nStr(row.phone || row.telefon),
        nStr(row.industry || row.branza),
        groupId,
        req.user.id,
        nDate(row.contract_signed  || row.data_podpisania),
        nDate(row.contract_expires || row.data_wygasniecia),
        nFloat(row.contract_value  || row.wartosc_umowy),
        nInt(row.license_count     || row.liczba_licencji),
        status,
        nStr(row.notes || row.notatki),
        req.user.id,
      ]);
      imported++;
    } catch (e) {
      errors.push({ row: rowNum, company, error: e.message });
      skipped++;
    }
  }

  await db.query(`
    UPDATE crm_import_logs
    SET rows_imported=$1, rows_skipped=$2, rows_error=$3,
        error_details=$4, status='done', finished_at=now()
    WHERE id=$5
  `, [imported, skipped - errors.length, errors.length,
      errors.length ? JSON.stringify(errors.slice(0, 100)) : null, importId])
    .catch(() => {});

  await audit.log({
    user:      req.user,
    action:    'crm_import_partners',
    afterState: { filename: req.file.originalname, imported, errors: errors.length },
    metadata:  { import_id: importId },
    ipAddress: req.auditContext?.ipAddress,
  });

  res.json({
    import_id:    importId,
    filename:     req.file.originalname,
    rows_total:   records.length,
    imported,
    skipped:      skipped - errors.length,
    errors_count: errors.length,
    errors:       errors.slice(0, 20),
  });
});

// ── GET /api/crm/import/logs ──────────────────────────────────────
router.get('/logs', async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    // Handlowiec widzi tylko swoje importy
    if (!req.isCrmManager) {
      params.push(req.user.id);
      where = `WHERE l.imported_by = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT l.*, u.display_name AS imported_by_name
      FROM crm_import_logs l
      LEFT JOIN users u ON u.id = l.imported_by
      ${where}
      ORDER BY l.started_at DESC
      LIMIT 100
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/import/template/:type ───────────────────────────
router.get('/template/:type', (req, res) => {
  const bom = '\uFEFF'; // BOM dla Excel
  const templates = {
    leads: [
      'company,contact_name,contact_title,email,phone,source,stage,value_pln,probability,close_date,industry,notes,hot,tags',
      'Przykład Sp. z o.o.,Jan Kowalski,CEO,jan@example.pl,+48600000000,targi,qualification,150000,40,2025-12-31,IT,Notatka,false,tag1|tag2',
    ].join('\n'),
    partners: [
      'company,partner_number,nip,address,contact_name,contact_title,email,phone,industry,group_name,contract_signed,contract_expires,contract_value,license_count,status,notes',
      '"Przykład Partner Sp. z o.o.",1234567890,"ul. Przykładowa 1, Warszawa",Anna Nowak,VP,anna@example.pl,+48601000000,Transport,Magellan Holdings,2025-01-01,2026-01-01,200000,50,active,Uwagi',
    ].join('\n'),
  };

  const tmpl = templates[req.params.type];
  if (!tmpl) return res.status(404).json({ error: 'Nieznany typ szablonu. Użyj: leads lub partners' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import_${req.params.type}_template.csv"`);
  res.send(bom + tmpl);
});

module.exports = router;
