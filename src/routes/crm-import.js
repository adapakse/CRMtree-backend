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
          // Strip dictionary hints from column names: "stage[new|qual...]" → "stage"
          const cleanKey = k.trim().toLowerCase().replace(/\[.*?\]/g, '').trim();
          normalized[cleanKey] = typeof v === 'string' ? v.trim() : v;
        }
        records.push(normalized);
      })
      .on('error', reject)
      .on('end',   () => resolve(records));
  });
}

const nStr   = v => (v || '').trim() || null;
const nFloat = v => {
  // Strip thousands separators (space, dot used as thousands sep) and normalise decimal comma
  let s = (v || '').trim().replace(/\s/g, '');
  // If both . and , present: European format (1.000,50) or US format (1,000.50)
  if (s.includes('.') && s.includes(',')) {
    // whichever comes last is the decimal separator
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // European: remove dots, comma→dot
    } else {
      s = s.replace(/,/g, ''); // US: remove commas
    }
  } else {
    s = s.replace(',', '.'); // single comma → decimal dot
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};
const nInt        = v => { const n = parseInt(v);  return isNaN(n) ? null : n; };
const nProbability = v => {
  if (!v) return null;
  let s = String(v).trim().replace('%', '').replace(',', '.').trim();
  let n = parseFloat(s);
  if (isNaN(n)) return null;
  // If value looks like a decimal fraction (0.0–1.0) convert to percent
  if (n > 0 && n <= 1) n = Math.round(n * 100);
  // Clamp to 0–100
  n = Math.min(100, Math.max(0, Math.round(n)));
  return n;
};
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
      // Resolve assigned_to by email
      let assignedTo = req.user.id;
      const assignedEmail = nStr(row.assigned_to_email || row.handlowiec_email);
      if (assignedEmail) {
        const { rows: uRows } = await db.query('SELECT id FROM users WHERE email ILIKE $1 LIMIT 1', [assignedEmail]).catch(() => ({ rows: [] }));
        if (uRows.length) assignedTo = uRows[0].id;
      }

      await db.query(`
        INSERT INTO crm_leads
          (company, contact_name, contact_title, email, phone, source, stage,
           value_pln, annual_turnover_currency, probability, close_date, industry,
           assigned_to, tags, notes, hot, created_by,
           online_pct, agent_name, agent_email, agent_phone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      `, [
        company,
        nStr(row.contact_name || row.kontakt),
        nStr(row.contact_title || row.stanowisko),
        nStr(row.email),
        nStr(row.phone || row.telefon),
        nStr(row.source || row.zrodlo) || 'inne',
        stage,
        nFloat(row.value_pln || row.wartosc),
        nStr(row.annual_turnover_currency || row.waluta) || 'PLN',
        nProbability(row.probability   || row.prawdopodobienstwo),
        nDate(row.close_date   || row.data_zamkniecia),
        nStr(row.industry      || row.branza),
        assignedTo,
        nTags(row.tags || row.tagi),
        nStr(row.notes || row.notatki),
        nBool(row.hot),
        req.user.id,
        nInt(row.online_pct || row.procent_online),
        nStr(row.agent_name),
        nStr(row.agent_email),
        nStr(row.agent_phone),
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
      // Resolve manager by email
      let managerId = req.user.id;
      const managerEmail = nStr(row.manager_email || row.opiekun_email);
      if (managerEmail) {
        const { rows: mRows } = await db.query('SELECT id FROM users WHERE email ILIKE $1 LIMIT 1', [managerEmail]).catch(() => ({ rows: [] }));
        if (mRows.length) managerId = mRows[0].id;
      }

      await db.query(`
        INSERT INTO crm_partners
          (company, partner_number, nip, address,
           contact_name, contact_title, email, phone,
           billing_contact_name, billing_contact_title, billing_email, billing_phone,
           industry, group_id, manager_id,
           contract_signed, contract_expires, contract_value,
           status, notes,
           annual_turnover_currency, online_pct, tags,
           credit_limit_value, credit_limit_currency,
           deposit_value, deposit_currency, deposit_date_in, deposit_date_out,
           commission_value, commission_basis,
           agent_name, agent_email, agent_phone,
           subdomain, language, partner_currency, country,
           billing_address, billing_zip, billing_city, billing_country, billing_email_address,
           admin_first_name, admin_last_name, admin_email,
           created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46)
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
        nStr(row.billing_contact_name),
        nStr(row.billing_contact_title),
        nStr(row.billing_email),
        nStr(row.billing_phone),
        nStr(row.industry || row.branza),
        groupId,
        managerId,
        nDate(row.contract_signed  || row.data_podpisania),
        nDate(row.contract_expires || row.data_wygasniecia),
        nFloat(row.contract_value || row.wartosc_umowy),
        status,
        nStr(row.notes || row.notatki),
        nStr(row.annual_turnover_currency || row.waluta) || 'PLN',
        nInt(row.online_pct || row.procent_online),
        nTags(row.tags || row.tagi),
        nFloat(row.credit_limit_value),
        nStr(row.credit_limit_currency) || null,
        nFloat(row.deposit_value),
        nStr(row.deposit_currency) || null,
        nDate(row.deposit_date_in),
        nDate(row.deposit_date_out),
        nFloat(row.commission_value),
        nStr(row.commission_basis) || null,
        nStr(row.agent_name),
        nStr(row.agent_email),
        nStr(row.agent_phone),
        // Zadanie A
        nStr(row.subdomain || row.subdomena),
        nStr(row.language || row.jezyk),
        nStr(row.partner_currency || row.waluta_partnera),
        nStr(row.country || row.kraj),
        // Zadanie B
        nStr(row.billing_address || row.billing_adres),
        nStr(row.billing_zip || row.billing_kod_pocztowy),
        nStr(row.billing_city || row.billing_miasto),
        nStr(row.billing_country || row.billing_kraj),
        nStr(row.billing_email_address || row.billing_email_rozliczeniowy),
        // Zadanie C
        nStr(row.admin_first_name || row.admin_imie),
        nStr(row.admin_last_name  || row.admin_nazwisko),
        nStr(row.admin_email),
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

// ── POST /api/crm/import/documents ───────────────────────────────
router.post('/documents', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(422).json({ error: 'Plik CSV jest wymagany (pole: file)' });

  let records;
  try { records = await parseCsvBuffer(req.file.buffer); }
  catch (e) { return res.status(422).json({ error: `Błąd parsowania CSV: ${e.message}` }); }

  // Załaduj słowniki z app_settings
  let docTypes  = ['partner_agreement','nda','it_supplier_agreement','employee_agreement'];
  let gdprTypes = ['no_gdpr','data_processing_entrustment','data_administration'];
  let docStatuses = ['new','being_edited','being_approved','being_signed','signed','completed','rejected'];
  try {
    const { rows: sets } = await db.query(
      "SELECT key, value FROM app_settings WHERE key IN ('doc_types','doc_gdpr_types','doc_statuses')"
    );
    for (const s of sets) {
      try {
        const vals = JSON.parse(s.value);
        if (s.key === 'doc_types') docTypes = vals;
        if (s.key === 'doc_gdpr_types') gdprTypes = vals;
        if (s.key === 'doc_statuses') docStatuses = vals;
      } catch(_) {}
    }
  } catch(_) {}

  // Załaduj mapę grup dokumentowych
  const { rows: groups } = await db.query('SELECT id, name, display_name FROM group_profiles WHERE is_active = true').catch(() => ({ rows: [] }));
  const groupMap = {};
  groups.forEach(g => {
    groupMap[g.name.toLowerCase()] = g.id;
    if (g.display_name) groupMap[g.display_name.toLowerCase()] = g.id;
  });

  const { rows: logRows } = await db.query(
    `INSERT INTO crm_import_logs (import_type, filename, rows_total, imported_by)
     VALUES ('documents', $1, $2, $3) RETURNING id`,
    [req.file.originalname, records.length, req.user.id]
  ).catch(next);

  const importId = logRows[0].id;
  let imported = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < records.length; i++) {
    const row    = records[i];
    const rowNum = i + 2;

    if (i === 0) console.log('[CRM Import documents] Kolumny CSV:', Object.keys(row));

    const name = nStr(row.name || row.nazwa || row.document_name);
    if (!name) {
      errors.push({ row: rowNum, field: 'name', error: 'Pole name jest wymagane' });
      skipped++; continue;
    }

    const docType = nStr(row.doc_type || row.typ_dokumentu) || docTypes[0];
    if (!docTypes.includes(docType)) {
      errors.push({ row: rowNum, field: 'doc_type', error: `Nieznany typ dokumentu: ${docType}. Dostępne: ${docTypes.join(', ')}` });
      skipped++; continue;
    }

    const gdprType = nStr(row.gdpr_type || row.typ_gdpr) || 'no_gdpr';
    if (!gdprTypes.includes(gdprType)) {
      errors.push({ row: rowNum, field: 'gdpr_type', error: `Nieznany typ GDPR: ${gdprType}. Dostępne: ${gdprTypes.join(', ')}` });
      skipped++; continue;
    }

    const status = nStr(row.status) || 'new';
    if (!docStatuses.includes(status)) {
      errors.push({ row: rowNum, field: 'status', error: `Nieznany status: ${status}. Dostępne: ${docStatuses.join(', ')}` });
      skipped++; continue;
    }

    const groupName = nStr(row.group_name || row.grupa);
    const groupId = groupName ? (groupMap[groupName.toLowerCase()] || null) : null;

    // entities — podmioty (pipe-separated)
    const entity1 = nStr(row.entity_1 || row.entity1 || row.podmiot_1);
    const entity2 = nStr(row.entity_2 || row.entity2 || row.podmiot_2);
    const entities = [entity1, entity2].filter(Boolean);

    // tags — format: klucz1:wartość1;klucz2:wartość2
    const tagsRaw = nStr(row.tags || row.tagi) || '';
    const parsedTags = tagsRaw
      ? tagsRaw.split(';').map(t => t.trim()).filter(Boolean).map(t => {
          const sep = t.indexOf(':');
          if (sep < 1) return null;
          return { key: t.slice(0, sep).trim(), value: t.slice(sep + 1).trim() };
        }).filter(Boolean)
      : [];

    try {
      const { rows: docRows } = await db.query(`
        INSERT INTO documents
          (name, doc_type, gdpr_type, status, group_id, entities,
           creation_date, signing_date, expiration_date,
           created_by, owner_id)
        VALUES ($1,$2::doc_type,$3::gdpr_type,$4::doc_status,$5,$6,$7,$8,$9,$10,$10)
        RETURNING id
      `, [
        name,
        docType,
        gdprType,
        status,
        groupId,
        entities,
        nDate(row.creation_date || row.data_utworzenia) || new Date().toISOString().slice(0,10),
        nDate(row.signing_date || row.data_podpisania),
        nDate(row.expiration_date || row.data_waznosci),
        req.user.id,
      ]);

      // Importuj tagi
      if (parsedTags.length && docRows[0]?.id) {
        const docId = docRows[0].id;
        for (const tag of parsedTags) {
          await db.query(
            `INSERT INTO document_tags (document_id, key, value, created_by)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [docId, tag.key, tag.value, req.user.id]
          ).catch(() => {}); // ignoruj błędy pojedynczych tagów
        }
      }

      imported++;
    } catch (e) {
      errors.push({ row: rowNum, field: name, error: e.message });
      skipped++;
    }
  }

  await db.query(
    `UPDATE crm_import_logs
     SET rows_imported=$1, rows_skipped=$2, rows_error=$3,
         error_details=$4, status='done', finished_at=now()
     WHERE id=$5`,
    [imported, skipped - errors.length, errors.length,
     errors.length ? JSON.stringify(errors.slice(0,100)) : null, importId]
  ).catch(() => {});

  await audit.log({
    user:      req.user,
    action:    'crm_import_documents',
    afterState: { filename: req.file.originalname, imported, errors: errors.length },
    metadata:  { import_id: importId },
    ipAddress: req.auditContext?.ipAddress,
  });

  res.json({
    import_id: importId, filename: req.file.originalname,
    rows_total: records.length, imported,
    skipped: skipped - errors.length, errors_count: errors.length,
    errors: errors.slice(0, 20),
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
      'company,contact_name,contact_title[CEO|CFO|CTO|COO|VP|Director|Manager|Specialist|Owner|Other],email,phone,source[strona_www|polecenie|cold_call|linkedin|targi|partner|agent|kampania|inbound|inne],stage[new|qualification|presentation|offer|negotiation|closed_won|closed_lost],value_pln,annual_turnover_currency[PLN|EUR|USD|GBP|CHF],probability,close_date,industry[IT|Finance|Transport|Tourism|Healthcare|Retail|Manufacturing|Legal|Education|Other],assigned_to_email,notes,hot,tags,agent_name,agent_email,agent_phone,online_pct',
      'Przykład Sp. z o.o.,Jan Kowalski,CEO,jan@example.pl,+48600000000,targi,qualification,150000,PLN,40,2025-12-31,IT,handlowiec@firma.pl,Notatka,false,tag1|tag2,,,,,30',
    ].join('\n'),
    partners: [
      'company,partner_number,nip,address,contact_name,contact_title[CEO|CFO|CTO|COO|VP|Director|Manager|Specialist|Owner|Other],email,phone,industry[IT|Finance|Transport|Tourism|Healthcare|Retail|Manufacturing|Legal|Education|Other],group_name,contract_signed,contract_expires,contract_value,status[onboarding|active|inactive|churned],notes,annual_turnover_currency[PLN|EUR|USD|GBP|CHF],online_pct,tags,billing_contact_name,billing_contact_title,billing_email,billing_phone,credit_limit_value,credit_limit_currency[PLN|EUR|USD|GBP],deposit_value,deposit_currency[PLN|EUR|USD|GBP],deposit_date_in,deposit_date_out,commission_value,commission_basis[nie_dotyczy|segmenty|rezerwacje|progi_obrotowe],agent_name,agent_email,agent_phone,manager_email,subdomain,language[Polski|Angielski|Rosyjski|Rumuński|Niemiecki],partner_currency[PLN|EUR|USD|GBP|CHF],country,billing_address,billing_zip,billing_city,billing_country,billing_email_address,admin_first_name,admin_last_name,admin_email',
      '"Przykład Partner Sp. z o.o.","P-0001","1234567890","ul. Przykładowa 1, Warszawa","Anna Nowak","VP","anna@example.pl","+48601000000","Transport","Magellan Holdings","2025-01-01","2026-01-01","500000","active","Uwagi","PLN","30","tag1|tag2","Jan Rozliczenia","Specjalista","rozlicz@firma.pl","+48600111222","100000","PLN","50000","PLN","2025-01-15","","0.05","segmenty","","","","opiekun@worktrips.com","acme","Polski","PLN","Polska","ul. Fakturowa 1","00-001","Warszawa","Polska","faktury@acme.pl","Jan","Kowalski","admin@acme.pl"',
    ].join('\n'),
  };

  // Documents template
  if (!templates.documents) {
    templates.documents = [
      'name,doc_type[partner_agreement|nda|it_supplier_agreement|employee_agreement],gdpr_type[no_gdpr|data_processing_entrustment|data_administration],status[new|being_edited|being_approved|being_signed|signed|completed|rejected],group_name[Accounting|HR|Marketing|Obsługa Klienta|Operations|Sprzedaz|Zarzad],entity_1,entity_2,creation_date,signing_date,expiration_date,tags',
      '"Umowa partnerska XYZ","partner_agreement","no_gdpr","new","Sprzedaz","Worktrips Sp. z o.o.","Jan Kowalski","2026-01-15","","2027-01-15","contract_id:2026/ABC/001;region:EMEA"',
    ].join('\n');
  }

  const tmpl = templates[req.params.type];
  if (!tmpl) return res.status(404).json({ error: 'Nieznany typ szablonu. Użyj: leads, partners lub documents' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import_${req.params.type}_template.csv"`);
  res.send(bom + tmpl);
});


// ── GET /api/crm/import/export/:type ─────────────────────────────
// Export existing data as CSV using same column format as import template
router.get('/export/:type', async (req, res, next) => {
  try {
    const { type } = req.params;
    const bom = '\uFEFF';

    // Helper: escape CSV cell (wrap in quotes if contains comma/quote/newline)
    const cell = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const row = cols => cols.map(cell).join(',');
    const fmt = v => v ? String(v).slice(0, 10) : ''; // date formatting

    if (type === 'leads') {
      // Header identical to import template (without bracket hints for data rows)
      const header = 'company,contact_name,contact_title[CEO|CFO|CTO|COO|VP|Director|Manager|Specialist|Owner|Other],email,phone,source[strona_www|polecenie|cold_call|linkedin|targi|partner|agent|kampania|inbound|inne],stage[new|qualification|presentation|offer|negotiation|closed_won|closed_lost],value_pln,annual_turnover_currency[PLN|EUR|USD|GBP|CHF],probability,close_date,industry[IT|Finance|Transport|Tourism|Healthcare|Retail|Manufacturing|Legal|Education|Other],assigned_to_email,notes,hot,tags,agent_name,agent_email,agent_phone,online_pct';

      const params = [];
      const scope = req.scopeFilter ? req.scopeFilter('l', 'assigned_to', params) : '';
      const { rows } = await db.query(`
        SELECT l.*, u.email AS assigned_to_email_val
        FROM crm_leads l
        LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.converted_at IS NULL ${scope}
        ORDER BY l.company
      `, params);

      const lines = [header];
      for (const r of rows) {
        lines.push(row([
          r.company, r.contact_name, r.contact_title,
          r.email, r.phone, r.source, r.stage,
          r.value_pln, r.annual_turnover_currency, r.probability,
          fmt(r.close_date), r.industry, r.assigned_to_email_val,
          r.notes, r.hot ? 'true' : 'false',
          (r.tags || []).join('|'),
          r.agent_name, r.agent_email, r.agent_phone, r.online_pct,
        ]));
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export_leads_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(bom + lines.join('\n'));
    }

    if (type === 'partners') {
      const header = 'company,partner_number,nip,address,contact_name,contact_title[CEO|CFO|CTO|COO|VP|Director|Manager|Specialist|Owner|Other],email,phone,industry[IT|Finance|Transport|Tourism|Healthcare|Retail|Manufacturing|Legal|Education|Other],group_name,contract_signed,contract_expires,contract_value,status[onboarding|active|inactive|churned],notes,annual_turnover_currency[PLN|EUR|USD|GBP|CHF],online_pct,tags,billing_contact_name,billing_contact_title,billing_email,billing_phone,credit_limit_value,credit_limit_currency[PLN|EUR|USD|GBP],deposit_value,deposit_currency[PLN|EUR|USD|GBP],deposit_date_in,deposit_date_out,commission_value,commission_basis[nie_dotyczy|segmenty|rezerwacje|progi_obrotowe],agent_name,agent_email,agent_phone,manager_email,subdomain,language,partner_currency,country,billing_address,billing_zip,billing_city,billing_country,billing_email_address,admin_first_name,admin_last_name,admin_email';

      const { rows } = await db.query(`
        SELECT p.*, g.name AS group_name_val,
               mu.email AS manager_email_val
        FROM crm_partners p
        LEFT JOIN crm_partner_groups g ON g.id = p.group_id
        LEFT JOIN users mu ON mu.id = p.manager_id
        ORDER BY p.company
      `);

      const lines = [header];
      for (const r of rows) {
        lines.push(row([
          r.company, r.partner_number, r.nip, r.address,
          r.contact_name, r.contact_title, r.email, r.phone,
          r.industry, r.group_name_val,
          fmt(r.contract_signed), fmt(r.contract_expires), r.contract_value,
          r.status, r.notes, r.annual_turnover_currency, r.online_pct,
          (r.tags || []).join('|'),
          r.billing_contact_name, r.billing_contact_title, r.billing_email, r.billing_phone,
          r.credit_limit_value, r.credit_limit_currency,
          r.deposit_value, r.deposit_currency,
          fmt(r.deposit_date_in), fmt(r.deposit_date_out),
          r.commission_value, r.commission_basis,
          r.agent_name, r.agent_email, r.agent_phone, r.manager_email_val,
          // Zadanie A
          r.subdomain, r.language, r.partner_currency, r.country,
          // Zadanie B
          r.billing_address, r.billing_zip, r.billing_city, r.billing_country, r.billing_email_address,
          // Zadanie C
          r.admin_first_name, r.admin_last_name, r.admin_email,
        ]));
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export_partners_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(bom + lines.join('\n'));
    }

    if (type === 'documents') {
      const header = 'name,doc_type[partner_agreement|nda|it_supplier_agreement|employee_agreement],gdpr_type[no_gdpr|data_processing_entrustment|data_administration],status[new|being_edited|being_approved|being_signed|signed|completed|rejected],group_name[Accounting|HR|Marketing|Obsługa Klienta|Operations|Sprzedaz|Zarzad],entity_1,entity_2,creation_date,signing_date,expiration_date,tags';

      const { rows } = await db.query(`
        SELECT d.name, d.doc_type, d.gdpr_type, d.status,
               gp.display_name AS group_name_val,
               d.entities, d.creation_date, d.signing_date, d.expiration_date,
               COALESCE(
                 (SELECT string_agg(key || ':' || value, ';' ORDER BY key)
                  FROM document_tags WHERE document_id = d.id),
               '') AS tags_str
        FROM documents d
        LEFT JOIN group_profiles gp ON gp.id = d.group_id
        WHERE d.deleted_at IS NULL
        ORDER BY d.doc_number
      `);

      const lines = [header];
      for (const r of rows) {
        const entities = r.entities || [];
        lines.push(row([
          r.name, r.doc_type, r.gdpr_type, r.status,
          r.group_name_val,
          entities[0] || '', entities[1] || '',
          fmt(r.creation_date), fmt(r.signing_date), fmt(r.expiration_date),
          r.tags_str || '',
        ]));
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export_documents_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(bom + lines.join('\n'));
    }

    return res.status(404).json({ error: 'Nieznany typ. Użyj: leads, partners lub documents' });
  } catch (err) { next(err); }
});

module.exports = router;
