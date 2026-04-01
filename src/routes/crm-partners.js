'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-partners.js
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const db    = require('../config/database');
const audit = require('../services/auditService');
const { requireAuth }                     = require('../middleware/auth');
const { validate, injectAuditContext }    = require('../middleware/errorHandler');
const { crmAuth, crmScope, requireCrmManager, assertOwnership } = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth);

// ── GET /api/crm/partners ─────────────────────────────────────────
router.get('/',
  crmScope,
  [
    query('status').optional().isString(),
    query('group_id').optional().isInt().toInt(),
    query('manager_id').optional().isUUID(),
    query('industry').optional().isString().trim(),
    query('search').optional().isString().trim(),
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
      let where = 'WHERE 1=1';

      where += req.scopeFilter('p', 'manager_id', params);

      if (req.query.status) {
        params.push(req.query.status);
        where += ` AND p.status = $${params.length}`;
      }
      if (req.query.group_id) {
        params.push(req.query.group_id);
        where += ` AND p.group_id = $${params.length}`;
      }
      if (req.query.manager_id && req.isCrmManager) {
        params.push(req.query.manager_id);
        where += ` AND p.manager_id = $${params.length}`;
      }
      if (req.query.industry) {
        params.push(req.query.industry);
        where += ` AND p.industry ILIKE $${params.length}`;
      }
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        where += ` AND (p.company ILIKE $${params.length} OR p.contact_name ILIKE $${params.length})`;
      }

      const countParams = [...params];
      params.push(limit, offset);

      const [cnt, rows] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM crm_partners p ${where}`, countParams),
        db.query(`
          SELECT
            p.*,
            u.display_name AS manager_name,
            g.name         AS group_name,
            g.industry     AS group_industry,
            (SELECT COUNT(*) FROM crm_partner_activities a
             WHERE a.partner_id = p.id AND a.type = 'opportunity'
               AND a.opp_status IN ('new','in_progress')) AS open_opp_count,
            (SELECT COALESCE(SUM(a.opp_value),0) FROM crm_partner_activities a
             WHERE a.partner_id = p.id AND a.type = 'opportunity'
               AND a.opp_status IN ('new','in_progress')) AS open_opp_value
          FROM crm_partners p
          LEFT JOIN users u ON u.id = p.manager_id
          LEFT JOIN crm_partner_groups g ON g.id = p.group_id
          ${where}
          ORDER BY p.updated_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
      ]);

      res.json({
        data:  rows.rows,
        total: parseInt(cnt.rows[0].count),
        page, limit,
        pages: Math.ceil(parseInt(cnt.rows[0].count) / limit),
      });
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/partners ────────────────────────────────────────
// Partner może być tworzony BEZ powiązanego leada (lead_id nullable)
router.post('/',
  [
    body('company').notEmpty().trim(),
    body('partner_number').optional({ nullable: true }).trim(),
    body('nip').optional().trim(),
    body('address').optional().trim(),
    body('contact_name').optional().trim(),
    body('contact_title').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().trim(),
    body('industry').optional().trim(),
    body('group_id').optional({ nullable: true }).isInt(),
    body('lead_id').optional({ nullable: true }).isInt(),  // ← nullable, nie wymagany
    body('manager_id').optional().isUUID(),
    body('contract_doc_id').optional({ nullable: true }).isInt(),
    body('contract_signed').optional({ nullable: true }).isDate(),
    body('contract_expires').optional({ nullable: true }).isDate(),
    body('contract_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('license_count').optional({ nullable: true }).isInt({ min: 1 }),
    body('notes').optional().trim(),
    body('agent_name').optional({ nullable: true }).isString().trim(),
    body('agent_email').optional({ nullable: true }).isString().trim(),
    body('agent_phone').optional({ nullable: true }).isString().trim(),
    // Kontakt do spraw rozliczeń
    body('billing_contact_name').optional({ nullable: true }).trim(),
    body('billing_contact_title').optional({ nullable: true }).trim(),
    body('billing_email').optional({ nullable: true }).isEmail().normalizeEmail(),
    body('billing_phone').optional({ nullable: true }).trim(),
    // Limit kredytowy
    body('credit_limit_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('credit_limit_currency').optional().trim(),
    // Kwota depozytu
    body('deposit_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('deposit_currency').optional().trim(),
    body('deposit_date_in').optional({ nullable: true }).isDate(),
    body('deposit_date_out').optional({ nullable: true }).isDate(),
    // Prowizja WT/TM
    body('commission_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('commission_basis').optional().isIn(['segmenty','rezerwacje','progi_obrotowe','nie_dotyczy']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        company, partner_number, nip, address, contact_name, contact_title, email, phone,
        industry, group_id, lead_id, manager_id, contract_doc_id,
        contract_signed, contract_expires, contract_value, license_count, notes,
        billing_contact_name, billing_contact_title, billing_email, billing_phone,
        credit_limit_value, credit_limit_currency,
        deposit_value, deposit_currency, deposit_date_in, deposit_date_out,
        commission_value, commission_basis,
      } = req.body;

      // Sprawdź lead jeśli podany
      if (lead_id) {
        const { rows: l } = await db.query('SELECT id, converted_at FROM crm_leads WHERE id=$1', [lead_id]);
        if (!l.length) return res.status(404).json({ error: 'Lead nie znaleziony' });
        if (l[0].converted_at) return res.status(409).json({ error: 'Lead już skonwertowany' });
      }

      const ownerId = req.isCrmManager ? (manager_id || req.user.id) : req.user.id;

      const { rows } = await db.query(`
        INSERT INTO crm_partners
          (company, partner_number, nip, address, contact_name, contact_title, email, phone,
           industry, group_id, lead_id, manager_id, contract_doc_id,
           contract_signed, contract_expires, contract_value, license_count, notes,
           billing_contact_name, billing_contact_title, billing_email, billing_phone,
           credit_limit_value, credit_limit_currency,
           deposit_value, deposit_currency, deposit_date_in, deposit_date_out,
           commission_value, commission_basis,
           created_by, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,'onboarding')
        RETURNING *
      `, [
        company, partner_number||null, nip||null, address||null,
        contact_name||null, contact_title||null, email||null, phone||null,
        industry||null, group_id||null, lead_id||null, ownerId,
        contract_doc_id||null, contract_signed||null, contract_expires||null,
        contract_value||null, license_count||null, notes||null,
        billing_contact_name||null, billing_contact_title||null,
        billing_email||null, billing_phone||null,
        credit_limit_value||null, credit_limit_currency||'PLN',
        deposit_value||null, deposit_currency||'PLN',
        deposit_date_in||null, deposit_date_out||null,
        commission_value||null, commission_basis||'nie_dotyczy',
        req.user.id,
      ]);

      // Oznacz lead jako skonwertowany jeśli podano
      if (lead_id) {
        await db.query(
          `UPDATE crm_leads SET converted_at=now(), stage='closed_won', updated_at=now() WHERE id=$1`,
          [lead_id]
        );
      }

      await audit.log({
        user:      req.user,
        action:    'crm_partner_create',
        afterState: { company, lead_id: lead_id||null, manager_id: ownerId },
        metadata:  { partner_id: rows[0].id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/crm/partners/:id ─────────────────────────────────────
router.get('/:id',
  crmScope,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const params = [parseInt(req.params.id)];
      const scopeWhere = req.scopeFilter('p', 'manager_id', params);

      const { rows } = await db.query(`
        SELECT
          p.*,
          u.display_name  AS manager_name,
          g.name          AS group_name,
          g.industry      AS group_industry,
          l.company       AS lead_company,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',gm.id,'company',gm.company,'status',gm.status,'contract_value',gm.contract_value
            )) FILTER (WHERE gm.id IS NOT NULL AND gm.id != p.id), '[]'
          ) AS group_siblings,
          COALESCE(
            (SELECT json_agg(act_row) FROM (
              SELECT jsonb_build_object(
                'id',a2.id,'type',a2.type,'title',a2.title,'activity_at',a2.activity_at,
                'meeting_location',a2.meeting_location,'participants',a2.participants,
                'duration_min',a2.duration_min,'body',a2.body,
                'opp_value',a2.opp_value,'opp_currency',a2.opp_currency,
                'opp_status',a2.opp_status,'opp_due_date',a2.opp_due_date,
                'created_by',a2.created_by,'created_by_name',u2.display_name,
                'updated_at',a2.updated_at
              ) AS act_row
              FROM crm_partner_activities a2
              LEFT JOIN users u2 ON u2.id = a2.created_by
              WHERE a2.partner_id = p.id
              ORDER BY a2.activity_at DESC
            ) sub), '[]'
          ) AS activities,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',pd.id,'document_id',pd.document_id,'doc_role',pd.doc_role
            )) FILTER (WHERE pd.id IS NOT NULL), '[]'
          ) AS linked_documents,
          COALESCE(
            (SELECT json_agg(opp_row) FROM (
              SELECT jsonb_build_object(
                'id',a3.id,'title',a3.title,'body',a3.body,
                'opp_value',a3.opp_value,'opp_currency',a3.opp_currency,
                'opp_status',a3.opp_status,'opp_due_date',a3.opp_due_date,
                'activity_at',a3.activity_at
              ) AS opp_row
              FROM crm_partner_activities a3
              WHERE a3.partner_id = p.id AND a3.type = 'opportunity'
              ORDER BY a3.activity_at DESC
            ) sub2), '[]'
          ) AS all_opportunities
        FROM crm_partners p
        LEFT JOIN users u  ON u.id = p.manager_id
        LEFT JOIN crm_partner_groups g ON g.id = p.group_id
        LEFT JOIN crm_partners gm ON gm.group_id = p.group_id
        LEFT JOIN crm_leads l ON l.id = p.lead_id
        LEFT JOIN crm_partner_documents pd  ON pd.partner_id = p.id
        WHERE p.id = $1 ${scopeWhere}
        GROUP BY p.id, u.display_name, g.name, g.industry, l.company
      `, params);

      if (!rows.length) return res.status(404).json({ error: 'Partner nie znaleziony' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/crm/partners/:id ───────────────────────────────────
router.patch('/:id',
  [
    param('id').isInt(),
    body('company').optional().notEmpty().trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('billing_email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('status').optional().isIn(['onboarding','active','inactive','churned']),
    body('commission_basis').optional({ nullable: true }).isIn(['segmenty','rezerwacje','progi_obrotowe','nie_dotyczy']),
    body('active_users').optional({ nullable: true }).isInt({ min: 0 }),
    body('license_count').optional({ nullable: true }).isInt({ min: 0 }),
    body('group_id').optional({ nullable: true }).isInt().toInt(),
    body('manager_id').optional({ nullable: true }).isUUID(),
    body('deposit_date_in').optional({ nullable: true }).isDate(),
    body('deposit_date_out').optional({ nullable: true }).isDate(),
    body('contract_signed').optional({ nullable: true }).isDate(),
    body('contract_expires').optional({ nullable: true }).isDate(),
    body('credit_limit_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('deposit_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('commission_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('annual_turnover_currency').optional({ nullable: true }).isString(),
    body('online_pct').optional({ nullable: true }).isInt({ min: 0, max: 100 }),
    body('tags').optional({ nullable: true }).isArray(),
  ],
  (req, res, next) => {
    const { validationResult } = require('express-validator');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('[PATCH /partners/:id] Validation errors:', JSON.stringify(errors.array(), null, 2));
      console.error('[PATCH /partners/:id] Body:', JSON.stringify(req.body, null, 2));
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  },
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: existing } = await db.query('SELECT * FROM crm_partners WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Partner nie znaleziony' });

      try { assertOwnership(existing[0], req, 'manager_id'); }
      catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

      if (!req.isCrmManager) {
        delete req.body.manager_id;
        delete req.body.group_id;
      }

      // Blokada ręcznej zmiany na 'active' gdy są otwarte zadania
      if (req.body.status === 'active' && existing[0].status === 'onboarding') {
        const { rows: openTasks } = await db.query(
          `SELECT COUNT(*) FROM crm_onboarding_tasks WHERE partner_id=$1 AND done=false`,
          [id]
        );
        const openCount = parseInt(openTasks[0].count);
        if (openCount > 0) {
          return res.status(422).json({
            error: `Nie można ustawić statusu Aktywny — ${openCount} zadań wdrożeniowych jest niewykonanych.`,
            open_tasks: openCount,
          });
        }
      }

      const allowed = ['company','partner_number','nip','address','contact_name','contact_title','email','phone',
                       'industry','group_id','manager_id','contract_doc_id','contract_signed',
                       'contract_expires','contract_value','status','license_count',
                       'active_users','onboarding_step','notes',
                       'billing_contact_name','billing_contact_title','billing_email','billing_phone',
                       'credit_limit_value','credit_limit_currency',
                       'deposit_value','deposit_currency','deposit_date_in','deposit_date_out',
                       'commission_value','commission_basis',
                       'annual_turnover_currency','online_pct','tags','agent_name','agent_email','agent_phone'];

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
        `UPDATE crm_partners SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      );

      await audit.log({
        user:      req.user,
        action:    'crm_partner_update',
        afterState: req.body,
        metadata:  { partner_id: id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/crm/partners/:id/onboarding ────────────────────────
router.patch('/:id/onboarding',
  [
    param('id').isInt(),
    body('step').isInt({ min: 0, max: 3 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id      = parseInt(req.params.id);
      const newStep = parseInt(req.body.step);

      const { rows: existing } = await db.query('SELECT * FROM crm_partners WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Partner nie znaleziony' });

      try { assertOwnership(existing[0], req, 'manager_id'); }
      catch (e) { return res.status(e.status || 403).json({ error: e.message }); }

      // Przy przejściu na ostatni krok (3=Gotowy) sprawdź czy WSZYSTKIE zadania są skończone
      let newStatus = existing[0].status;
      if (newStep >= 3) {
        const { rows: openTasks } = await db.query(
          `SELECT COUNT(*) FROM crm_onboarding_tasks WHERE partner_id=$1 AND done=false`,
          [id]
        );
        const openCount = parseInt(openTasks[0].count);
        if (openCount > 0) {
          return res.status(422).json({
            error: `Nie można zakończyć wdrożenia — ${openCount} zadań jest jeszcze niewykonanych.`,
            open_tasks: openCount,
          });
        }
        newStatus = 'active';
      }

      const { rows } = await db.query(`
        UPDATE crm_partners
        SET onboarding_step=$1, status=$2, updated_at=now()
        WHERE id=$3
        RETURNING *
      `, [newStep, newStatus, id]);

      await audit.log({
        user:      req.user,
        action:    'crm_partner_onboarding_step',
        afterState: { step: newStep, status: newStatus },
        metadata:  { partner_id: id },
        ipAddress: req.auditContext?.ipAddress,
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/partners/:id ──────────────────────────────────
router.delete('/:id',
  requireCrmManager,
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: existing } = await db.query('SELECT company FROM crm_partners WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Partner nie znaleziony' });

      await db.query('DELETE FROM crm_partners WHERE id=$1', [id]);

      await audit.log({
        user:        req.user,
        action:      'crm_partner_delete',
        beforeState: { company: existing[0].company },
        metadata:    { partner_id: id },
        ipAddress:   req.auditContext?.ipAddress,
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Aktywności ─────────────────────────────────────────────────────
router.get('/:id/activities', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT a.*, u.display_name AS created_by_name
      FROM crm_partner_activities a
      LEFT JOIN users u ON u.id = a.created_by
      WHERE a.partner_id = $1
      ORDER BY a.activity_at DESC
    `, [parseInt(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:id/activities',
  [
    param('id').isInt(),
    body('type').notEmpty().isIn(['call','email','meeting','note','doc_sent','training','qbr','opportunity']),
    body('title').notEmpty().trim(),
    body('body').optional().trim(),
    body('activity_at').optional().isISO8601(),
    body('duration_min').optional({ nullable: true }).isInt({ min: 0 }),
    body('participants').optional().trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
    body('opp_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('opp_currency').optional({ nullable: true }).isString(),
    body('opp_status').optional({ nullable: true }).isIn(['new','in_progress','closed']),
    body('opp_due_date').optional({ nullable: true }).isDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { type, title, body: bodyText, activity_at, duration_min, participants, meeting_location,
              opp_value, opp_currency, opp_status, opp_due_date } = req.body;
      const { rows } = await db.query(`
        INSERT INTO crm_partner_activities
          (partner_id, type, title, body, activity_at, duration_min, participants, meeting_location,
           opp_value, opp_currency, opp_status, opp_due_date, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
      `, [id, type, title, bodyText||null, activity_at||new Date(), duration_min||null, participants||null, meeting_location||null,
          opp_value||null, opp_currency||'PLN', opp_status||'new', opp_due_date||null, req.user.id]);
      await db.query('UPDATE crm_partners SET updated_at=now() WHERE id=$1', [id]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);


// ── PATCH /api/crm/partners/:id/activities/:actId ─────────────────
router.patch('/:id/activities/:actId',
  [
    param('id').isInt(),
    param('actId').isInt(),
    body('type').optional().isIn(['call','email','meeting','note','doc_sent','training','qbr','opportunity']),
    body('opp_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('opp_currency').optional({ nullable: true }).isString(),
    body('opp_status').optional({ nullable: true }).isIn(['new','in_progress','closed']),
    body('opp_due_date').optional({ nullable: true }).isDate(),
    body('title').optional().notEmpty().trim(),
    body('body').optional({ nullable: true }).trim(),
    body('activity_at').optional().isISO8601(),
    body('participants').optional({ nullable: true }).trim(),
    body('meeting_location').optional({ nullable: true }).trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const partnerId = parseInt(req.params.id);
      const actId     = parseInt(req.params.actId);
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_partner_activities WHERE id=$1 AND partner_id=$2',
        [actId, partnerId]
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
      const opp_value        = req.body.opp_value        !== undefined ? req.body.opp_value        : act.opp_value;
      const opp_currency     = req.body.opp_currency     !== undefined ? req.body.opp_currency     : act.opp_currency;
      const opp_status       = req.body.opp_status       !== undefined ? req.body.opp_status       : act.opp_status;
      const opp_due_date     = req.body.opp_due_date     !== undefined ? req.body.opp_due_date     : act.opp_due_date;
      const { rows } = await db.query(`
        UPDATE crm_partner_activities
        SET type=$1, title=$2, body=$3, activity_at=$4, participants=$5, meeting_location=$6,
            opp_value=$7, opp_currency=$8, opp_status=$9, opp_due_date=$10, updated_at=now()
        WHERE id=$11 RETURNING *
      `, [type, title, body||null, activity_at, participants||null, meeting_location||null,
          opp_value||null, opp_currency||'PLN', opp_status||null, opp_due_date||null, actId]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/partners/:id/activities/:actId ─────────────────
router.delete('/:id/activities/:actId',
  [param('id').isInt(), param('actId').isInt()], validate,
  async (req, res, next) => {
    try {
      const partnerId = parseInt(req.params.id);
      const actId     = parseInt(req.params.actId);
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_partner_activities WHERE id=$1 AND partner_id=$2',
        [actId, partnerId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Aktywność nie znaleziona' });
      if (existing[0].created_by !== req.user.id && !req.isCrmManager) {
        return res.status(403).json({ error: 'Brak uprawnień' });
      }
      await db.query('DELETE FROM crm_partner_activities WHERE id=$1', [actId]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);
// ── Dokumenty ──────────────────────────────────────────────────────
router.get('/:id/documents', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT pd.*, d.name AS document_title, d.status AS document_status,
             d.doc_number, d.doc_type
      FROM crm_partner_documents pd
      LEFT JOIN documents d ON d.id = pd.document_id
      WHERE pd.partner_id = $1
      ORDER BY pd.linked_at DESC
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
        INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (partner_id, document_id) DO UPDATE SET doc_role = EXCLUDED.doc_role
        RETURNING *
      `, [parseInt(req.params.id), req.body.document_id, req.body.doc_role||null, req.user.id]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.delete('/:id/documents/:docId',
  [param('id').isInt(), param('docId').isUUID()], validate,
  async (req, res, next) => {
    try {
      await db.query('DELETE FROM crm_partner_documents WHERE partner_id=$1 AND document_id=$2',
        [parseInt(req.params.id), req.params.docId]);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// ── Transakcje partnera ───────────────────────────────────────────
router.get('/:id/transactions', crmScope, [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const params = [id];
    const scope = req.scopeFilter('p', 'manager_id', params);

    const { rows: partner } = await db.query(
      `SELECT id FROM crm_partners p WHERE p.id = $1 ${scope}`, params
    );
    if (!partner.length) return res.status(404).json({ error: 'Partner nie znaleziony' });

    const { rows } = await db.query(`
      SELECT t.id, t.transaction_date, t.booking_ref, t.traveler_name,
        t.total_net, t.total_gross, t.total_commission, t.total_margin,
        t.currency, t.status,
        (SELECT json_agg(jsonb_build_object(
          'product_type',pr.product_type,'product_name',pr.product_name,
          'net_cost',pr.net_cost,'gross_cost',pr.gross_cost,
          'commission_pct',pr.commission_pct,'commission_amt',pr.commission_amt,
          'origin_city',pr.origin_city,'destination_city',pr.destination_city,
          'departure_at',pr.departure_at,'hotel_name',pr.hotel_name
        )) FROM crm_transaction_products pr WHERE pr.transaction_id = t.id) AS products
      FROM crm_transactions t
      WHERE t.partner_id = $1
      ORDER BY t.transaction_date DESC
      LIMIT 100
    `, [id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/crm/partners/:id/onboarding-tasks ────────────────────
router.get('/:id/onboarding-tasks',
  [param('id').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(`
        SELECT t.*,
               u.display_name AS assigned_to_name,
               db2.display_name AS done_by_name
        FROM crm_onboarding_tasks t
        LEFT JOIN users u   ON u.id   = t.assigned_to
        LEFT JOIN users db2 ON db2.id = t.done_by
        WHERE t.partner_id = $1
        ORDER BY t.step, t.created_at
      `, [parseInt(req.params.id)]);
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ── POST /api/crm/partners/:id/onboarding-tasks ───────────────────
router.post('/:id/onboarding-tasks',
  [
    param('id').isInt(),
    body('step').isInt({ min: 0, max: 3 }),
    body('title').notEmpty().trim(),
    body('body').optional({ nullable: true }).trim(),
    body('type').optional().isIn(['task','call','email','meeting','note','doc_sent','training']),
    body('assigned_to').optional({ nullable: true }).isUUID(),
    body('due_date').optional({ nullable: true }).isDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const partnerId = parseInt(req.params.id);
      const { step, title, body: taskBody, type, assigned_to, due_date } = req.body;
      const { rows } = await db.query(`
        INSERT INTO crm_onboarding_tasks
          (partner_id, step, title, body, type, assigned_to, due_date, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *,
          (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name
      `, [partnerId, step, title, taskBody||null, type||'task',
          assigned_to||null, due_date||null, req.user.id]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/crm/partners/:id/onboarding-tasks/:taskId ──────────
router.patch('/:id/onboarding-tasks/:taskId',
  [
    param('id').isInt(), param('taskId').isInt(),
    body('title').optional().notEmpty().trim(),
    body('body').optional({ nullable: true }).trim(),
    body('type').optional().isIn(['task','call','email','meeting','note','doc_sent','training']),
    body('assigned_to').optional({ nullable: true }).isUUID(),
    body('due_date').optional({ nullable: true }).isDate(),
    body('done').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const partnerId = parseInt(req.params.id);
      const taskId    = parseInt(req.params.taskId);
      const { rows: existing } = await db.query(
        'SELECT * FROM crm_onboarding_tasks WHERE id=$1 AND partner_id=$2', [taskId, partnerId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Zadanie nie znalezione' });
      const t = existing[0];
      const title       = req.body.title       !== undefined ? req.body.title       : t.title;
      const bodyVal     = req.body.body        !== undefined ? req.body.body        : t.body;
      const type        = req.body.type        !== undefined ? req.body.type        : t.type;
      const assigned_to = req.body.assigned_to !== undefined ? req.body.assigned_to : t.assigned_to;
      const due_date    = req.body.due_date    !== undefined ? req.body.due_date    : t.due_date;
      const done        = req.body.done        !== undefined ? req.body.done        : t.done;
      const done_at     = done && !t.done ? new Date() : (done ? t.done_at : null);
      const done_by     = done && !t.done ? req.user.id : (done ? t.done_by : null);
      const { rows } = await db.query(`
        UPDATE crm_onboarding_tasks
        SET title=$1, body=$2, type=$3, assigned_to=$4, due_date=$5,
            done=$6, done_at=$7, done_by=$8, updated_at=now()
        WHERE id=$9
        RETURNING *,
          (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name,
          (SELECT display_name FROM users WHERE id = done_by) AS done_by_name
      `, [title, bodyVal||null, type, assigned_to||null, due_date||null, done, done_at, done_by, taskId]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/crm/partners/:id/onboarding-tasks/:taskId ─────────
router.delete('/:id/onboarding-tasks/:taskId',
  [param('id').isInt(), param('taskId').isInt()], validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'DELETE FROM crm_onboarding_tasks WHERE id=$1 AND partner_id=$2 RETURNING id',
        [parseInt(req.params.taskId), parseInt(req.params.id)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Zadanie nie znalezione' });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);


module.exports = router;
