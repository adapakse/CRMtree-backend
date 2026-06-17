'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/crm-documents.js
// Endpointy CRM po stronie dokumentu: powiązania dokument ↔ partner
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth }          = require('../middleware/auth');
const { crmAuth, loadCrmScope } = require('../middleware/crm-rbac');

router.use(requireAuth, crmAuth, loadCrmScope);

// GET /api/crm/documents/:docId/partners
router.get('/:docId/partners', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pd.*, p.company AS partner_name, p.nip, p.address
       FROM crm_partner_documents pd
       LEFT JOIN crm_partners p ON p.id = pd.partner_id AND p.tenant_id = pd.tenant_id
       WHERE pd.document_id = $1 AND pd.tenant_id = $2
       ORDER BY pd.linked_at DESC`,
      [req.params.docId, req.tenantId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /crm/documents/:docId/partners error:', err.message);
    res.status(500).json({ error: 'Błąd serwera', detail: err.message });
  }
});

// POST /api/crm/documents/:docId/partners
router.post('/:docId/partners', async (req, res) => {
  try {
    const { partner_id, doc_role } = req.body;
    if (!partner_id) return res.status(400).json({ error: 'partner_id jest wymagany' });
    const { rows } = await db.query(
      `INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (partner_id, document_id) DO UPDATE SET doc_role = EXCLUDED.doc_role
       RETURNING *`,
      [partner_id, req.params.docId, doc_role || null, req.user.id, req.tenantId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /crm/documents/:docId/partners error:', err.message);
    res.status(500).json({ error: 'Błąd serwera', detail: err.message });
  }
});

// DELETE /api/crm/documents/:docId/partners/:partnerId
router.delete('/:docId/partners/:partnerId', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM crm_partner_documents WHERE document_id = $1 AND partner_id = $2 AND tenant_id = $3',
      [req.params.docId, req.params.partnerId, req.tenantId]
    );
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /crm/documents/:docId/partners/:partnerId error:', err.message);
    res.status(500).json({ error: 'Błąd serwera', detail: err.message });
  }
});

module.exports = router;
