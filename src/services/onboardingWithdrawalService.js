'use strict';
// ─────────────────────────────────────────────────────────────────
// services/onboardingWithdrawalService.js
//
// Withdraws a Partner from onboarding back to a sales-funnel stage — the
// reverse of converting a Lead to a Partner (POST /crm/leads/:id/migrate).
// The Partner is deleted together with its onboarding tasks and activities
// (ON DELETE CASCADE, same as DELETE /crm/partners/:id) and its Lead returns
// to the active pipeline on the chosen stage. Used when onboarding started too
// early or the company backed out mid-way.
//
// Projects are the one thing the conversion MOVES rather than copies
// (projectCrmLinkService.moveLeadProjectsToPartner), so they are moved back to
// the Lead here — otherwise ON DELETE SET NULL would leave them unlinked.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const leadStageSvc = require('./leadStageService');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function withdrawPartnerFromOnboarding({ tenantId, partnerId, targetStage }) {
  const stageConfig = await leadStageSvc.getStageConfig(tenantId);
  if (!stageConfig.selectableKeys.includes(targetStage)) {
    throw httpError(400, `Unknown lead stage "${targetStage}". Allowed: ${stageConfig.selectableKeys.join(', ')}.`);
  }
  const isClosedStage = stageConfig.closedKeys.includes(targetStage);

  return db.transaction(async (client) => {
    const { rows: partnerRows } = await client.query(
      'SELECT id, company, status, lead_id FROM crm_partners WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [partnerId, tenantId],
    );
    const partner = partnerRows[0];
    if (!partner) throw httpError(404, 'Partner not found');
    if (partner.status !== 'onboarding') {
      throw httpError(409, "Only a partner in 'onboarding' status can be withdrawn from onboarding.");
    }
    if (!partner.lead_id) {
      throw httpError(409, 'This partner was not created from a lead, so there is no sales funnel to return it to.');
    }

    const { rows: leadRows } = await client.query(
      `UPDATE crm_leads
          SET stage        = $1,
              converted_at = NULL,
              close_date   = CASE WHEN $2::boolean THEN CURRENT_DATE ELSE NULL END,
              updated_at   = NOW()
        WHERE id = $3 AND tenant_id = $4
        RETURNING id, stage`,
      [targetStage, isClosedStage, partner.lead_id, tenantId],
    );
    if (!leadRows.length) throw httpError(409, 'The lead linked to this partner no longer exists.');

    await client.query(
      `UPDATE projects SET lead_id = $1, partner_id = NULL, updated_at = NOW()
        WHERE partner_id = $2 AND tenant_id = $3`,
      [partner.lead_id, partner.id, tenantId],
    );

    await client.query('DELETE FROM crm_partners WHERE id = $1 AND tenant_id = $2', [partner.id, tenantId]);

    return { partner, leadId: partner.lead_id, stage: targetStage };
  });
}

module.exports = { withdrawPartnerFromOnboarding };
