'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-leads.js
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const db    = require('../config/database');
const audit = require('../services/auditService');
const { requireAuth }                     = require('../middleware/auth');
const { validate, injectAuditContext }    = require('../middleware/errorHandler');
const { crmAuth, crmScope, requireCrmManager, assertOwnership } = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth);

// ── GET /api/crm/leads ────────────────────────────────────────────
router.get('/',
  crmScope,
  [
    query('stage').optional().isString(),
    query('source').optional().isString().trim(),
    query('assigned_to').optional().isUUID(),
    query('hot').optional().isBoolean().toBoolean(),
    query('search').optional().isString().trim(),
    query('close_date_from').optional().isDate(),
    query('close_date_to').optional().isDate(),
    query('lost_reason').optional().isString().trim(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page   = req.query.page  || 1;
      const limit  = req.query.limit || 50;
      const offset = (page - 1) * limit;

      const params = [];
      let where = "WHERE l.converted_at IS NULL";

      where += req.scopeFilter('l', 'assigned_to', params);

      if (req.query.stage) {
        params.push(req.query.stage);
        where += ` AND l.stage = $${params.length}`;
      }
      if (req.query.source) {
        params.push(req.query.source);
        where += ` AND l.source = $${params.length}`;
      }
      if (req.query.assigned_to && req.isCrmManager) {
        params.push(req.query.assigned_to);
        where += ` AND l.assigned_to = $${params.length}`;
      }
      if (req.query.hot === true) {
        where += ` AND l.hot = true`;
      }
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        where += ` AND (l.company ILIKE $${params.length} OR l.contact_name ILIKE $${params.length} OR l.email ILIKE $${params.length})`;
      }
      if (req.query.close_date_from) {
        params.push(req.query.close_date_from);
        where += ` AND l.close_date >= $${params.length}::date`;
      }
      if (req.query.close_date_to) {
        params.push(req.query.close_date_to);
        where += ` AND l.close_date <= $${params.length}::date`;
      }
      if (req.query.lost_reason) {
        params.push(req.query.lost_reason);
        where += ` AND l.lost_reason = $${params.length}`;
      }

      const countParams = [...params];
      params.push(limit, offset);

      const [countResult, rows] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM crm_leads l ${where}`, countParams),
        db.query(`
          SELECT l.*,
            u.display_name AS assigned_to_name,
            u.email        AS assigned_to_email,
            (SELECT COUNT(*) FROM crm_lead_activities a WHERE a.lead_id = l.id) AS activity_count,
            (SELECT COUNT(*) FROM crm_lead_documents  d WHERE d.lead_id = l.id) AS document_count
          FROM crm_leads l
          LEFT JOIN users u ON u.id = l.assigned_to
          ${where}
          ORDER BY l.updated_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
      ]);

      res.json({
        data:  rows.rows,
        total: parseInt(countResult.rows[0].count),
        page, limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      });
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/leads ───────────────────────────────────────────
router.post('/',
  [
    body('company').notEmpty().trim(),
    body('contact_name').optional().trim(),
    body('contact_title').optional().trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('phone').optional().trim(),
    body('source').optional().trim(),
    body('stage').optional().isIn(['new','qualification','presentation','offer','negotiation','closed_won','closed_lost']),
    body('value_pln').optional({ nullable: true }).isFloat({ min: 0 }),
    body('annual_turnover_currency').optional({ nullable: true }).isString(),
    body('online_pct').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('probability').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('close_date').optional({ nullable: true }).isDate(),
    body('industry').optional().trim(),
    body('assigned_to').optional().isUUID(),
    body('tags').optional().isArray(),
    body('notes').optional().trim(),
    body('hot').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        company, contact_name, contact_title, email, phone, source,
        stage = 'new', value_pln, annual_turnover_currency, online_pct, probability, close_date, industry,
        assigned_to, tags, notes, hot = false,
      } = req.body;

      // Handlowiec może przypisać tylko do siebie
      const ownerId = req.isCrmManager ? (assigned_to || req.user.id) : req.user.id;

      const { rows } = await db.query(`
        INSERT INTO crm_leads
          (company, contact_name, contact_title, email, phone, source, stage,
           value_pln, annual_turnover_currency, online_pct, probability, close_date, industry, assigned_to,
           tags, notes, hot, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING *
      `, [
        company, contact_name||null, contact_title||null, email||null,
        phone||null, source||null, stage,
        value_pln||null, annual_turnover_currency||'PLN', online_pct||null, probability||null, close_date||null, industry||null,
        ownerId, tags||[], notes||null, hot, req.user.id,
      ]);

      await audit.log({
        user:      req.user,
        action:    'crm_lead_create',
        afterState: { company, stage, assigned_to: ownerId },
        metadata:  { lead_id: rows[0].id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/crm/leads/:id ────────────────────────────────────────
// ── GET /api/crm/users ────────────────────────────────────────────
// Zwraca listę userów z rolą CRM (salesperson + sales_manager + admin).
// Dostępne dla każdego zalogowanego usera z rolą CRM — potrzebne
// do list wyboru handlowca w formularzach leadów i partnerów.
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, display_name, email, crm_role
      FROM users
      WHERE is_active = true
        AND (crm_role IN ('salesperson', 'sales_manager') OR is_admin = true)
      ORDER BY display_name
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/contact-suggestions', async (req, res, next) => {
  try {
    const { lead_id, partner_id } = req.query;

    // Usery z rolą CRM
    const { rows: users } = await db.query(`
      SELECT display_name AS name, email
      FROM users
      WHERE is_active = true AND (crm_role IN ('salesperson','sales_manager') OR is_admin = true)
      ORDER BY display_name
    `);

    const suggestions = users.map(u => ({ email: u.email, name: u.name }));

    // Email kontaktu z leada
    if (lead_id) {
      const { rows: lead } = await db.query(
        `SELECT contact_name AS name, email FROM crm_leads WHERE id=$1 AND email IS NOT NULL`,
        [parseInt(lead_id)]
      );
      lead.forEach(l => { if (l.email && !suggestions.find(s => s.email === l.email)) suggestions.push({ email: l.email, name: l.name || l.email }); });
    }

    // Emaile kontaktów z partnera
    if (partner_id) {
      const { rows: partner } = await db.query(
        `SELECT contact_name, email, billing_contact_name, billing_email
         FROM crm_partners WHERE id=$1`,
        [parseInt(partner_id)]
      );
      if (partner[0]) {
        const p = partner[0];
        if (p.email && !suggestions.find(s => s.email === p.email))
          suggestions.push({ email: p.email, name: p.contact_name || p.email });
        if (p.billing_email && !suggestions.find(s => s.email === p.billing_email))
          suggestions.push({ email: p.billing_email, name: p.billing_contact_name || p.billing_email });
      }
    }

    res.json(suggestions);
  } catch (err) { next(err); }
});


// ── GET /api/crm/leads/calendar ────────────────────────────────────────────
// Zwraca aktywności typu "meeting" dla kalendarza (leady + partnerzy)
// query: date_from (YYYY-MM-DD), date_to, assigned_to (UUID, tylko manager)

router.get('/calendar', async (req, res, next) => {
  try {
    const { date_from, date_to, assigned_to } = req.query;

    const conds  = [];
    const params = [];

    // Zakres dat
    if (date_from) { params.push(date_from); conds.push(`a.activity_at >= $${params.length}::date`); }
    if (date_to)   { params.push(date_to);   conds.push(`a.activity_at <  ($${params.length}::date + interval '1 day')`); }

    // Scope: handlowiec widzi tylko swoje
    if (!req.isCrmManager) {
      params.push(req.user.id);
      conds.push(`l.assigned_to = $${params.length}`);
    } else if (assigned_to) {
      params.push(assigned_to);
      conds.push(`l.assigned_to = $${params.length}`);
    }

    const where = conds.length ? "WHERE a.type = 'meeting' AND " + conds.join(' AND ') : "WHERE a.type = 'meeting'";

    // Aktywności z leadów
    const { rows: leadActs } = await db.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by,
        u.display_name  AS created_by_name,
        'lead'          AS source_type,
        l.id            AS source_id,
        l.company       AS source_name,
        lu.display_name AS assigned_to_name,
        lu.id           AS assigned_to_id
      FROM crm_lead_activities a
      JOIN crm_leads l      ON l.id  = a.lead_id
      LEFT JOIN users u     ON u.id  = a.created_by
      LEFT JOIN users lu    ON lu.id = l.assigned_to
      ${where}
      ORDER BY a.activity_at DESC
    `, params);

    // Aktywności z partnerów — osobne zapytanie z innymi warunkami scope
    const condsPart  = [];
    const paramsPart = [];

    if (date_from) { paramsPart.push(date_from); condsPart.push(`a.activity_at >= $${paramsPart.length}::date`); }
    if (date_to)   { paramsPart.push(date_to);   condsPart.push(`a.activity_at <  ($${paramsPart.length}::date + interval '1 day')`); }

    if (!req.isCrmManager) {
      paramsPart.push(req.user.id);
      condsPart.push(`p.manager_id = $${paramsPart.length}`);
    } else if (assigned_to) {
      paramsPart.push(assigned_to);
      condsPart.push(`p.manager_id = $${paramsPart.length}`);
    }

    const wherePart = condsPart.length
      ? "WHERE a.type = 'meeting' AND " + condsPart.join(' AND ')
      : "WHERE a.type = 'meeting'";

    const { rows: partnerActs } = await db.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by,
        u.display_name  AS created_by_name,
        'partner'       AS source_type,
        p.id            AS source_id,
        p.company       AS source_name,
        mu.display_name AS assigned_to_name,
        mu.id           AS assigned_to_id
      FROM crm_partner_activities a
      JOIN crm_partners p   ON p.id  = a.partner_id
      LEFT JOIN users u     ON u.id  = a.created_by
      LEFT JOIN users mu    ON mu.id = p.manager_id
      ${wherePart}
      ORDER BY a.activity_at DESC
    `, paramsPart);

    res.json([...leadActs, ...partnerActs].sort((a, b) =>
      new Date(a.activity_at).getTime() - new Date(b.activity_at).getTime()
    ));
  } catch (err) { next(err); }
});




router.get('/report',
  crmScope,
  [
    query('date_from').optional().isDate(),
    query('date_to').optional().isDate(),
    query('period_end').optional().isDate(),   // pełny koniec okresu dla close_date
    query('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Kursy walut z app_settings (pkt 10/11)
      const { rows: rateRows } = await db.query(
        `SELECT key, value::numeric AS rate FROM app_settings
         WHERE key IN ('exchange_rate_eur','exchange_rate_usd','exchange_rate_gbp','exchange_rate_chf')`
      );
      const rates = { EUR: 4.25, USD: 3.90, GBP: 4.90, CHF: 4.20 };
      for (const r of rateRows) {
        if (r.key === 'exchange_rate_eur') rates.EUR = Number(r.rate);
        if (r.key === 'exchange_rate_usd') rates.USD = Number(r.rate);
        if (r.key === 'exchange_rate_gbp') rates.GBP = Number(r.rate);
        if (r.key === 'exchange_rate_chf') rates.CHF = Number(r.rate);
      }
      // Wyrażenie SQL przeliczające wartość leada na PLN wg kursów
      const valPln = `(CASE COALESCE(l.annual_turnover_currency,'PLN')
        WHEN 'EUR' THEN COALESCE(l.value_pln,0) * ${rates.EUR}
        WHEN 'USD' THEN COALESCE(l.value_pln,0) * ${rates.USD}
        WHEN 'GBP' THEN COALESCE(l.value_pln,0) * ${rates.GBP}
        WHEN 'CHF' THEN COALESCE(l.value_pln,0) * ${rates.CHF}
        ELSE COALESCE(l.value_pln,0) END)`;

      const conditions = [];
      const params     = [];

      // Scope: salesperson widzi tylko swoje
      if (!req.isCrmManager) {
        params.push(req.user.id);
        conditions.push(`l.assigned_to = $${params.length}`);
      }
      // Filtr okresu
      if (req.query.date_from) {
        params.push(req.query.date_from);
        conditions.push(`DATE(l.created_at) >= $${params.length}`);
      }
      if (req.query.date_to) {
        params.push(req.query.date_to);
        conditions.push(`DATE(l.created_at) <= $${params.length}`);
      }
      // Manager może filtrować po konkretnym handlowcu
      if (req.query.assigned_to && req.isCrmManager) {
        params.push(req.query.assigned_to);
        conditions.push(`l.assigned_to = $${params.length}`);
      }

      const where    = conditions.length ? 'WHERE '    + conditions.join(' AND ') : '';
      const andWhere = conditions.length ? ' AND '     + conditions.join(' AND ') : '';

      // Daty zamknięcia dla pipeline_in_period (pkt 9)
      // period_end = pełny koniec okresu (np. 31.03 dla Q1), nie przycięty do dziś
      const closeDateFrom = req.query.date_from  ? `'${req.query.date_from}'`  : 'NULL';
      const closeDateTo   = req.query.period_end ? `'${req.query.period_end}'`
                          : req.query.date_to    ? `'${req.query.date_to}'`    : 'NULL';

      const [kpiRes, funnelRes, monthlyRes, byRepRes, bySourceRes, lostRes] = await Promise.all([

        // KPI zbiorcze — wartości przeliczane na PLN wg kursów walut
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE l.stage NOT IN ('closed_won','closed_lost'))::int    AS active,
            COUNT(*) FILTER (WHERE l.stage = 'closed_won')::int                         AS won,
            COUNT(*) FILTER (WHERE l.stage = 'closed_lost')::int                        AS lost,
            COUNT(*) FILTER (WHERE l.hot = true AND l.stage NOT IN ('closed_won','closed_lost'))::int AS hot,
            COALESCE(SUM(${valPln}) FILTER (WHERE l.stage NOT IN ('closed_won','closed_lost')),0)::numeric(14,2) AS pipeline_value,
            COALESCE(SUM(${valPln}) FILTER (WHERE l.stage = 'closed_won'),0)::numeric(14,2)                      AS won_value,
            ROUND(100.0 * COUNT(*) FILTER (WHERE l.stage = 'closed_won') /
              NULLIF(COUNT(*) FILTER (WHERE l.stage IN ('closed_won','closed_lost')),0))::int AS win_rate,
            ROUND(AVG(EXTRACT(DAY FROM (l.updated_at - l.created_at)))
              FILTER (WHERE l.stage IN ('closed_won','closed_lost')))::int                    AS avg_cycle_days,
            -- pipeline_in_period: leady aktywne z close_date w wybranym przedziale (pkt 9)
            COALESCE(SUM(${valPln}) FILTER (
              WHERE l.stage NOT IN ('closed_won','closed_lost')
                AND l.close_date IS NOT NULL
                AND (${closeDateFrom} IS NULL OR l.close_date >= ${closeDateFrom}::date)
                AND (${closeDateTo}   IS NULL OR l.close_date <= ${closeDateTo}::date)
            ),0)::numeric(14,2) AS pipeline_in_period
          FROM crm_leads l ${where}
        `, params),

        // Lejek per etap
        db.query(`
          SELECT l.stage,
                 COUNT(*)::int                                   AS count,
                 COALESCE(SUM(${valPln}),0)::numeric(14,2)   AS value
          FROM crm_leads l ${where}
          GROUP BY l.stage
          ORDER BY CASE l.stage
            WHEN 'new' THEN 1 WHEN 'qualification' THEN 2 WHEN 'presentation' THEN 3
            WHEN 'offer' THEN 4 WHEN 'negotiation' THEN 5 WHEN 'closed_won' THEN 6
            WHEN 'closed_lost' THEN 7 ELSE 8 END
        `, params),

        // Trend miesięczny (12 ostatnich miesięcy)
        db.query(`
          SELECT TO_CHAR(l.created_at,'YYYY-MM') AS month,
                 COUNT(*)::int                                                              AS new_leads,
                 COUNT(*) FILTER (WHERE l.stage = 'closed_won')::int                       AS won,
                 COUNT(*) FILTER (WHERE l.stage = 'closed_lost')::int                      AS lost,
                 COALESCE(SUM(${valPln}) FILTER (WHERE l.stage = 'closed_won'),0)::numeric(14,2) AS won_value
          FROM crm_leads l ${where}
          GROUP BY month
          ORDER BY month ASC
          LIMIT 13
        `, params),

        // Wyniki handlowców (tylko manager widzi wszystkich)
        req.isCrmManager
          ? db.query(`
              SELECT COALESCE(u.display_name,'— nieprzypisany —') AS rep_name,
                     u.id AS rep_id,
                     COUNT(*)::int                                                                     AS total,
                     COUNT(*) FILTER (WHERE l.stage NOT IN ('closed_won','closed_lost'))::int         AS active,
                     COUNT(*) FILTER (WHERE l.stage = 'closed_won')::int                             AS won,
                     COUNT(*) FILTER (WHERE l.stage = 'closed_lost')::int                            AS lost,
                     COALESCE(SUM(${valPln}) FILTER (WHERE l.stage NOT IN ('closed_won','closed_lost')),0)::numeric(14,2) AS pipeline_value,
                     COALESCE(SUM(${valPln}) FILTER (WHERE l.stage = 'closed_won'),0)::numeric(14,2) AS won_value,
                     ROUND(100.0 * COUNT(*) FILTER (WHERE l.stage = 'closed_won') /
                       NULLIF(COUNT(*) FILTER (WHERE l.stage IN ('closed_won','closed_lost')),0))::int AS win_rate,
                     ROUND(AVG(EXTRACT(DAY FROM (l.updated_at - l.created_at)))
                       FILTER (WHERE l.stage IN ('closed_won','closed_lost')))::int AS avg_cycle_days
              FROM crm_leads l
              LEFT JOIN users u ON u.id = l.assigned_to
              ${where}
              GROUP BY u.display_name, u.id
              ORDER BY won_value DESC NULLS LAST
            `, params)
          : Promise.resolve({ rows: [] }),

        // Kanały (źródła leadów)
        db.query(`
          SELECT COALESCE(l.source,'inne') AS source,
                 COUNT(*)::int                                                  AS count,
                 COUNT(*) FILTER (WHERE l.stage = 'closed_won')::int           AS won_count,
                 COALESCE(SUM(l.value_pln) FILTER (WHERE l.stage='closed_won'),0)::numeric(14,2) AS won_value
          FROM crm_leads l ${where}
          GROUP BY l.source
          ORDER BY count DESC
        `, params),

        // Przyczyny porażek
        db.query(`
          SELECT COALESCE(l.lost_reason,'— brak powodu —') AS reason,
                 COUNT(*)::int AS count
          FROM crm_leads l
          WHERE l.stage = 'closed_lost' ${andWhere}
          GROUP BY l.lost_reason
          ORDER BY count DESC
          LIMIT 10
        `, params),
      ]);

      res.json({
        kpi:          { ...(kpiRes.rows[0] || {}), pipeline_in_period: kpiRes.rows[0]?.pipeline_in_period ?? 0 },
        funnel:       funnelRes.rows,
        monthly:      monthlyRes.rows,
        by_rep:       byRepRes.rows,
        by_source:    bySourceRes.rows,
        lost_reasons: lostRes.rows,
      });
    } catch (err) { next(err); }
  }
);



// ── GET /api/crm/leads/contact-suggestions ─────────────────────────────────
// Zwraca listę sugestii emaili do uzupełniania uczestników spotkania.
// Łączy: email userów, email z leada (lub partnera).


router.get('/:id',
  crmScope,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const params = [parseInt(req.params.id)];
      const scopeWhere = req.scopeFilter('l', 'assigned_to', params);

      const { rows } = await db.query(`
        SELECT l.*,
          u.display_name AS assigned_to_name,
          u.email        AS assigned_to_email,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',a.id,'type',a.type,'title',a.title,'body',a.body,
              'activity_at',a.activity_at,'duration_min',a.duration_min,
              'participants',a.participants,'meeting_location',a.meeting_location,'created_by_name',au.display_name
            )) FILTER (WHERE a.id IS NOT NULL), '[]'
          ) AS activities,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',ld.id,'document_id',ld.document_id,'doc_role',ld.doc_role,'linked_at',ld.linked_at
            )) FILTER (WHERE ld.id IS NOT NULL), '[]'
          ) AS linked_documents
        FROM crm_leads l
        LEFT JOIN users u  ON u.id = l.assigned_to
        LEFT JOIN crm_lead_activities a ON a.lead_id = l.id
        LEFT JOIN users au ON au.id = a.created_by
        LEFT JOIN crm_lead_documents ld ON ld.lead_id = l.id
        WHERE l.id = $1 ${scopeWhere}
        GROUP BY l.id, u.display_name, u.email
      `, params);

      if (!rows.length) return res.status(404).json({ error: 'Lead nie znaleziony' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/crm/leads/:id ──────────────────────────────────────
router.patch('/:id',
  [
    param('id').isInt(),
    body('company').optional().notEmpty().trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('stage').optional().isIn(['new','qualification','presentation','offer','negotiation','closed_won','closed_lost']),
    body('value_pln').optional({ nullable: true }).isFloat({ min: 0 }),
    body('annual_turnover_currency').optional({ nullable: true }).isString(),
    body('online_pct').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('probability').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('assigned_to').optional().isUUID(),
    body('hot').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: existing } = await db.query('SELECT * FROM crm_leads WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      try { assertOwnership(existing[0], req, 'assigned_to'); }
      catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

      // Handlowiec nie może reassignować
      if (!req.isCrmManager) delete req.body.assigned_to;

      const allowed = ['company','contact_name','contact_title','email','phone','source',
                       'stage','value_pln','annual_turnover_currency','online_pct','probability','close_date','industry',
                       'assigned_to','tags','notes','hot','lost_reason'];

      const setClauses = [];
      const params     = [];
      let   p          = 1;

      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          setClauses.push(`${field} = $${p++}`);
          params.push(req.body[field]);
        }
      }
      if (!setClauses.length) return res.status(400).json({ error: 'Brak pól do aktualizacji' });

      setClauses.push(`updated_at = $${p++}`);
      params.push(new Date());
      params.push(id);

      const { rows } = await db.query(
        `UPDATE crm_leads SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      );

      await audit.log({
        user:        req.user,
        action:      'crm_lead_update',
        beforeState: Object.fromEntries(allowed.filter(f => req.body[f] !== undefined).map(f => [f, existing[0][f]])),
        afterState:  req.body,
        metadata:    { lead_id: id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/leads/:id ─────────────────────────────────────
router.delete('/:id',
  requireCrmManager,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: existing } = await db.query('SELECT company FROM crm_leads WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      await db.query('DELETE FROM crm_leads WHERE id=$1', [id]);

      await audit.log({
        user:        req.user,
        action:      'crm_lead_delete',
        beforeState: { company: existing[0].company },
        metadata:    { lead_id: id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Aktywności ─────────────────────────────────────────────────────
router.get('/:id/activities',
  crmScope,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const params = [id];
      const scope = req.scopeFilter('l', 'assigned_to', params);

      const { rows: lead } = await db.query(
        `SELECT id FROM crm_leads l WHERE l.id = $1 ${scope}`, params
      );
      if (!lead.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      const { rows } = await db.query(`
        SELECT a.*, u.display_name AS created_by_name
        FROM crm_lead_activities a
        LEFT JOIN users u ON u.id = a.created_by
        WHERE a.lead_id = $1
        ORDER BY a.activity_at DESC
      `, [id]);

      res.json(rows);
    } catch (err) { next(err); }
  }
);

router.post('/:id/activities',
  [
    param('id').isInt(),
    body('type').notEmpty().isIn(['call','email','meeting','note','doc_sent']),
    body('title').notEmpty().trim(),
    body('body').optional().trim(),
    body('activity_at').optional().isISO8601(),
    body('duration_min').optional({ nullable: true }).isInt({ min: 0 }),
    body('participants').optional().trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { type, title, body: bodyText, activity_at, duration_min, participants, meeting_location } = req.body;

      const { rows } = await db.query(`
        INSERT INTO crm_lead_activities
          (lead_id, type, title, body, activity_at, duration_min, participants, meeting_location, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *, (SELECT display_name FROM users WHERE id = created_by) AS created_by_name
      `, [id, type, title, bodyText||null, activity_at||new Date(),
          duration_min||null, participants||null, meeting_location||null, req.user.id]);

      await db.query('UPDATE crm_leads SET updated_at=now() WHERE id=$1', [id]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);


// ── PATCH /api/crm/leads/:id/activities/:actId ─────────────────────
router.patch('/:id/activities/:actId',
  [
    param('id').isInt(),
    param('actId').isInt(),
    body('type').optional().isIn(['call','email','meeting','note','doc_sent']),
    body('title').optional().notEmpty().trim(),
    body('body').optional({ nullable: true }).trim(),
    body('activity_at').optional().isISO8601(),
    body('participants').optional({ nullable: true }).trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const leadId = parseInt(req.params.id);
      const actId  = parseInt(req.params.actId);
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_lead_activities WHERE id=$1 AND lead_id=$2',
        [actId, leadId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Aktywność nie znaleziona' });
      const act = existing[0];
      if (act.created_by !== req.user.id && !req.isCrmManager) {
        return res.status(403).json({ error: 'Brak uprawnień do edycji tej aktywności' });
      }
      const type             = req.body.type             ?? act.type;
      const title            = req.body.title            ?? act.title;
      const body             = req.body.body             !== undefined ? req.body.body : act.body;
      const activity_at      = req.body.activity_at      ?? act.activity_at;
      const participants     = req.body.participants     !== undefined ? req.body.participants : act.participants;
      const meeting_location = req.body.meeting_location !== undefined ? req.body.meeting_location : act.meeting_location;
      const { rows } = await db.query(`
        UPDATE crm_lead_activities
        SET type=$1, title=$2, body=$3, activity_at=$4, participants=$5, meeting_location=$6, updated_at=now()
        WHERE id=$7
        RETURNING *, (SELECT display_name FROM users WHERE id = created_by) AS created_by_name
      `, [type, title, body||null, activity_at, participants||null, meeting_location||null, actId]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/leads/:id/activities/:actId ─────────────────────
router.delete('/:id/activities/:actId',
  [param('id').isInt(), param('actId').isInt()], validate,
  async (req, res, next) => {
    try {
      const leadId = parseInt(req.params.id);
      const actId  = parseInt(req.params.actId);
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_lead_activities WHERE id=$1 AND lead_id=$2',
        [actId, leadId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Aktywność nie znaleziona' });
      if (existing[0].created_by !== req.user.id && !req.isCrmManager) {
        return res.status(403).json({ error: 'Brak uprawnień' });
      }
      await db.query('DELETE FROM crm_lead_activities WHERE id=$1', [actId]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Dokumenty ──────────────────────────────────────────────────────
router.get('/:id/documents', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT ld.*, d.name AS document_title, d.status AS document_status, d.doc_number
      FROM crm_lead_documents ld
      LEFT JOIN documents d ON d.id = ld.document_id
      WHERE ld.lead_id = $1
      ORDER BY ld.linked_at DESC
    `, [parseInt(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/documents',
  [param('id').isInt(), body('document_id').isInt(), body('doc_role').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(`
        INSERT INTO crm_lead_documents (lead_id, document_id, doc_role, linked_by)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (lead_id, document_id) DO UPDATE SET doc_role = EXCLUDED.doc_role
        RETURNING *
      `, [parseInt(req.params.id), req.body.document_id, req.body.doc_role||null, req.user.id]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.delete('/:id/documents/:docId',
  [param('id').isInt(), param('docId').isInt()], validate,
  async (req, res, next) => {
    try {
      await db.query('DELETE FROM crm_lead_documents WHERE lead_id=$1 AND document_id=$2',
        [parseInt(req.params.id), parseInt(req.params.docId)]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Konwersja Lead → Partner ──────────────────────────────────────
router.post('/:id/convert',
  [
    param('id').isInt(),
    body('contract_doc_id').optional({ nullable: true }).isInt(),
    body('contract_signed').optional({ nullable: true }).isDate(),
    body('contract_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('group_id').optional({ nullable: true }).isInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: leads } = await db.query('SELECT * FROM crm_leads WHERE id=$1', [id]);
      if (!leads.length) return res.status(404).json({ error: 'Lead nie znaleziony' });
      const lead = leads[0];

      try { assertOwnership(lead, req, 'assigned_to'); }
      catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

      if (lead.converted_at) return res.status(409).json({ error: 'Lead już skonwertowany' });

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: partner } = await client.query(`
          INSERT INTO crm_partners
            (company, contact_name, contact_title, email, phone, industry,
             lead_id, group_id, manager_id, contract_doc_id, contract_signed,
             contract_value, notes, created_by, status,
             annual_turnover_currency, online_pct, tags)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'onboarding',$15,$16,$17)
          RETURNING *
        `, [
          lead.company, lead.contact_name, lead.contact_title, lead.email,
          lead.phone, lead.industry, id,
          req.body.group_id||null, lead.assigned_to,
          req.body.contract_doc_id||null, req.body.contract_signed||null,
          req.body.contract_value||null, lead.notes, req.user.id,
          lead.annual_turnover_currency||'PLN',
          lead.online_pct||null, lead.tags||[],
        ]);

        await client.query(
          `UPDATE crm_leads SET converted_at=now(), stage='closed_won', updated_at=now() WHERE id=$1`, [id]
        );

        await client.query('COMMIT');

        await audit.log({
          user:      req.user,
          action:    'crm_lead_converted',
          afterState: { lead_id: id, partner_id: partner[0].id, company: lead.company },
          ipAddress: req.auditContext?.ipAddress,
        });

        res.status(201).json({ lead_id: id, partner: partner[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  }
);

// ── GET /api/crm/leads/report ─────────────────────────────────────────────────
// Kompleksowy raport leadów: KPI, lejek, trend, handlowcy, kanały, porażki
// Zakres: salesperson widzi tylko swoje leady, manager widzi wszystkich (lub filtr)
// query: date_from (YYYY-MM-DD), date_to, assigned_to (UUID, tylko manager)
module.exports = router;
