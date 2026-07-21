'use strict';
// src/utils/trainingThread.js
//
// Training-mode replies (scheduleTrainingReplyLead/Partner in
// crm-gmail.js/crm-outlook.js/crm-zoho.js) write straight into
// crm_lead_activities/crm_partner_activities with a fake `training_thread_`
// id and no mailbox_user_id — there is no real inbox that "received" a
// simulated reply. threadLeadHandler/threadPartnerHandler must never forward
// such an id to the real Gmail/Outlook/Zoho API: the id was never registered
// there, and even the sending row's mailbox_user_id can point at a user who
// never completed a real OAuth connection (training mode fakes the send
// without requiring one). Doing so throws ("Brak połączonego konta" or a
// live 404 for an id the provider never issued), and the frontend swallows
// thread-fetch errors silently — the thread stays expanded but empty.
//
// Detection is by id prefix, not by the tenant's current crm_training_mode
// setting: once a training thread exists, it stays synthetic forever, even
// after the tenant switches on a real provider.

const { pool } = require('../config/database');

const TRAINING_THREAD_PREFIX = 'training_thread_';

function isTrainingThreadId(threadId) {
  return typeof threadId === 'string' && threadId.startsWith(TRAINING_THREAD_PREFIX);
}

async function buildTrainingThreadResponse({ table, idCol, idVal, threadId, tenantId, currentUserId }) {
  const { rows } = await pool.query(
    `SELECT id, title, body, gmail_message_id, created_by, mailbox_user_id, activity_at
     FROM ${table}
     WHERE ${idCol} = $1 AND gmail_thread_id = $2 AND tenant_id = $3
     ORDER BY activity_at ASC NULLS LAST, id ASC`,
    [idVal, threadId, tenantId],
  );

  if (!rows.length) {
    return {
      messages: [], canReply: false, ownerEmail: null, unavailable: true,
      reason: 'Wątek szkoleniowy nie został odnaleziony.',
    };
  }

  const ownerId = rows.find((r) => r.mailbox_user_id)?.mailbox_user_id || null;
  const messages = rows.map((r) => ({
    id:          r.gmail_message_id,
    threadId,
    subject:     r.title || '',
    from:        r.created_by ? '' : 'Klient (symulacja szkoleniowa)',
    to:          r.created_by ? 'Klient (symulacja szkoleniowa)' : '',
    date:        (r.activity_at ? new Date(r.activity_at) : new Date()).toISOString(),
    snippet:     r.body || '',
    body:        r.body || '',
    cleanBody:   r.body || '',
    quotedBody:  '',
    attachments: [],
    is_read:     true,
    created_by:  r.created_by ? 'outgoing' : null,
    activity_id: r.id,
    sentAttachments: [],
  }));

  return { messages, canReply: ownerId === currentUserId, ownerEmail: null };
}

module.exports = { isTrainingThreadId, buildTrainingThreadResponse, TRAINING_THREAD_PREFIX };
