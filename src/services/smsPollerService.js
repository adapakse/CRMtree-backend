'use strict';
// src/services/smsPollerService.js
//
// Periodic background sync of SMS correspondence — feeds the "unread SMS"
// badge on the leads/partners list. ip-pbx.eu offers no webhook for incoming
// SMS (see smsSyncService.js), so this job is the automatic fallback: without
// it, unread SMS only ever appear after someone manually opens the SMS tab
// ("Sprawdź nowe"). Reuses syncNumber() from smsSyncService.js — same
// axios call + dedup insert as the on-demand route, just triggered on a timer
// instead of a click.
//
// Scope: each user's OWN assigned leads/partners (assigned_to / manager_id),
// not the whole tenant — keeps the number of ip-pbx.eu calls proportional to
// a salesperson's own portfolio, matching how their PBX extension actually
// corresponds with their own accounts (a lead not assigned to this user was
// never texted from this user's line in the first place).

const db     = require('../config/database');
const logger = require('../utils/logger');
const { syncNumber } = require('./smsSyncService');

async function syncDueSms() {
  const { rows: creds } = await db.query(`
    SELECT u.id AS user_id, u.tenant_id, c.pat_token, c.direct_phone
    FROM user_pbx_credentials c
    JOIN users u ON u.id = c.user_id
    JOIN tenant_features tf ON tf.tenant_id = u.tenant_id AND tf.feature = 'pbx' AND tf.is_enabled = true
    WHERE c.pat_token IS NOT NULL AND c.direct_phone IS NOT NULL
  `);

  let numbersSynced = 0;

  for (const cred of creds) {
    try {
      const { rows: leads } = await db.query(
        `SELECT l.id, l.phone,
                array_remove(array_agg(DISTINCT lc.phone), NULL) AS contact_phones
         FROM crm_leads l
         LEFT JOIN crm_lead_contacts lc ON lc.lead_id = l.id AND lc.phone IS NOT NULL
         WHERE l.assigned_to = $1 AND l.tenant_id = $2
         GROUP BY l.id`,
        [cred.user_id, cred.tenant_id],
      );
      for (const lead of leads) {
        const numbers = [lead.phone, ...(lead.contact_phones || [])].filter(Boolean);
        for (const number of numbers) {
          await syncNumber({ userId: cred.user_id, tenantId: cred.tenant_id, creds: cred, entityCol: 'lead_id', entityId: lead.id, number });
          numbersSynced++;
        }
      }

      const { rows: partners } = await db.query(
        `SELECT id, phone, billing_phone, agent_phone FROM crm_partners
         WHERE manager_id = $1 AND tenant_id = $2`,
        [cred.user_id, cred.tenant_id],
      );
      for (const partner of partners) {
        const numbers = [partner.phone, partner.billing_phone, partner.agent_phone].filter(Boolean);
        for (const number of numbers) {
          await syncNumber({ userId: cred.user_id, tenantId: cred.tenant_id, creds: cred, entityCol: 'partner_id', entityId: partner.id, number });
          numbersSynced++;
        }
      }
    } catch (err) {
      logger.error('[SmsPoller] Błąd synchronizacji dla usera', { userId: cred.user_id, error: err.message });
    }
  }

  logger.info(`[SmsPoller] Zsynchronizowano ${numbersSynced} numer(y/ów) dla ${creds.length} user(a/ów)`);
  return { usersChecked: creds.length, numbersSynced };
}

module.exports = { syncDueSms };
