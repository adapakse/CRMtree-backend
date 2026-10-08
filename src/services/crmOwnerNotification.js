'use strict';
// services/crmOwnerNotification.js — tells a user they became the owner of a
// lead or a partner: a push to their phone and an e-mail (Adam, 2026-10-05:
// "always push and e-mail").
//
// Best effort and never throws: a failed notification must not fail the
// request that changed the owner.

const db = require('../config/database');
const email = require('../utils/email');
const logger = require('../utils/logger');
const pushService = require('./pushService');
const { resolveLocale } = require('../config/locales');

const PUSH_KINDS = { lead: 'leadOwnerAssigned', partner: 'partnerOwnerAssigned' };

/**
 * @param {object} args
 * @param {string} args.ownerId     the new owner
 * @param {object} args.assigner    the user who made the change (req.user)
 * @param {'lead'|'partner'} args.sourceType
 * @param {number|string} args.sourceId
 * @param {string} args.sourceName  company name of the lead or partner
 * @param {string} args.tenantId
 */
async function notifyNewOwner({ ownerId, assigner, sourceType, sourceId, sourceName, tenantId }) {
  const assignerName = assigner.display_name || assigner.email;

  await pushService.sendToUsers({
    userIds: [ownerId],
    kind: PUSH_KINDS[sourceType],
    params: { sourceName: sourceName || '', assignerName },
    data: { source_type: sourceType, source_id: sourceId },
  });

  try {
    const { rows: [owner] } = await db.query(
      `SELECT u.email, u.display_name, u.locale AS user_locale, t.default_locale AS tenant_default_locale
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1 AND u.tenant_id = $2 AND u.is_active`,
      [ownerId, tenantId],
    );
    if (!owner?.email) return;
    await email.sendCrmOwnerAssigned({
      to: owner.email,
      locale: resolveLocale({ userLocale: owner.user_locale, tenantDefaultLocale: owner.tenant_default_locale }),
      ownerName: owner.display_name || owner.email,
      assignerName,
      sourceName: sourceName || `#${sourceId}`,
      sourceType,
      sourceId,
    });
  } catch (error) {
    logger.warn('[CRM] New owner e-mail failed', { sourceType, sourceId, error: error.message });
  }
}

module.exports = { notifyNewOwner };
