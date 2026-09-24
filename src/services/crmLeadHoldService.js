'use strict';
// src/services/crmLeadHoldService.js
//
// Cancelling a Hold on a lead (crm_leads) — shared by
// DELETE /api/crm/leads/:id/hold (manual, by a user), PUT /:id/archive
// (archiving drops an active Hold) and the daily auto-expiry job.

const db     = require('../config/database');
const audit  = require('../services/auditService');
const logger = require('../utils/logger');

/**
 * Cancels the Hold on a lead: closes the linked reminder task, clears the hold_*
 * columns and writes an audit entry. userId=null → system action (auto-expiry).
 * Returns the updated lead row, or null when the lead does not exist or is not
 * on Hold (no-op).
 */
async function cancelHold(leadId, tenantId, { userId = null } = {}) {
  const { rows: existing } = await db.query(
    'SELECT * FROM crm_leads WHERE id=$1 AND tenant_id=$2', [leadId, tenantId]
  );
  if (!existing.length || !existing[0].hold_active) return null;
  const lead = existing[0];

  if (lead.hold_task_id) {
    await db.query(
      `UPDATE crm_lead_activities SET status='closed', close_comment='Hold zdjęty', updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status != 'closed'`,
      [lead.hold_task_id, tenantId]
    );
  }

  const { rows } = await db.query(
    `UPDATE crm_leads
        SET hold_active=false, hold_reason=NULL, hold_until=NULL,
            hold_set_by=NULL, hold_set_at=NULL, hold_task_id=NULL, updated_at=now()
      WHERE id=$1 AND tenant_id=$2
      RETURNING *`,
    [leadId, tenantId]
  );

  await audit.log({
    user:        { id: userId, tenant_id: tenantId },
    action:      'crm_lead_hold_cancel',
    beforeState: { hold_active: true, hold_reason: lead.hold_reason, hold_until: lead.hold_until },
    afterState:  { hold_active: false },
    metadata:    { lead_id: leadId, triggered_by: userId ? 'user' : 'system' },
  });

  return rows[0];
}

/**
 * Daily job: auto-expires the Hold on every lead whose hold_until date has
 * passed, across all tenants. Called by src/jobs/crm-hold-expiry.js.
 */
async function expireDueHolds() {
  const { rows } = await db.query(
    `SELECT id, tenant_id FROM crm_leads WHERE hold_active = true AND hold_until < CURRENT_DATE`
  );
  let count = 0;
  for (const row of rows) {
    try {
      await cancelHold(row.id, row.tenant_id, { userId: null });
      count++;
    } catch (err) {
      logger.error('[crm-hold-expiry] Nie udało się wygasić Holda', { leadId: row.id, error: err.message });
    }
  }
  if (count) logger.info(`[crm-hold-expiry] Auto-wygaszono Hold dla ${count} leadów`);
  return count;
}

module.exports = { cancelHold, expireDueHolds };
