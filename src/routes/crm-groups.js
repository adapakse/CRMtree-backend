'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-groups.js
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body, param } = require('express-validator');
const db    = require('../config/database');
const audit = require('../services/auditService');
const { requireAuth }                  = require('../middleware/auth');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, requireCrmManager }   = require('../middleware/crm-rbac');

router.use(requireAuth, injectAuditContext, crmAuth);

router.get('/', async (req, res, next) => {
  try {
    // Grupy zdefiniowane w CRM
    const crmQ = await db.query(`
      SELECT g.id, g.name, g.industry, g.description, g.manager_id,
             'crm' AS source,
             u.display_name AS manager_name,
             COUNT(p.id)::int AS partner_count,
             COALESCE(SUM(p.contract_value),0) AS total_arr,
             COALESCE(json_agg(jsonb_build_object(
               'id',p.id,'company',p.company,'status',p.status,'contract_value',p.contract_value,
               'onboarding_step',p.onboarding_step
             )) FILTER (WHERE p.id IS NOT NULL), '[]') AS partners
      FROM crm_partner_groups g
      LEFT JOIN users u ON u.id = g.manager_id
      LEFT JOIN crm_partners p ON p.group_id = g.id
      WHERE g.tenant_id = $1
      GROUP BY g.id, u.display_name
      ORDER BY g.name
    `, [req.tenantId]);

    // Grupy z DWH — distinct partner_group, pomijamy te które już istnieją w CRM
    const dwhQ = await db.query(`
      SELECT NULL::int AS id,
             dm.partner_group AS name,
             NULL AS industry,
             NULL AS description,
             NULL::uuid AS manager_id,
             'dwh' AS source,
             NULL AS manager_name,
             COUNT(DISTINCT p.id)::int AS partner_count,
             COALESCE(SUM(p.contract_value),0) AS total_arr,
             COALESCE(json_agg(jsonb_build_object(
               'id',p.id,
               'company',COALESCE(COALESCE(dm.company_name, dm.name), p.company),
               'status',p.status,'contract_value',p.contract_value,
               'onboarding_step',p.onboarding_step
             )) FILTER (WHERE p.id IS NOT NULL), '[]') AS partners
      FROM dwh.partner dm
      JOIN crm_partners p ON p.dwh_partner_id = dm.partner_id AND p.tenant_id = $1
      WHERE dm.partner_group IS NOT NULL
        AND dm.partner_group != 'Partner_basic'
        AND NOT EXISTS (
          SELECT 1 FROM crm_partner_groups cpg WHERE cpg.name = dm.partner_group AND cpg.tenant_id = $1
        )
      GROUP BY dm.partner_group
      ORDER BY dm.partner_group
    `, [req.tenantId]);

    res.json([...crmQ.rows, ...dwhQ.rows]);
  } catch (err) { next(err); }
});

router.post('/', requireCrmManager,
  [body('name').notEmpty().trim(), body('industry').optional().trim(),
   body('description').optional().trim(), body('manager_id').optional().isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { name, industry, description, manager_id } = req.body;
      const { rows } = await db.query(`
        INSERT INTO crm_partner_groups (name, industry, description, manager_id, created_by, tenant_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [name, industry||null, description||null, manager_id||req.user.id, req.user.id, req.tenantId]);

      await audit.log({ user: req.user, action: 'crm_group_create', afterState: { name },
        metadata: { group_id: rows[0].id }, ipAddress: req.auditContext?.ipAddress });
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get('/:id', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*, u.display_name AS manager_name,
        COALESCE(json_agg(jsonb_build_object(
          'id',p.id,'company',p.company,'status',p.status,'contract_value',p.contract_value,
          'manager_name',pu.display_name,'onboarding_step',p.onboarding_step
        )) FILTER (WHERE p.id IS NOT NULL), '[]') AS partners
      FROM crm_partner_groups g
      LEFT JOIN users u ON u.id = g.manager_id
      LEFT JOIN crm_partners p ON p.group_id = g.id
      LEFT JOIN users pu ON pu.id = p.manager_id
      WHERE g.id = $1 AND g.tenant_id = $2
      GROUP BY g.id, u.display_name
    `, [parseInt(req.params.id), req.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Grupa nie znaleziona' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', requireCrmManager, [param('id').isInt()],
  [body('name').optional().notEmpty().trim(), body('industry').optional().trim(),
   body('manager_id').optional().isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const allowed = ['name','industry','description','manager_id'];
      const setClauses = []; const params = []; let p = 1;
      for (const f of allowed) {
        if (req.body[f] !== undefined) { setClauses.push(`${f}=$${p++}`); params.push(req.body[f]); }
      }
      if (!setClauses.length) return res.status(400).json({ error: 'Brak pól' });
      setClauses.push(`updated_at=$${p++}`); params.push(new Date()); params.push(id); params.push(req.tenantId);
      const { rows } = await db.query(
        `UPDATE crm_partner_groups SET ${setClauses.join(',')} WHERE id=$${p} AND tenant_id=$${p + 1} RETURNING *`, params
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.delete('/:id', requireCrmManager, [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await db.query('UPDATE crm_partners SET group_id=NULL WHERE group_id=$1 AND tenant_id=$2', [id, req.tenantId]);
    const { rowCount } = await db.query('DELETE FROM crm_partner_groups WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
    if (!rowCount) return res.status(404).json({ error: 'Grupa nie znaleziona' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
