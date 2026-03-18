'use strict';
// src/routes/crm-sales-data.js
//
// GET  /api/crm/sales-data                 – surowe wiersze (filtry)
// GET  /api/crm/sales-data/summary         – agregacja miesięczna
// GET  /api/crm/sales-data/by-partner      – agregacja per partner (+ handlowiec z CRM)
// GET  /api/crm/sales-data/by-salesperson  – agregacja per handlowiec (via crm_partners)
// GET  /api/crm/sales-data/by-product      – agregacja per typ produktu
// GET  /api/crm/sales-data/partners        – lista partnerów z danych
// POST /api/crm/sales-data/import          – import CSV
// GET  /api/crm/sales-data/template        – szablon CSV

const express = require('express');
const multer  = require('multer');
const db      = require('../config/database');
const { requireAuth }                = require('../middleware/auth');
const { crmAuth, requireCrmManager } = require('../middleware/crm-rbac');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── CSV parser ────────────────────────────────────────────────────
function parseCsv(buffer) {
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.split('\n')[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(sep).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(sep);
    const obj  = {};
    header.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

// Mapowanie nagłówków CSV → kolumny DB
const COL_MAP = {
  // wymiary
  okres:                  'period',
  period:                 'period',
  numer_partnera:         'partner_number',
  partner_number:         'partner_number',
  partner:                'partner_name',
  partner_name:           'partner_name',
  nazwa_partnera:         'partner_name',
  produkt:                'product_type',
  product_type:           'product_type',
  typ_produktu:           'product_type',
  // finansowe
  obrot_brutto_pln:       'gross_turnover_pln',
  'obrót_brutto_pln':     'gross_turnover_pln',
  gross_turnover_pln:     'gross_turnover_pln',
  gross_turnover:         'gross_turnover_pln',
  obrot_netto_pln:        'net_turnover_pln',
  'obrót_netto_pln':      'net_turnover_pln',
  net_turnover_pln:       'net_turnover_pln',
  net_turnover:           'net_turnover_pln',
  fees_pln:               'fees_pln',
  fees:                   'fees_pln',
  prowizje_pln:           'fees_pln',
  przychod_pln:           'revenue_pln',
  'przychód_pln':         'revenue_pln',
  revenue_pln:            'revenue_pln',
  revenue:                'revenue_pln',
  marza_pln:              'revenue_pln',
  // operacyjne
  liczba_transakcji:      'transactions_count',
  transactions_count:     'transactions_count',
  transactions:           'transactions_count',
  liczba_pasazerow:       'pax_count',
  pax_count:              'pax_count',
  pax:                    'pax_count',
  uwagi:                  'notes',
  notes:                  'notes',
};

// Normalizacja nazw typów produktów
const PRODUCT_TYPE_MAP = {
  hotel:            'hotel',
  hotels:           'hotel',
  'transport_flight': 'transport_flight',
  lot:              'transport_flight',
  flight:           'transport_flight',
  flights:          'transport_flight',
  samolot:          'transport_flight',
  'transport_train': 'transport_train',
  pociag:           'transport_train',
  train:            'transport_train',
  'transport_bus':  'transport_bus',
  autobus:          'transport_bus',
  bus:              'transport_bus',
  'transport_ferry':'transport_ferry',
  prom:             'transport_ferry',
  ferry:            'transport_ferry',
  'car_rental':     'car_rental',
  wynajem_auta:     'car_rental',
  car:              'car_rental',
  transfer:         'transfer',
  'travel_insurance': 'travel_insurance',
  ubezpieczenie:    'travel_insurance',
  insurance:        'travel_insurance',
  visa:             'visa',
  wiza:             'visa',
  other:            'other',
  inne:             'other',
};

function mapRow(raw) {
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    const field = COL_MAP[key.trim().toLowerCase().replace(/ /g, '_')];
    if (field) out[field] = val || null;
  }
  // Normalizuj product_type
  if (out.product_type) {
    out.product_type = PRODUCT_TYPE_MAP[out.product_type.toLowerCase().replace(/ /g, '_')] || 'other';
  }
  return out;
}

function isValidPeriod(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
}

// Helper WHERE builder
function buildWhere(q, fieldMap) {
  const where = [], params = [];
  for (const [qKey, col] of Object.entries(fieldMap)) {
    if (q[qKey] != null && q[qKey] !== '') {
      params.push(q[qKey]);
      where.push(`${col} = $${params.length}`);
    }
  }
  if (q.period_from) { params.push(q.period_from); where.push(`period >= $${params.length}`); }
  if (q.period_to)   { params.push(q.period_to);   where.push(`period <= $${params.length}`); }
  return { where, params };
}

// Agregatywne kolumny finansowe (reużywane)
const FIN_AGGS = `
  SUM(gross_turnover_pln)::numeric(14,2) AS gross_turnover_pln,
  SUM(net_turnover_pln)::numeric(14,2)   AS net_turnover_pln,
  SUM(fees_pln)::numeric(14,2)           AS fees_pln,
  SUM(revenue_pln)::numeric(14,2)        AS revenue_pln,
  SUM(transactions_count)               AS transactions_count,
  SUM(pax_count)                        AS pax_count`;

// ─────────────────────────────────────────────────────────
// GET /template
// ─────────────────────────────────────────────────────────
router.get('/template', requireAuth, crmAuth, (req, res) => {
  const BOM  = '\uFEFF';
  const head = 'okres,numer_partnera,partner,produkt,obrot_brutto_pln,obrot_netto_pln,fees_pln,przychod_pln,liczba_transakcji,liczba_pasazerow,uwagi';
  const rows = [
    '2025-01,P-0001,Sigma Hotels Sp. z o.o.,hotel,320000,288000,32000,45000,12,240,',
    '2025-01,P-0001,Sigma Hotels Sp. z o.o.,transport_flight,85000,76500,8500,12000,8,64,',
    '2025-01,P-0002,Vanguard Travel S.A.,hotel,450000,405000,45000,63000,18,360,',
    '2025-01,P-0002,Vanguard Travel S.A.,car_rental,95000,85500,9500,13000,22,44,',
    '2025-01,P-0003,EuroTravel Group,transport_flight,180000,162000,18000,25000,15,120,',
    '2025-02,P-0001,Sigma Hotels Sp. z o.o.,hotel,340000,306000,34000,48000,13,260,',
    '2025-02,P-0002,Vanguard Travel S.A.,hotel,490000,441000,49000,69000,20,400,',
    '2025-03,P-0001,Sigma Hotels Sp. z o.o.,hotel,380000,342000,38000,53000,14,280,',
    '2025-03,P-0002,Vanguard Travel S.A.,transport_flight,520000,468000,52000,73000,25,200,',
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import_dane_sprzedazowe_template.csv"');
  res.send(BOM + head + '\n' + rows.join('\n') + '\n');
});

// ─────────────────────────────────────────────────────────
// GET /partners  – lista unikalnych partnerów z danych
// ─────────────────────────────────────────────────────────
router.get('/partners', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
       `SELECT DISTINCT t.partner_name, t.partner_number,
              p.id AS partner_id,
              u.display_name AS salesperson_name
       FROM crm_sales_transactions t
       LEFT JOIN crm_partners p ON p.partner_number = t.partner_number
                                OR (t.partner_number IS NULL AND lower(p.company) = lower(t.partner_name))
       LEFT JOIN users u ON u.id = p.manager_id
       ORDER BY t.partner_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /summary  – agregacja miesięczna
// query: period_from, period_to, partner_name, product_type
// ─────────────────────────────────────────────────────────
router.get('/summary', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { partner_name, product_type } = req.query;
    const { where, params } = buildWhere(req.query, {
      partner_name: 'partner_name',
      product_type:  'product_type',
    });
    const { rows } = await db.query(
      `SELECT period, ${FIN_AGGS}
       FROM crm_sales_transactions
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY period
       ORDER BY period DESC
       LIMIT 24`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-partner  – agregacja per partner + handlowiec z CRM
// query: period_from, period_to, product_type, salesperson_name (przez users)
// ─────────────────────────────────────────────────────────
router.get('/by-partner', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { product_type, salesperson_name } = req.query;
    const where = [], params = [];

    if (req.query.period_from) { params.push(req.query.period_from); where.push(`t.period >= $${params.length}`); }
    if (req.query.period_to)   { params.push(req.query.period_to);   where.push(`t.period <= $${params.length}`); }
    if (product_type)  { params.push(product_type);  where.push(`t.product_type = $${params.length}`); }
    if (salesperson_name) { params.push(salesperson_name); where.push(`u.display_name = $${params.length}`); }

    // Scope: salesperson widzi tylko swoich partnerów
    if (!req.isCrmManager) {
      params.push(req.user.id);
      where.push(`p.manager_id = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT
         t.partner_name,
         t.partner_number,
         p.id           AS partner_id,
         u.display_name AS salesperson_name,
         u.id           AS salesperson_id,
         SUM(t.gross_turnover_pln)::numeric(14,2) AS gross_turnover_pln,
         SUM(t.net_turnover_pln)::numeric(14,2)   AS net_turnover_pln,
         SUM(t.fees_pln)::numeric(14,2)           AS fees_pln,
         SUM(t.revenue_pln)::numeric(14,2)        AS revenue_pln,
         SUM(t.transactions_count)               AS transactions_count,
         SUM(t.pax_count)                        AS pax_count
       FROM crm_sales_transactions t
       LEFT JOIN crm_partners p ON p.partner_number = t.partner_number
                                OR (t.partner_number IS NULL AND lower(p.company) = lower(t.partner_name))
       LEFT JOIN users u ON u.id = p.manager_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY t.partner_name, t.partner_number, p.id, u.display_name, u.id
       ORDER BY SUM(t.gross_turnover_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-salesperson  – agregacja per handlowiec (via crm_partners)
// query: period_from, period_to, product_type
// ─────────────────────────────────────────────────────────
router.get('/by-salesperson', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { product_type } = req.query;
    const where = [], params = [];

    if (req.query.period_from) { params.push(req.query.period_from); where.push(`t.period >= $${params.length}`); }
    if (req.query.period_to)   { params.push(req.query.period_to);   where.push(`t.period <= $${params.length}`); }
    if (product_type)          { params.push(product_type);          where.push(`t.product_type = $${params.length}`); }

    // Scope: salesperson widzi tylko siebie
    if (!req.isCrmManager) {
      params.push(req.user.id);
      where.push(`u.id = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT
         COALESCE(u.display_name, '— brak opiekuna —') AS salesperson_name,
         u.id AS salesperson_id,
         COUNT(DISTINCT t.partner_name)                AS partners_count,
         SUM(t.gross_turnover_pln)::numeric(14,2)      AS gross_turnover_pln,
         SUM(t.net_turnover_pln)::numeric(14,2)        AS net_turnover_pln,
         SUM(t.fees_pln)::numeric(14,2)                AS fees_pln,
         SUM(t.revenue_pln)::numeric(14,2)             AS revenue_pln,
         SUM(t.transactions_count)                    AS transactions_count,
         SUM(t.pax_count)                             AS pax_count
       FROM crm_sales_transactions t
       LEFT JOIN crm_partners p ON p.partner_number = t.partner_number
                                OR (t.partner_number IS NULL AND lower(p.company) = lower(t.partner_name))
       LEFT JOIN users u ON u.id = p.manager_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY u.display_name, u.id
       ORDER BY SUM(t.gross_turnover_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /by-product  – agregacja per typ produktu
// query: period_from, period_to, partner_name
// ─────────────────────────────────────────────────────────
router.get('/by-product', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { partner_name } = req.query;
    const { where, params } = buildWhere(req.query, { partner_name: 'partner_name' });
    const { rows } = await db.query(
      `SELECT product_type, ${FIN_AGGS}
       FROM crm_sales_transactions
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY product_type
       ORDER BY SUM(gross_turnover_pln) DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// GET /  – surowe wiersze
// ─────────────────────────────────────────────────────────
router.get('/', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { partner_name, product_type } = req.query;
    const { where, params } = buildWhere(req.query, {
      partner_name: 't.partner_name',
      product_type:  't.product_type',
    });
    params.push(parseInt(req.query.limit) || 500);
    const { rows } = await db.query(
      `SELECT t.*,
              p.id           AS partner_id,
              u.display_name AS salesperson_name,
              u.id           AS salesperson_id,
              imp.display_name AS imported_by_name
       FROM crm_sales_transactions t
       LEFT JOIN crm_partners p ON p.partner_number = t.partner_number
                                OR (t.partner_number IS NULL AND lower(p.company) = lower(t.partner_name))
       LEFT JOIN users u   ON u.id = p.manager_id
       LEFT JOIN users imp ON imp.id = t.imported_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.period DESC, t.partner_name, t.product_type
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────
// POST /import
// ─────────────────────────────────────────────────────────
router.post('/import', requireAuth, crmAuth, requireCrmManager, upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Brak pliku' });

  const rawRows = parseCsv(req.file.buffer);
  const errors  = [];
  let imported = 0, skipped = 0;

  for (const [idx, raw] of rawRows.entries()) {
    const m      = mapRow(raw);
    const lineNo = idx + 2;

    if (!isValidPeriod(m.period)) {
      errors.push({ line: lineNo, reason: `Nieprawidłowy format okresu: "${m.period}" (wymagane YYYY-MM)` });
      skipped++; continue;
    }
    if (!m.partner_name && !m.partner_number) {
      errors.push({ line: lineNo, reason: 'Brak wymaganego pola "partner" lub "numer_partnera"' });
      skipped++; continue;
    }

    try {
      await db.query(
        `INSERT INTO crm_sales_transactions
           (period, partner_number, partner_name, product_type,
            gross_turnover_pln, net_turnover_pln, fees_pln, revenue_pln,
            transactions_count, pax_count, notes, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (period, partner_name, product_type) DO UPDATE SET
           partner_number     = EXCLUDED.partner_number,
           gross_turnover_pln = EXCLUDED.gross_turnover_pln,
           net_turnover_pln   = EXCLUDED.net_turnover_pln,
           fees_pln           = EXCLUDED.fees_pln,
           revenue_pln        = EXCLUDED.revenue_pln,
           transactions_count = EXCLUDED.transactions_count,
           pax_count          = EXCLUDED.pax_count,
           notes              = EXCLUDED.notes,
           imported_by        = EXCLUDED.imported_by,
           created_at         = NOW()`,
        [
          m.period,
          m.partner_number || null,
          m.partner_name   || null,
          m.product_type   || 'other',
          parseFloat(m.gross_turnover_pln) || 0,
          parseFloat(m.net_turnover_pln)   || 0,
          parseFloat(m.fees_pln)           || 0,
          parseFloat(m.revenue_pln)        || 0,
          parseInt(m.transactions_count)   || 0,
          parseInt(m.pax_count)            || 0,
          m.notes || null,
          req.user.id,
        ]
      );
      imported++;
    } catch (err) {
      errors.push({ line: lineNo, reason: err.message });
      skipped++;
    }
  }

  // Log do wspólnej tabeli crm_import_logs
  try {
    await db.query(
      `INSERT INTO crm_import_logs
         (import_type, filename, rows_total, rows_imported, rows_skipped, rows_error,
          error_details, status, imported_by, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
      [
        'sales', req.file.originalname, rawRows.length, imported, skipped, errors.length,
        errors.length > 0 ? JSON.stringify(errors) : null,
        errors.length === rawRows.length && rawRows.length > 0 ? 'error' : 'done',
        req.user.id,
      ]
    );
  } catch (_) { /* nie blokuj */ }

  res.json({
    rows_total: rawRows.length, rows_imported: imported,
    rows_skipped: skipped, rows_error: errors.length,
    errors: errors.slice(0, 20),
  });
});

// ── GET /api/crm/sales-data/report  ──────────────────────────────────────────
// Kompleksowy raport partnerów: KPI, trend, per partner, per produkt, per handlowiec
// Scope: salesperson widzi tylko swoich partnerów
router.get('/report', requireAuth, crmAuth, async (req, res, next) => {
  try {
    const { product_type } = req.query;
    const pfrom = req.query.period_from || '';
    const pto   = req.query.period_to   || '';

    // Buduj warunki wspólne
    function buildConditions(extraWhere) {
      const w = [], p = [];
      if (pfrom)        { p.push(pfrom);        w.push(`t.period >= $${p.length}`); }
      if (pto)          { p.push(pto);           w.push(`t.period <= $${p.length}`); }
      if (product_type) { p.push(product_type);  w.push(`t.product_type = $${p.length}`); }
      if (!req.isCrmManager) { p.push(req.user.id); w.push(`p.manager_id = $${p.length}`); }
      if (extraWhere) { p.push(...extraWhere.params); extraWhere.clauses.forEach(c => w.push(c.replace(/\$(\d+)/g, (_, n) => `$${+n + p.length - extraWhere.params.length}`))); }
      return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
    }

    const base = buildConditions(null);

    const JOIN = `
      LEFT JOIN crm_partners p ON p.partner_number = t.partner_number
                               OR (t.partner_number IS NULL AND lower(p.company) = lower(t.partner_name))
      LEFT JOIN users u ON u.id = p.manager_id`;

    const FIN = `
      SUM(t.gross_turnover_pln)::numeric(14,2) AS gross_turnover_pln,
      SUM(t.net_turnover_pln)::numeric(14,2)   AS net_turnover_pln,
      SUM(t.fees_pln)::numeric(14,2)           AS fees_pln,
      SUM(t.revenue_pln)::numeric(14,2)        AS revenue_pln,
      SUM(t.transactions_count)::int           AS transactions_count,
      SUM(t.pax_count)::int                    AS pax_count`;

    const [kpiRes, trendRes, byPartnerRes, byProductRes, byRepRes] = await Promise.all([

      // KPI zbiorcze
      db.query(`
        SELECT ${FIN},
          ROUND(100.0 * SUM(t.revenue_pln) / NULLIF(SUM(t.gross_turnover_pln),0), 2) AS margin_pct,
          ROUND(100.0 * SUM(t.fees_pln)    / NULLIF(SUM(t.gross_turnover_pln),0), 2) AS fee_rate_pct,
          COUNT(DISTINCT t.partner_name)::int AS partners_count
        FROM crm_sales_transactions t ${JOIN}
        ${base.where}
      `, base.params),

      // Trend miesięczny
      db.query(`
        SELECT t.period,
               SUM(t.gross_turnover_pln)::numeric(14,2) AS gross_turnover_pln,
               SUM(t.net_turnover_pln)::numeric(14,2)   AS net_turnover_pln,
               SUM(t.revenue_pln)::numeric(14,2)        AS revenue_pln,
               SUM(t.transactions_count)::int           AS transactions_count
        FROM crm_sales_transactions t ${JOIN}
        ${base.where}
        GROUP BY t.period
        ORDER BY t.period ASC
      `, base.params),

      // Per partner
      db.query(`
        SELECT t.partner_name, t.partner_number, p.id AS partner_id,
               u.display_name AS salesperson_name, u.id AS salesperson_id,
               ${FIN}
        FROM crm_sales_transactions t ${JOIN}
        ${base.where}
        GROUP BY t.partner_name, t.partner_number, p.id, u.display_name, u.id
        ORDER BY SUM(t.gross_turnover_pln) DESC
      `, base.params),

      // Per produkt
      db.query(`
        SELECT t.product_type, ${FIN}
        FROM crm_sales_transactions t ${JOIN}
        ${base.where}
        GROUP BY t.product_type
        ORDER BY SUM(t.gross_turnover_pln) DESC
      `, base.params),

      // Per handlowiec (tylko manager widzi wszystkich)
      req.isCrmManager
        ? db.query(`
            SELECT COALESCE(u.display_name,'— brak opiekuna —') AS salesperson_name,
                   u.id AS salesperson_id,
                   COUNT(DISTINCT t.partner_name)::int AS partners_count,
                   ${FIN}
            FROM crm_sales_transactions t ${JOIN}
            ${base.where}
            GROUP BY u.display_name, u.id
            ORDER BY SUM(t.gross_turnover_pln) DESC
          `, base.params)
        : Promise.resolve({ rows: [] }),
    ]);

    // Poprzedni równoważny okres (do porównania)
    let prevKpi = null;
    if (pfrom && pto) {
      const fromDate = new Date(pfrom + '-01');
      const toDate   = new Date(pto   + '-01');
      const diffMs   = toDate - fromDate;
      const prevTo   = new Date(fromDate.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - diffMs);
      const prevPFrom = prevFrom.toISOString().substring(0,7);
      const prevPTo   = prevTo.toISOString().substring(0,7);

      const prevW = [], prevP = [];
      prevP.push(prevPFrom); prevW.push(`t.period >= $${prevP.length}`);
      prevP.push(prevPTo);   prevW.push(`t.period <= $${prevP.length}`);
      if (product_type)        { prevP.push(product_type); prevW.push(`t.product_type = $${prevP.length}`); }
      if (!req.isCrmManager)   { prevP.push(req.user.id);  prevW.push(`p.manager_id = $${prevP.length}`); }

      const prevWhere = prevW.length ? 'WHERE ' + prevW.join(' AND ') : '';
      const prevRes = await db.query(`
        SELECT ${FIN},
          ROUND(100.0 * SUM(t.revenue_pln) / NULLIF(SUM(t.gross_turnover_pln),0), 2) AS margin_pct
        FROM crm_sales_transactions t ${JOIN}
        ${prevWhere}
      `, prevP);
      prevKpi = prevRes.rows[0] || null;
    }

    res.json({
      kpi:        kpiRes.rows[0] || {},
      prev_kpi:   prevKpi,
      trend:      trendRes.rows,
      by_partner: byPartnerRes.rows,
      by_product: byProductRes.rows,
      by_rep:     byRepRes.rows,
      period_from: pfrom,
      period_to:   pto,
    });
  } catch (err) { next(err); }
});


module.exports = router;
