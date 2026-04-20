'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-leads.js
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const db     = require('../config/database');
const audit  = require('../services/auditService');
const logger = require('../utils/logger');
const { requireAuth }                     = require('../middleware/auth');
const { validate, injectAuditContext }    = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope, crmScope, requireCrmManager, assertOwnership } = require('../middleware/crm-rbac');
const testAccountSvc = require('../services/testAccountService');
const email          = require('../utils/email');

router.use(requireAuth, injectAuditContext, crmAuth, loadCrmScope);

// ── GET /api/crm/leads ────────────────────────────────────────────
router.get('/',
  crmScope,
  [
    query('stage').optional().isString(),
    query('source').optional().isString().trim(),
    query('assigned_to').optional().isString().trim(),
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
      let where = "WHERE 1=1";

      where += req.scopeFilter('l', 'assigned_to', params);

      if (req.query.stage) {
        params.push(req.query.stage);
        where += ` AND l.stage = $${params.length}`;
      }
      if (req.query.source) {
        // Może być pojedyncza wartość lub lista oddzielona przecinkami (filtr grupy)
        const srcValues = String(req.query.source).split(',').map(s => s.trim()).filter(Boolean);
        if (srcValues.length === 1) {
          params.push(srcValues[0]);
          where += ` AND l.source = $${params.length}`;
        } else {
          params.push(srcValues);
          where += ` AND l.source = ANY($${params.length}::text[])`;
        }
      }
      if (req.query.assigned_to && req.isCrmManager) {
        const assignedIds = String(req.query.assigned_to).split(',').map(s => s.trim()).filter(Boolean);
        if (assignedIds.length === 1) {
          params.push(assignedIds[0]);
          where += ` AND l.assigned_to = $${params.length}`;
        } else if (assignedIds.length > 1) {
          params.push(assignedIds);
          where += ` AND l.assigned_to = ANY($${params.length}::uuid[])`;
        }
      }
      if (req.query.hot === true) {
        where += ` AND l.hot = true`;
      }
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        where += ` AND (l.company ILIKE $${params.length} OR l.contact_name ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.nip ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR l.notes ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE t ILIKE $${params.length}))`;
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
            cp.id          AS converted_partner_id,
            cp.company     AS converted_partner_company,
            (SELECT COUNT(*) FROM crm_lead_activities a WHERE a.lead_id = l.id) AS activity_count,
            (SELECT COUNT(*) FROM crm_lead_documents  d WHERE d.lead_id = l.id) AS document_count,
            (SELECT COUNT(*) FROM crm_lead_activities WHERE lead_id = l.id AND type = 'email')::int AS email_count
          FROM crm_leads l
          LEFT JOIN users u ON u.id = l.assigned_to
          LEFT JOIN crm_partners cp ON cp.lead_id = l.id
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
    body('first_contact_date').optional({ nullable: true }).isDate(),
    body('nip').optional({ nullable: true }).trim(),
    body('first_contact_date').optional({ nullable: true }).isDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        company, contact_name, contact_title, email, phone, source,
        stage = 'new', value_pln, annual_turnover_currency, online_pct, probability, close_date, industry,
        assigned_to, tags, notes, hot = false, nip,
      } = req.body;

      // Handlowiec może przypisać tylko do siebie
      const ownerId = req.isCrmManager ? (assigned_to || req.user.id) : req.user.id;

      // Sprawdź unikalność NIP w leadach i partnerach
      if (nip) {
        const { rows: nipCheck } = await db.query(
          `SELECT 'lead' AS src FROM crm_leads WHERE nip = $1
           UNION ALL SELECT 'partner' AS src FROM crm_partners WHERE nip = $1
           LIMIT 1`,
          [nip]
        );
        if (nipCheck.length) {
          return res.status(409).json({ error: 'Ten Numer NIP jest już przypisany dla innego rekordu.' });
        }
      }

      const { rows } = await db.query(`
        INSERT INTO crm_leads
          (company, contact_name, contact_title, email, phone, source, stage,
           value_pln, annual_turnover_currency, online_pct, probability, close_date, industry, assigned_to,
           tags, notes, hot, nip, created_by, agent_name, agent_email, agent_phone,
           website, logo_url, first_contact_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        RETURNING *
      `, [
        company, contact_name||null, contact_title||null, email||null,
        phone||null, source||null, stage,
        value_pln||null, annual_turnover_currency||'PLN', online_pct||null, probability||null, close_date||null, industry||null,
        ownerId, tags||[], notes||null, hot, nip||null, req.user.id,
        req.body.agent_name||null, req.body.agent_email||null, req.body.agent_phone||null,
        req.body.website||null, req.body.logo_url||null,
        req.body.first_contact_date||null,
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
        AND crm_role IN ('salesperson', 'sales_manager')
        AND is_admin = false
      ORDER BY display_name
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/leads/groups ─────────────────────────────────────
// Zwraca aktywne grupy wraz z listą przypisanych userów (user_ids[]).
// Używane do filtra handlowiec/grupa na liście leadów — tylko dla managerów.
router.get('/groups', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT gp.id, gp.name, array_agg(ugr.user_id::text ORDER BY ugr.user_id) AS user_ids
      FROM group_profiles gp
      JOIN user_group_roles ugr ON ugr.group_id = gp.id
      WHERE gp.is_active = TRUE
      GROUP BY gp.id, gp.name
      ORDER BY gp.name
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/leads/sources — słownik źródeł z app_settings ──
router.get('/sources', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT value FROM app_settings WHERE key = 'crm_lead_sources'`
    );
    let sources = [];
    if (rows.length) {
      try {
        const parsed = JSON.parse(rows[0].value);
        // Nowy format: tablica obiektów {value, label, group}
        if (parsed.length && typeof parsed[0] === 'object') {
          sources = parsed;
        } else {
          // Stary format: tablica stringów — fallback
          sources = parsed.map(k => ({ value: k, label: k, group: null }));
        }
      } catch(e) { sources = []; }
    }
    if (!sources.length) {
      sources = [
        { value: 'Własne',             label: 'Własne',               group: null },
        { value: 'Cold_Call',          label: 'Cold Call',            group: null },
        { value: 'Partner',            label: 'Partner',              group: null },
        { value: 'Ajent',              label: 'Agent',                group: null },
        { value: 'LinkedIn_Lead_Form', label: 'LinkedIn Lead Form',   group: 'Marketing' },
        { value: 'Formularz_online',   label: 'Formularz online',     group: 'Marketing' },
      ];
    }
    res.json(sources);
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


// ── GET /api/crm/leads/tasks ─────────────────────────────────────────────────
// Zwraca wszystkie aktywności (poza email) do widoku "Zadania"
// query: assigned_to (UUID), type (string), include_closed (bool)
router.get('/tasks', async (req, res, next) => {
  try {
    const { assigned_to, type, include_closed, include_no_date } = req.query;
    const showClosed  = include_closed  === 'true';
    const includeNoDate = include_no_date === 'true';

    const conds  = ["a.type != 'email'"];
    const params = [];

    if (!showClosed)    conds.push("a.status != 'closed'");
    if (!includeNoDate) conds.push("a.activity_at IS NOT NULL");
    if (type) { params.push(type); conds.push(`a.type = $${params.length}`); }

    // Scope — kto widzi które aktywności
    // assigned_to może być pojedynczym UUID lub listą rozdzieloną przecinkami (filtr po grupie)
    const assignedIds = assigned_to ? assigned_to.split(',').map(s => s.trim()).filter(Boolean) : [];
    const pushAssignedFilter = (col) => {
      if (assignedIds.length === 1) {
        params.push(assignedIds[0]); conds.push(`${col} = $${params.length}`);
      } else {
        params.push(assignedIds); conds.push(`${col} = ANY($${params.length}::uuid[])`);
      }
    };
    if (req.user.is_admin) {
      if (assignedIds.length) pushAssignedFilter('COALESCE(a.assigned_to, l.assigned_to)');
    } else if (req.user.crm_role === 'sales_manager') {
      if (assignedIds.length) {
        pushAssignedFilter('COALESCE(a.assigned_to, l.assigned_to)');
      } else if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        params.push(req.crmScopeUserIds); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = ANY($${params.length}::uuid[])`);
      } else { conds.push('1=0'); }
    } else {
      params.push(req.user.id); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = $${params.length}`);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    const { rows } = await db.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by, a.status, a.close_comment,
        a.updated_at,
        u.display_name  AS created_by_name,
        'lead'          AS source_type,
        l.id            AS source_id,
        l.company       AS source_name,
        lu.display_name AS assigned_to_name,
        lu.id           AS assigned_to_id,
        au.display_name AS act_assigned_to_name,
        a.assigned_to   AS act_assigned_to_id
      FROM crm_lead_activities a
      JOIN crm_leads l      ON l.id   = a.lead_id
      LEFT JOIN users u     ON u.id   = a.created_by
      LEFT JOIN users lu    ON lu.id  = l.assigned_to
      LEFT JOIN users au    ON au.id  = a.assigned_to
      ${where}
      ORDER BY
        CASE WHEN a.activity_at IS NULL THEN 1 ELSE 0 END,
        a.activity_at ASC
    `, params);

    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/leads/calendar ────────────────────────────────────────────
// Zwraca aktywności typu "meeting" dla kalendarza (leady + partnerzy)
// query: date_from (YYYY-MM-DD), date_to, assigned_to (UUID, tylko manager)

router.get('/calendar', async (req, res, next) => {
  try {
    const { date_from, date_to, assigned_to } = req.query;

    // ── Lead activities ──────────────────────────────────────────────────────
    const conds  = ["a.type != 'email'", "a.activity_at IS NOT NULL"];
    const params = [];

    if (date_from) { params.push(date_from); conds.push(`a.activity_at >= $${params.length}::date`); }
    if (date_to)   { params.push(date_to);   conds.push(`a.activity_at <  ($${params.length}::date + interval '1 day')`); }

    if (req.user.is_admin) {
      if (assigned_to) { params.push(assigned_to); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = $${params.length}`); }
    } else if (req.user.crm_role === 'sales_manager') {
      if (assigned_to) {
        params.push(assigned_to); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = $${params.length}`);
      } else if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        params.push(req.crmScopeUserIds); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = ANY($${params.length}::uuid[])`);
      } else { conds.push('1=0'); }
    } else {
      params.push(req.user.id); conds.push(`COALESCE(a.assigned_to, l.assigned_to) = $${params.length}`);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    const { rows: leadActs } = await db.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by, a.status, a.close_comment,
        u.display_name  AS created_by_name,
        'lead'          AS source_type,
        l.id            AS source_id,
        l.company       AS source_name,
        lu.display_name AS assigned_to_name,
        lu.id           AS assigned_to_id,
        au.display_name AS act_assigned_to_name,
        a.assigned_to   AS act_assigned_to_id
      FROM crm_lead_activities a
      JOIN crm_leads l      ON l.id   = a.lead_id
      LEFT JOIN users u     ON u.id   = a.created_by
      LEFT JOIN users lu    ON lu.id  = l.assigned_to
      LEFT JOIN users au    ON au.id  = a.assigned_to
      ${where}
      ORDER BY a.activity_at
    `, params);

    // ── Partner activities ───────────────────────────────────────────────────
    const condsPart  = ["a.type != 'email'", "a.activity_at IS NOT NULL"];
    const paramsPart = [];

    if (date_from) { paramsPart.push(date_from); condsPart.push(`a.activity_at >= $${paramsPart.length}::date`); }
    if (date_to)   { paramsPart.push(date_to);   condsPart.push(`a.activity_at <  ($${paramsPart.length}::date + interval '1 day')`); }

    if (req.user.is_admin) {
      if (assigned_to) { paramsPart.push(assigned_to); condsPart.push(`COALESCE(a.assigned_to, p.manager_id) = $${paramsPart.length}`); }
    } else if (req.user.crm_role === 'sales_manager') {
      if (assigned_to) {
        paramsPart.push(assigned_to); condsPart.push(`COALESCE(a.assigned_to, p.manager_id) = $${paramsPart.length}`);
      } else if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        paramsPart.push(req.crmScopeUserIds); condsPart.push(`COALESCE(a.assigned_to, p.manager_id) = ANY($${paramsPart.length}::uuid[])`);
      } else { condsPart.push('1=0'); }
    } else {
      paramsPart.push(req.user.id); condsPart.push(`COALESCE(a.assigned_to, p.manager_id) = $${paramsPart.length}`);
    }

    const wherePart = 'WHERE ' + condsPart.join(' AND ');

    const { rows: partnerActs } = await db.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by, a.status, a.close_comment,
        u.display_name  AS created_by_name,
        'partner'       AS source_type,
        p.id            AS source_id,
        p.company       AS source_name,
        mu.display_name AS assigned_to_name,
        mu.id           AS assigned_to_id,
        au.display_name AS act_assigned_to_name,
        a.assigned_to   AS act_assigned_to_id
      FROM crm_partner_activities a
      JOIN crm_partners p   ON p.id   = a.partner_id
      LEFT JOIN users u     ON u.id   = a.created_by
      LEFT JOIN users mu    ON mu.id  = p.manager_id
      LEFT JOIN users au    ON au.id  = a.assigned_to
      ${wherePart}
      ORDER BY a.activity_at
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

      // Scope
      if (req.user.is_admin) {
        // admin — bez ograniczeń
      } else if (req.user.crm_role === 'sales_manager') {
        // ekspansja gdy jawny filtr assigned_to; inaczej — scope grupy
        if (!req.query.assigned_to) {
          if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
            params.push(req.crmScopeUserIds);
            conditions.push(`l.assigned_to = ANY($${params.length}::uuid[])`);
          } else { conditions.push('1=0'); }
        }
      } else {
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

      const [kpiRes, funnelRes, monthlyRes, byRepRes, bySourceRes, lostRes, velocityRes] = await Promise.all([

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
            ROUND(AVG(EXTRACT(DAY FROM (l.updated_at - COALESCE(l.first_contact_date::timestamp, l.created_at))))
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
                     ROUND(AVG(EXTRACT(DAY FROM (l.updated_at - COALESCE(l.first_contact_date::timestamp, l.created_at))))
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

        // Czas w etapie — tylko aktywne etapy (bez closed_won / closed_lost)
        // Won i Lost wykluczone — akumulują cały czas od początku i zaburzają skalę
        // Liczony od first_contact_date (lub created_at) do dziś
        db.query(`
          SELECT
            l.stage,
            COUNT(*)::int AS count,
            ROUND(AVG(
              EXTRACT(DAY FROM (
                NOW() - COALESCE(l.first_contact_date::timestamp, l.created_at)
              ))
            ))::int AS avg_days
          FROM crm_leads l
          ${where ? where + " AND l.stage NOT IN ('closed_won','closed_lost')"
                  : "WHERE l.stage NOT IN ('closed_won','closed_lost')"}
          GROUP BY l.stage
          ORDER BY CASE l.stage
            WHEN 'new' THEN 1 WHEN 'qualification' THEN 2 WHEN 'presentation' THEN 3
            WHEN 'offer' THEN 4 WHEN 'negotiation' THEN 5 ELSE 6 END
        `, params),
      ]);

      res.json({
        kpi:           { ...(kpiRes.rows[0] || {}), pipeline_in_period: kpiRes.rows[0]?.pipeline_in_period ?? 0 },
        funnel:        funnelRes.rows,
        monthly:       monthlyRes.rows,
        by_rep:        byRepRes.rows,
        by_source:     bySourceRes.rows,
        lost_reasons:  lostRes.rows,
        stage_velocity: velocityRes.rows,
      });
    } catch (err) { next(err); }
  }
);



// ── GET /api/crm/leads/contact-suggestions ─────────────────────────────────
// Zwraca listę sugestii emaili do uzupełniania uczestników spotkania.
// Łączy: email userów, email z leada (lub partnera).


// ── POST /api/crm/leads/enrich ── scrape + logo blob ─────────────
// MUST be before /:id routes
router.post('/enrich',
  [body('domain').notEmpty().trim()], validate,
  async (req, res, next) => {
    const https  = require('https');
    const http   = require('http');
    const { URL: NURL } = require('url');
    const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
    const config = require('../config');

    function normaliseDomain(d) {
      d = d.trim().replace(/^https?:\/\//i,'').split('/')[0].toLowerCase();
      if (!d.includes('.')) d += '.pl';
      return d;
    }

    function httpGet(urlStr, opts) {
      opts = opts || {};
      return new Promise(function(resolve, reject) {
        var u;
        try { u = new NURL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr); }
        catch(e) { return reject(e); }
        var mod = u.protocol === 'https:' ? https : http;
        var redirects = opts._r || 0;
        var req2 = mod.get(u.href, {
          timeout: opts.timeout || 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': opts.accept || 'text/html,*/*' },
        }, function(res2) {
          var loc = res2.headers && res2.headers.location;
          if ([301,302,303,307,308].indexOf(res2.statusCode) >= 0 && loc && redirects < 3) {
            res2.resume();
            return httpGet(loc, Object.assign({}, opts, {_r: redirects+1})).then(resolve).catch(reject);
          }
          var chunks = [];
          res2.on('data', function(c){ chunks.push(c); });
          res2.on('end', function(){ resolve({ status: res2.statusCode, headers: res2.headers, body: Buffer.concat(chunks) }); });
          res2.on('error', reject);
        });
        req2.on('timeout', function(){ req2.destroy(); reject(new Error('timeout')); });
        req2.on('error', reject);
      });
    }

    async function scrape(domain) {
      var result = { company: null, email: null, phone: null, logoUrl: null };
      var html = '';
      try {
        var r = await httpGet('https://' + domain, { timeout: 8000 });
        if (r.status >= 200 && r.status < 400) html = r.body.toString('utf8').slice(0, 200000);
      } catch(e1) {
        try {
          var r2 = await httpGet('http://' + domain, { timeout: 6000 });
          html = r2.body.toString('utf8').slice(0, 200000);
        } catch(e2) { return result; }
      }
      if (!html) return result;

      // Company name
      var tM = html.match(/<title[^>]*>([^<]{2,100})<\/title>/i);
      if (tM) result.company = tM[1].replace(/[|\u2013\-].*$/, '').replace(/\s+/g,' ').trim().slice(0,100);
      var ogN = html.match(/property="og:site_name"[^>]*content="([^"]{2,80})"/i)
             || html.match(/content="([^"]{2,80})"[^>]*property="og:site_name"/i);
      if (ogN) result.company = ogN[1].trim();

      // Logo
      var ogImg   = html.match(/property="og:image"[^>]*content="([^"]{5,})"/i) || html.match(/content="([^"]{5,})"[^>]*property="og:image"/i);
      var appleIc = html.match(/rel="apple-touch-icon"[^>]+href="([^"]+)"/i);
      var favL    = html.match(/rel="(?:shortcut )?icon"[^>]+href="([^"]+)"/i);
      var logoRaw = (ogImg || appleIc || favL || [])[1] || '/favicon.ico';
      result.logoUrl = logoRaw.startsWith('http') ? logoRaw : 'https://' + domain + (logoRaw.startsWith('/') ? '' : '/') + logoRaw;

      // Email
      var emails = (html.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || [])
        .filter(function(e){ return !['example','sentry','google','schema','w3','noreply','privacy'].some(function(x){ return e.includes(x); }); });
      if (emails.length) result.email = emails[0];

      // Phone (Polish)
      var plain = html.replace(/<[^>]+>/g, ' ');
      var phones = plain.match(/(?:\+48[\s\-]?)?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d/g) || [];
      if (phones.length) result.phone = phones[0].replace(/[\s\-]/g,'');

      return result;
    }

    async function uploadLogo(logoUrl) {
      try {
        var r = await httpGet(logoUrl, { accept: 'image/*,*/*', timeout: 5000 });
        if (r.status !== 200 || r.body.length < 100) return null;
        var mime = (r.headers && r.headers['content-type']) || 'image/png';
        var ext = mime.includes('svg') ? '.svg' : mime.includes('webp') ? '.webp' : mime.includes('jp') ? '.jpg' : mime.includes('ico') ? '.ico' : '.png';
        var safeName = logoUrl.replace(/[^a-z0-9]/gi,'_').slice(-40);
        var blobName = 'logos/' + Date.now() + '_' + safeName + ext;
        var blobSvc;
        if (config.storage.connectionString) {
          blobSvc = BlobServiceClient.fromConnectionString(config.storage.connectionString);
        } else {
          blobSvc = new BlobServiceClient(
            'https://' + config.storage.accountName + '.blob.core.windows.net',
            new StorageSharedKeyCredential(config.storage.accountName, config.storage.accountKey)
          );
        }
        var cc = blobSvc.getContainerClient(config.storage.container);
        var bc = cc.getBlockBlobClient(blobName);
        await bc.upload(r.body, r.body.length, { blobHTTPHeaders: { blobContentType: mime } });
        return blobName;
      } catch(e) {
        logger.warn('Logo upload failed', { error: e.message });
        return null;
      }
    }

    try {
      var domain = normaliseDomain(req.body.domain);
      logger.info('Enriching domain', { domain });

      var scraped = await scrape(domain);
      logger.info('Scrape result', { company: scraped.company, email: scraped.email, logoUrl: scraped.logoUrl });

      var logo_blob_path = null;
      if (scraped.logoUrl) {
        logo_blob_path = await uploadLogo(scraped.logoUrl);
        logger.info('Logo upload', { logo_blob_path });
      }

      res.json({
        domain:          domain,
        company:         scraped.company  || null,
        email:           scraped.email    || null,
        phone:           scraped.phone    || null,
        nip:             null,
        regon:           null,
        logo_blob_path:  logo_blob_path,
      });
    } catch(err) { next(err); }
  }
);

router.get('/:id',
  // Bez crmScope — widok szczegółów jest zawsze dostępny (bez blokady 403/404).
  // Uprawnienie do edycji zwracane jest jako pole can_edit w odpowiedzi.
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const params = [parseInt(req.params.id)];

      const { rows } = await db.query(`
        SELECT l.*,
          u.display_name AS assigned_to_name,
          u.email        AS assigned_to_email,
          COALESCE(
            (SELECT json_agg(act ORDER BY act->>'activity_at' DESC NULLS LAST)
             FROM (
               SELECT DISTINCT jsonb_build_object(
                 'id',a.id,'type',a.type,'title',a.title,'body',a.body,
                 'activity_at',a.activity_at,'duration_min',a.duration_min,
                 'participants',a.participants,'meeting_location',a.meeting_location,
                 'created_by',a.created_by,'created_by_name',au.display_name,
                 'assigned_to',a.assigned_to,'assigned_to_name',au2.display_name,
                 'status',a.status,'close_comment',a.close_comment,
                 'gmail_thread_id',a.gmail_thread_id,'gmail_message_id',a.gmail_message_id
               ) AS act
               FROM crm_lead_activities a
               LEFT JOIN users au  ON au.id  = a.created_by
               LEFT JOIN users au2 ON au2.id = a.assigned_to
               WHERE a.lead_id = l.id
             ) sub
            ), '[]'
          ) AS activities,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',ld.id,'document_id',ld.document_id,'doc_role',ld.doc_role,'linked_at',ld.linked_at
            )) FILTER (WHERE ld.id IS NOT NULL), '[]'
          ) AS linked_documents
        FROM crm_leads l
        LEFT JOIN users u  ON u.id = l.assigned_to
        LEFT JOIN crm_lead_documents ld ON ld.lead_id = l.id
        WHERE l.id = $1
        GROUP BY l.id, u.display_name, u.email
      `, params);

      if (!rows.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      // Wyznacz can_edit — admin może zawsze, manager tylko w swojej grupie, handlowiec tylko własne
      const lead = rows[0];
      let can_edit = true;
      if (!req.user.is_admin) {
        if (req.user.crm_role === 'sales_manager') {
          can_edit = !req.crmScopeUserIds || req.crmScopeUserIds.includes(lead.assigned_to);
        } else {
          can_edit = lead.assigned_to === req.user.id;
        }
      }

      // Dodatkowe kontakty
      const { rows: extraContacts } = await db.query(
        `SELECT * FROM crm_lead_contacts WHERE lead_id=$1 ORDER BY created_at`,
        [parseInt(req.params.id)]
      );
      res.json({ ...lead, extra_contacts: extraContacts, can_edit });
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
    body('first_contact_date').optional({ nullable: true }).isDate(),
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

      // Sprawdź unikalność NIP przy aktualizacji (wyklucz własny rekord)
      if (req.body.nip) {
        const { rows: nipCheck } = await db.query(
          `SELECT 'lead' AS src FROM crm_leads WHERE nip = $1 AND id != $2
           UNION ALL SELECT 'partner' AS src FROM crm_partners WHERE nip = $1
           LIMIT 1`,
          [req.body.nip, id]
        );
        if (nipCheck.length) {
          return res.status(409).json({ error: 'Ten Numer NIP jest już przypisany dla innego rekordu.' });
        }
      }

      const allowed = ['company','contact_name','contact_title','email','phone','source',
                       'stage','value_pln','annual_turnover_currency','online_pct','probability','close_date','industry',
                       'assigned_to','tags','notes','hot','lost_reason','nip',
                       'agent_name','agent_email','agent_phone','website','logo_url','first_contact_date'];

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
    body('activity_at').optional({ nullable: true }).isISO8601(),
    body('duration_min').optional({ nullable: true }).isInt({ min: 0 }),
    body('participants').optional().trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
    body('assigned_to').optional({ nullable: true }).isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { type, title, body: bodyText, activity_at, duration_min, participants, meeting_location, assigned_to } = req.body;

      const { rows } = await db.query(`
        INSERT INTO crm_lead_activities
          (lead_id, type, title, body, activity_at, duration_min, participants, meeting_location, assigned_to, created_by, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new')
        RETURNING *,
          (SELECT display_name FROM users WHERE id = created_by) AS created_by_name,
          (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name
      `, [id, type, title, bodyText||null,
          activity_at||null,
          duration_min||null, participants||null, meeting_location||null,
          assigned_to||null, req.user.id]);

      await db.query('UPDATE crm_leads SET updated_at=now() WHERE id=$1', [id]);
      await audit.log({
        user:       req.user,
        action:     'crm_activity_create',
        afterState: { type, title, assigned_to: assigned_to||null, activity_at: activity_at||null },
        metadata:   { lead_id: id, activity_id: rows[0].id, source: 'lead' },
        ipAddress:  req.auditContext?.ipAddress,
      });

      // Powiadomienie email — tylko gdy przypisano do innego usera niż twórca
      if (assigned_to && assigned_to !== req.user.id) {
        try {
          const { rows: assigneeRows } = await db.query(
            'SELECT email, display_name FROM users WHERE id=$1', [assigned_to]
          );
          const { rows: leadRows } = await db.query(
            'SELECT company FROM crm_leads WHERE id=$1', [id]
          );
          if (assigneeRows.length && assigneeRows[0].email) {
            await email.sendCrmActivityAssigned({
              to:            assigneeRows[0].email,
              assigneeName:  assigneeRows[0].display_name || assigneeRows[0].email,
              assignerName:  req.user.display_name || req.user.email,
              activityType:  type,
              activityTitle: title,
              activityAt:    activity_at || null,
              sourceName:    leadRows[0]?.company || `Lead #${id}`,
              sourceType:    'lead',
              sourceId:      id,
            });
          }
        } catch (emailErr) {
          logger.warn('Błąd wysyłki emaila o przypisaniu aktywności', { error: emailErr.message });
        }
      }

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
    body('activity_at').optional({ nullable: true }),
    body('participants').optional({ nullable: true }).trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
    body('assigned_to').optional({ nullable: true }),
    body('status').optional().isIn(['new','open','closed']),
    body('close_comment').optional({ nullable: true }).trim(),
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
      const isAssigned = act.assigned_to === req.user.id;
      if (act.created_by !== req.user.id && !req.isCrmManager && !isAssigned) {
        return res.status(403).json({ error: 'Brak uprawnień do edycji tej aktywności' });
      }

      const newStatus = req.body.status ?? act.status;
      // Closing requires a comment
      if (newStatus === 'closed' && !req.body.close_comment && !act.close_comment) {
        return res.status(400).json({ error: 'Komentarz jest wymagany przy zamknięciu aktywności' });
      }

      const type             = req.body.type             ?? act.type;
      const title            = req.body.title            ?? act.title;
      const body             = req.body.body             !== undefined ? req.body.body             : act.body;
      const activity_at      = req.body.activity_at      !== undefined ? req.body.activity_at      : act.activity_at;
      const participants     = req.body.participants     !== undefined ? req.body.participants     : act.participants;
      const meeting_location = req.body.meeting_location !== undefined ? req.body.meeting_location : act.meeting_location;
      const assigned_to      = req.body.assigned_to      !== undefined ? req.body.assigned_to      : act.assigned_to;
      const close_comment    = req.body.close_comment    !== undefined ? req.body.close_comment    : act.close_comment;

      const { rows } = await db.query(`
        UPDATE crm_lead_activities
        SET type=$1, title=$2, body=$3, activity_at=$4, participants=$5, meeting_location=$6,
            assigned_to=$7, status=$8, close_comment=$9, updated_at=now()
        WHERE id=$10
        RETURNING *,
          (SELECT display_name FROM users WHERE id = created_by) AS created_by_name,
          (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name
      `, [type, title, body||null, activity_at||null, participants||null, meeting_location||null,
          assigned_to||null, newStatus, close_comment||null, actId]);

      const auditAction = newStatus === 'closed' && act.status !== 'closed'
        ? 'crm_activity_close'
        : 'crm_activity_update';

      await audit.log({
        user:        req.user,
        action:      auditAction,
        beforeState: { type: act.type, title: act.title, status: act.status, assigned_to: act.assigned_to },
        afterState:  { type, title, status: newStatus, assigned_to, close_comment },
        metadata:    { lead_id: leadId, activity_id: actId, source: 'lead' },
        ipAddress:   req.auditContext?.ipAddress,
      });

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
      await audit.log({
        user:        req.user,
        action:      'crm_lead_update',
        beforeState: { activity_action: 'deleted', type: existing[0].type, title: existing[0].title },
        metadata:    { lead_id: leadId, activity_id: actId },
        ipAddress:   req.auditContext?.ipAddress,
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Dokumenty ──────────────────────────────────────────────────────
router.get('/:id/documents', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT ld.*, d.name AS document_title, d.status AS document_status,
             d.doc_number, d.doc_type
      FROM crm_lead_documents ld
      LEFT JOIN documents d ON d.id = ld.document_id
      WHERE ld.lead_id = $1
      ORDER BY ld.linked_at DESC
    `, [parseInt(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/documents',
  [param('id').isInt(), body('document_id').isUUID(), body('doc_role').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(`
        INSERT INTO crm_lead_documents (lead_id, document_id, doc_role, linked_by)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (lead_id, document_id) DO UPDATE SET doc_role = EXCLUDED.doc_role
        RETURNING *
      `, [parseInt(req.params.id), req.body.document_id, req.body.doc_role||null, req.user.id]);
      await audit.log({
        user:      req.user,
        action:    'crm_lead_update',
        afterState: { document_action: 'linked', document_id: req.body.document_id },
        metadata:  { lead_id: parseInt(req.params.id) },
        ipAddress: req.auditContext?.ipAddress,
      });
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.delete('/:id/documents/:docId',
  [param('id').isInt(), param('docId').isUUID()], validate,
  async (req, res, next) => {
    try {
      await db.query('DELETE FROM crm_lead_documents WHERE lead_id=$1 AND document_id=$2',
        [parseInt(req.params.id), req.params.docId]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Historia Leada (audit_logs) ──────────────────────────────────
router.get('/:id/history',
  crmScope,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      // Sprawdź dostęp do leada
      const scopeParams = [id];
      const scope = req.scopeFilter('l', 'assigned_to', scopeParams);
      const { rows: lead } = await db.query(
        `SELECT id FROM crm_leads l WHERE l.id = $1 ${scope}`, scopeParams
      );
      if (!lead.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      const { rows } = await db.query(`
        SELECT id, user_name, user_email, action,
               before_state, after_state, metadata, created_at
        FROM audit_logs
        WHERE metadata->>'lead_id' = $1::text
        ORDER BY created_at DESC
        LIMIT 100
      `, [String(id)]);
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── Konto testowe ─────────────────────────────────────────────────────────────

// ── GET /api/crm/leads/:id/test-account ──────────────────────────────────────
// Zwraca zapisane dane konta testowego dla danego Leada (jeśli istnieją).
router.get('/:id/test-account',
  crmScope,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const params = [id];
      const scope  = req.scopeFilter('l', 'assigned_to', params);
      const { rows: lead } = await db.query(
        `SELECT id FROM crm_leads l WHERE l.id = $1 ${scope}`, params
      );
      if (!lead.length) return res.status(404).json({ error: 'Lead nie znaleziony' });

      const { rows } = await db.query(
        `SELECT * FROM crm_lead_test_accounts WHERE lead_id = $1`, [id]
      );
      res.json(rows[0] || null);
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/leads/:id/test-account ─────────────────────────────────────
// Zapisuje dane i wywołuje zewnętrzne API CreateTestAccount.
// Dane są upsertowane — możliwe ponowne wywołanie po błędzie.
router.post('/:id/test-account',
  crmScope,
  [
    param('id').isInt(),
    body('subdomain').notEmpty().trim(),
    body('language').notEmpty().trim(),
    body('partner_currency').notEmpty().trim(),
    body('country').notEmpty().trim(),
    body('billing_address').notEmpty().trim(),
    body('billing_zip').notEmpty().trim(),
    body('billing_city').notEmpty().trim(),
    body('billing_country').notEmpty().trim(),
    body('billing_email_address').notEmpty().isEmail().normalizeEmail(),
    body('admin_first_name').notEmpty().trim(),
    body('admin_last_name').notEmpty().trim(),
    body('admin_email').notEmpty().isEmail().normalizeEmail(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);

      // Pobierz dane leada (company + nip potrzebne dla zewnętrznego API)
      const params = [id];
      const scope  = req.scopeFilter('l', 'assigned_to', params);
      const { rows: leads } = await db.query(
        `SELECT id, company, nip FROM crm_leads l WHERE l.id = $1 ${scope}`, params
      );
      if (!leads.length) return res.status(404).json({ error: 'Lead nie znaleziony' });
      const lead = leads[0];

      const {
        subdomain, language, partner_currency, country,
        billing_address, billing_zip, billing_city, billing_country, billing_email_address,
        admin_first_name, admin_last_name, admin_email,
      } = req.body;

      // Upsert danych lokalnie ze statusem 'pending'
      await db.query(`
        INSERT INTO crm_lead_test_accounts
          (lead_id,
           subdomain, language, partner_currency, country,
           billing_address, billing_zip, billing_city, billing_country, billing_email_address,
           admin_first_name, admin_last_name, admin_email,
           status, last_called_at, called_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',now(),$14,now())
        ON CONFLICT (lead_id) DO UPDATE SET
          subdomain             = EXCLUDED.subdomain,
          language              = EXCLUDED.language,
          partner_currency      = EXCLUDED.partner_currency,
          country               = EXCLUDED.country,
          billing_address       = EXCLUDED.billing_address,
          billing_zip           = EXCLUDED.billing_zip,
          billing_city          = EXCLUDED.billing_city,
          billing_country       = EXCLUDED.billing_country,
          billing_email_address = EXCLUDED.billing_email_address,
          admin_first_name      = EXCLUDED.admin_first_name,
          admin_last_name       = EXCLUDED.admin_last_name,
          admin_email           = EXCLUDED.admin_email,
          status                = 'pending',
          last_error            = NULL,
          last_called_at        = now(),
          called_by             = EXCLUDED.called_by,
          updated_at            = now()
      `, [
        id,
        subdomain, language, partner_currency, country,
        billing_address, billing_zip, billing_city, billing_country, billing_email_address,
        admin_first_name, admin_last_name, admin_email,
        req.user.id,
      ]);

      // Wywołanie zewnętrznego API
      let apiResult;
      try {
        apiResult = await testAccountSvc.createTestAccount({
          companyName:     lead.company,
          nip:             lead.nip,
          subdomain,       language,
          partnerCurrency: partner_currency,
          country,
          billingAddress:  billing_address,
          billingZip:      billing_zip,
          billingCity:     billing_city,
          billingCountry:  billing_country,
          billingEmail:    billing_email_address,
          adminFirstName:  admin_first_name,
          adminLastName:   admin_last_name,
          adminEmail:      admin_email,
        });
      } catch (apiErr) {
        logger.error('testAccountSvc.createTestAccount threw', { error: apiErr.message });
        apiResult = { success: false, error: `Błąd połączenia z zewnętrznym API: ${apiErr.message}` };
      }

      // Aktualizacja statusu po odpowiedzi API
      const { rows: final } = await db.query(`
        UPDATE crm_lead_test_accounts
        SET status              = $1,
            test_account_number = $2,
            last_error          = $3,
            updated_at          = now()
        WHERE lead_id = $4
        RETURNING *
      `, [
        apiResult.success ? 'created' : 'error',
        apiResult.success ? apiResult.accountNumber : null,
        apiResult.success ? null : apiResult.error,
        id,
      ]);

      await audit.log({
        user:      req.user,
        action:    'crm_lead_update',
        afterState: {
          test_account_action: apiResult.success ? 'created' : 'error',
          test_account_number: apiResult.accountNumber || null,
          error:               apiResult.error || null,
        },
        metadata:  { lead_id: id },
        ipAddress: req.auditContext?.ipAddress,
      });

      if (apiResult.success) {
        return res.status(201).json({ record: final[0], accountNumber: apiResult.accountNumber });
      }
      // HTTP 422: dane zapisane lokalnie, ale zewnętrzne API odmówiło
      return res.status(422).json({ error: apiResult.error, record: final[0] });
    } catch (err) { next(err); }
  }
);

// ── Migracja Lead → Partner (lead pozostaje w rejestrze w statusie Won) ──────

// ── GET /api/crm/leads/:id/contacts ──────────────────────────────
router.get('/:id/contacts', crmScope, [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM crm_lead_contacts WHERE lead_id=$1 ORDER BY created_at`,
        [parseInt(req.params.id)]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/leads/:id/contacts ─────────────────────────────
router.post('/:id/contacts', crmScope, [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { contacts } = req.body; // array of {contact_name, contact_title, email, phone}
      if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be array' });

      // Delete existing and replace with new set
      await db.query('DELETE FROM crm_lead_contacts WHERE lead_id=$1', [parseInt(req.params.id)]);

      const inserted = [];
      for (const c of contacts) {
        // Skip empty rows
        if (!c.contact_name && !c.email && !c.phone) continue;
        const { rows } = await db.query(
          `INSERT INTO crm_lead_contacts (lead_id, contact_name, contact_title, email, phone)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [parseInt(req.params.id), c.contact_name||null, c.contact_title||null, c.email||null, c.phone||null]
        );
        inserted.push(rows[0]);
      }
      res.json(inserted);
    } catch (err) { next(err); }
  }
);

router.post('/:id/migrate',
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

      if (lead.converted_at) return res.status(409).json({ error: 'Lead już zmigrowany do Partnera' });

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        // Pobierz numer konta testowego jeśli zostało założone
        const { rows: testAccRows } = await client.query(
          `SELECT test_account_number FROM crm_lead_test_accounts
           WHERE lead_id = $1 AND status = 'created' AND test_account_number IS NOT NULL`,
          [id]
        );
        const testAccountNumber = testAccRows[0]?.test_account_number || null;

        const { rows: partner } = await client.query(`
          INSERT INTO crm_partners
            (company, contact_name, contact_title, email, phone, industry,
             lead_id, group_id, manager_id, contract_doc_id, contract_signed,
             contract_value, notes, created_by, status,
             annual_turnover_currency, online_pct, tags,
             agent_name, agent_email, agent_phone, logo_url,
             partner_number)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'onboarding',$15,$16,$17,$18,$19,$20,$21,$22)
          RETURNING *
        `, [
          lead.company, lead.contact_name, lead.contact_title, lead.email,
          lead.phone, lead.industry, id,
          req.body.group_id||null, lead.assigned_to,
          req.body.contract_doc_id||null, req.body.contract_signed||null,
          req.body.contract_value||null, lead.notes, req.user.id,
          lead.annual_turnover_currency||'PLN',
          lead.online_pct||null, lead.tags||[],
          lead.agent_name||null, lead.agent_email||null, lead.agent_phone||null,
          lead.logo_url||null,
          testAccountNumber,   // ← numer konta testowego → partner_number
        ]);

        // ── Automatyczne zadania standardowe z AppSettings ──────────────────────
        try {
          const { rows: settingsRows } = await client.query(
            `SELECT value FROM app_settings WHERE key = 'onboarding_task_templates'`
          );
          if (settingsRows.length && settingsRows[0].value) {
            const templates = JSON.parse(settingsRows[0].value);
            const partnerId  = partner[0].id;
            const createdAt  = partner[0].created_at || new Date();
            const handlowiec = lead.assigned_to; // Krok 0 zawsze idzie do handlowca

            for (const tpl of templates) {
              if (!tpl.standard) continue; // tylko zadania standardowe

              // Wyznacz datę: created_at + tpl.days dni, godzina 09:00
              let dueDate = null;
              if (tpl.days != null && tpl.days >= 0) {
                const d = new Date(createdAt);
                d.setDate(d.getDate() + parseInt(tpl.days));
                dueDate = d.toISOString().slice(0, 10);
              }

              // Assignee: krok 0 zawsze handlowiec, reszta wg szablonu
              const assignedTo = tpl.step === 0
                ? (handlowiec || null)
                : (tpl.assignee || null);

              await client.query(
                `INSERT INTO crm_onboarding_tasks
                   (partner_id, step, title, type, assigned_to, due_date, due_time, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,'09:00',$7)`,
                [
                  partnerId,
                  tpl.step,
                  tpl.title,
                  tpl.type || 'task',
                  assignedTo,
                  dueDate,
                  req.user.id,
                ]
              );
            }
          }
        } catch (tplErr) {
          // Błąd szablonów nie blokuje migracji — logujemy ostrzeżenie
          const logger = require('../utils/logger');
          logger.warn('Błąd tworzenia zadań z szablonów onboarding', { error: tplErr.message });
        }

        // Lead pozostaje widoczny na liście w statusie closed_won.
        // converted_at jest ustawiane tylko dla zapisu — NIE filtrujemy już po tym polu.
        await client.query(
          `UPDATE crm_leads SET converted_at=now(), stage='closed_won', updated_at=now() WHERE id=$1`, [id]
        );

        await client.query('COMMIT');

        await audit.log({
          user:      req.user,
          action:    'crm_lead_migrated',
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


// ── POST /api/crm/leads/enrich ── scraper + GUS + logo blob ──────

// ── GET /api/crm/leads/:id/logo ── SAS URL ────────────────────────
router.get('/:id/logo',
  crmScope, [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT logo_url FROM crm_leads WHERE id=$1', [parseInt(req.params.id)]
      );
      if (!rows.length || !rows[0].logo_url) return res.status(404).json({ error: 'Brak logo' });
      const url = await require('../services/storageService').generateSasUrl(rows[0].logo_url, 60);
      res.json({ url });
    } catch(err){ next(err); }
  }
);

// ── GET /api/crm/leads/:id/logo-img ── stream image from blob (no SAS URL issues) ──
router.get('/:id/logo-img',
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT logo_url FROM crm_leads WHERE id=$1', [parseInt(req.params.id)]
      );
      if (!rows.length || !rows[0].logo_url) {
        return res.status(404).end();
      }
      const storage = require('../services/storageService');
      const { buffer, contentType } = await storage.downloadDocument(rows[0].logo_url);
      const mime = contentType || 'image/png';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } catch(err){ next(err); }
  }
);

// ── GET /api/crm/leads/report ─────────────────────────────────────────────────
// Backwards-compat alias — frontend może używać obu
router.post('/:id/convert', (req, res, next) => {
  req.url = req.url.replace('/convert', '/migrate');
  router.handle(req, res, next);
});

// Kompleksowy raport leadów: KPI, lejek, trend, handlowcy, kanały, porażki
// Zakres: salesperson widzi tylko swoje leady, manager widzi wszystkich (lub filtr)
// query: date_from (YYYY-MM-DD), date_to, assigned_to (UUID, tylko manager)
module.exports = router;
