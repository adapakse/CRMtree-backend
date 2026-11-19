'use strict';
// routes/crm-consents.js
// ─────────────────────────────────────────────────────────────────────────────
// Zgody marketingowe dla Lead i Partner.
//
// GET  /api/crm/consents/types              — typy zgód z AppSettings
// GET  /api/crm/consents/leads/:leadId      — zgody dla leada
// PUT  /api/crm/consents/leads/:leadId      — zapisz zgody dla leada
// GET  /api/crm/consents/partners/:pid      — zgody dla partnera
// PUT  /api/crm/consents/partners/:pid      — zapisz zgody dla partnera
// GET  /api/crm/consents/people/:kind/:id    — zgody imienne osób firmy (kind = leads|partners)
// PUT  /api/crm/consents/people/:kind/:id    — zapisz zgodę imienną jednej osoby
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth }        = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope } = require('../middleware/crm-rbac');
const audit                  = require('../services/auditService');
const { loadConsentTypes }   = require('../services/consentService');

router.use(requireAuth, injectAuditContext, crmAuth);

const VALUE_LABELS = { no_data: 'Brak danych', granted: 'Zgoda', denied: 'Brak zgody' };
const VALID_VALUES = new Set(['no_data', 'granted', 'denied']);

function mergeWithTypes(types, dbRows) {
  return types.map(ct => {
    const row = dbRows.find(r => r.consent_key === ct.key);
    return {
      consent_key:     ct.key,
      label:           ct.label,
      description:     ct.description,
      value:           row?.value || 'no_data',
      updated_by_name: row?.updated_by_name || null,
      updated_at:      row?.updated_at || null,
    };
  });
}

// ── GET /types ────────────────────────────────────────────────────────────────
router.get('/types', async (req, res, next) => {
  try {
    res.json(await loadConsentTypes(req.tenantId));
  } catch (err) { next(err); }
});

// ── GET /leads/:leadId ────────────────────────────────────────────────────────
router.get('/leads/:leadId', async (req, res, next) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (!leadId) return res.status(400).json({ error: 'Invalid leadId' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3`,
        [leadId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const [types, { rows: dbRows }] = await Promise.all([
      loadConsentTypes(req.tenantId),
      db.query(
        `SELECT lc.consent_key, lc.value, lc.updated_at, u.display_name AS updated_by_name
         FROM crm_lead_consents lc
         LEFT JOIN users u ON u.id = lc.updated_by
         WHERE lc.lead_id = $1 AND lc.tenant_id = $2`,
        [leadId, req.tenantId],
      ),
    ]);

    res.json(mergeWithTypes(types, dbRows));
  } catch (err) { next(err); }
});

// ── PUT /leads/:leadId ────────────────────────────────────────────────────────
router.put('/leads/:leadId', async (req, res, next) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (!leadId) return res.status(400).json({ error: 'Invalid leadId' });

    const payload = Array.isArray(req.body) ? req.body : [];
    if (!payload.length) return res.status(400).json({ error: 'Pusta lista zgód' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_leads WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3`,
        [leadId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const types = await loadConsentTypes(req.tenantId);
    const validKeys = new Set(types.map(t => t.key));

    const { rows: oldRows } = await db.query(
      `SELECT consent_key, value FROM crm_lead_consents WHERE lead_id = $1 AND tenant_id = $2`,
      [leadId, req.tenantId],
    );
    const oldValues = Object.fromEntries(oldRows.map(r => [r.consent_key, r.value]));

    for (const item of payload) {
      const { key, value } = item;
      if (!validKeys.has(key) || !VALID_VALUES.has(value)) continue;

      const oldVal = oldValues[key] || 'no_data';

      await db.query(
        `INSERT INTO crm_lead_consents (tenant_id, lead_id, consent_key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (lead_id, consent_key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, leadId, key, value, req.user.id],
      );

      if (oldVal !== value) {
        const ct = types.find(t => t.key === key);
        await audit.log({
          user:        req.user,
          action:      'crm_lead_consent_update',
          beforeState: { consent_key: key, value: oldVal, label: VALUE_LABELS[oldVal] || oldVal },
          afterState:  { consent_key: key, value,         label: VALUE_LABELS[value]  || value  },
          metadata:    { lead_id: String(leadId), consent_label: ct?.label || key },
          ipAddress:   req.auditContext?.ipAddress,
        });
      }
    }

    const { rows: newRows } = await db.query(
      `SELECT lc.consent_key, lc.value, lc.updated_at, u.display_name AS updated_by_name
       FROM crm_lead_consents lc
       LEFT JOIN users u ON u.id = lc.updated_by
       WHERE lc.lead_id = $1 AND lc.tenant_id = $2`,
      [leadId, req.tenantId],
    );

    res.json(mergeWithTypes(types, newRows));
  } catch (err) { next(err); }
});

// ── GET /partners/:partnerId ──────────────────────────────────────────────────
router.get('/partners/:partnerId', async (req, res, next) => {
  try {
    const partnerId = req.params.partnerId;

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2 AND manager_id = $3`,
        [partnerId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const [types, { rows: dbRows }] = await Promise.all([
      loadConsentTypes(req.tenantId),
      db.query(
        `SELECT pc.consent_key, pc.value, pc.updated_at, u.display_name AS updated_by_name
         FROM crm_partner_consents pc
         LEFT JOIN users u ON u.id = pc.updated_by
         WHERE pc.partner_id = $1::uuid AND pc.tenant_id = $2`,
        [partnerId, req.tenantId],
      ),
    ]);

    res.json(mergeWithTypes(types, dbRows));
  } catch (err) { next(err); }
});

// ── PUT /partners/:partnerId ──────────────────────────────────────────────────
router.put('/partners/:partnerId', async (req, res, next) => {
  try {
    const partnerId = req.params.partnerId;

    const payload = Array.isArray(req.body) ? req.body : [];
    if (!payload.length) return res.status(400).json({ error: 'Pusta lista zgód' });

    const isManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
    if (!isManager) {
      const { rows: acc } = await db.query(
        `SELECT id FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2 AND manager_id = $3`,
        [partnerId, req.tenantId, req.user.id],
      );
      if (!acc.length) return res.status(403).json({ error: 'Brak dostępu' });
    }

    const types = await loadConsentTypes(req.tenantId);
    const validKeys = new Set(types.map(t => t.key));

    const { rows: oldRows } = await db.query(
      `SELECT consent_key, value FROM crm_partner_consents WHERE partner_id = $1::uuid AND tenant_id = $2`,
      [partnerId, req.tenantId],
    );
    const oldValues = Object.fromEntries(oldRows.map(r => [r.consent_key, r.value]));

    for (const item of payload) {
      const { key, value } = item;
      if (!validKeys.has(key) || !VALID_VALUES.has(value)) continue;

      const oldVal = oldValues[key] || 'no_data';

      await db.query(
        `INSERT INTO crm_partner_consents (tenant_id, partner_id, consent_key, value, updated_by, updated_at)
         VALUES ($1, $2::uuid, $3, $4, $5, now())
         ON CONFLICT (partner_id, consent_key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, partnerId, key, value, req.user.id],
      );

      if (oldVal !== value) {
        const ct = types.find(t => t.key === key);
        await audit.log({
          user:        req.user,
          action:      'crm_partner_consent_update',
          beforeState: { consent_key: key, value: oldVal, label: VALUE_LABELS[oldVal] || oldVal },
          afterState:  { consent_key: key, value,         label: VALUE_LABELS[value]  || value  },
          metadata:    { partner_id: String(partnerId), consent_label: ct?.label || key },
          ipAddress:   req.auditContext?.ipAddress,
        });
      }
    }

    const { rows: newRows } = await db.query(
      `SELECT pc.consent_key, pc.value, pc.updated_at, u.display_name AS updated_by_name
       FROM crm_partner_consents pc
       LEFT JOIN users u ON u.id = pc.updated_by
       WHERE pc.partner_id = $1::uuid AND pc.tenant_id = $2`,
      [partnerId, req.tenantId],
    );

    res.json(mergeWithTypes(types, newRows));
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Person-level consents — per contact person (by e-mail), table crm_contact_consents.
// People = the company's main contact + additional contacts with an e-mail address.
// The e-mail identifies the person, so the consent survives lead → partner conversion
// and re-saving the contact list.
//
// GET /people/leads/:leadId        GET /people/partners/:partnerId
// PUT /people/leads/:leadId        PUT /people/partners/:partnerId
//     Body: { email, key, value: 'no_data'|'granted'|'denied', note }
// ═════════════════════════════════════════════════════════════════════════════
const normEmail = e => String(e || '').trim().toLowerCase();

// Managers see every company of the tenant (as for company consents) — the scope
// (own records, substitutions, global read) matters only for salespeople.
const scopeUnlessManager = (req, res, next) => (req.isCrmManager ? next() : loadCrmScope(req, res, next));

const PEOPLE = {
  leads: {
    action: 'crm_lead_consent_update', metaKey: 'lead_id', ownerCol: 'assigned_to',
    parseId: v => (/^\d{1,10}$/.test(v) ? parseInt(v, 10) || null : null),
    entity: (id, tenantId) => db.query(
      `SELECT id, assigned_to AS owner_id FROM crm_leads WHERE id = $1 AND tenant_id = $2`, [id, tenantId]),
    people: (id, tenantId) => db.query(
      `SELECT contact_name, contact_title, email, true AS is_main, 0 AS ord
         FROM crm_leads WHERE id = $1 AND tenant_id = $2
       UNION ALL
       SELECT contact_name, contact_title, email, false, id
         FROM crm_lead_contacts WHERE lead_id = $1 AND tenant_id = $2
       ORDER BY ord`, [id, tenantId]),
  },
  partners: {
    action: 'crm_partner_consent_update', metaKey: 'partner_id', ownerCol: 'manager_id',
    parseId: v => (/^[0-9a-f-]{36}$/i.test(v) ? v : null),
    entity: (id, tenantId) => db.query(
      `SELECT id, manager_id AS owner_id FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2`, [id, tenantId]),
    people: (id, tenantId) => db.query(
      `SELECT contact_name, contact_title, email, true AS is_main, 0 AS ord
         FROM crm_partners WHERE id = $1::uuid AND tenant_id = $2
       UNION ALL
       SELECT contact_name, contact_title, email, false, id
         FROM crm_partner_contacts WHERE partner_id = $1::uuid AND tenant_id = $2
       ORDER BY ord`, [id, tenantId]),
  },
};

/** 404 when the company is not in the caller's tenant, 403 when it belongs to someone outside the caller's scope. */
async function checkPeopleAccess(kind, id, req) {
  const { rows } = await PEOPLE[kind].entity(id, req.tenantId);
  if (!rows.length) return { status: 404, error: 'Nie znaleziono' };
  if (req.isCrmManager || req.crmScopeUserIds === null) return null;
  if (Array.isArray(req.crmScopeUserIds) && req.crmScopeUserIds.includes(rows[0].owner_id)) return null;
  return { status: 403, error: 'Brak dostępu' };
}

/** The company's people with an e-mail address (no duplicates) + their consents for every tenant consent type. */
async function loadPeople(kind, id, tenantId) {
  const [types, { rows }] = await Promise.all([loadConsentTypes(tenantId), PEOPLE[kind].people(id, tenantId)]);
  const seen = new Set();
  const people = rows
    .map(r => ({ name: r.contact_name || null, title: r.contact_title || null, email: normEmail(r.email), is_main: r.is_main }))
    .filter(p => p.email && !seen.has(p.email) && seen.add(p.email));
  const { rows: cons } = people.length ? await db.query(
    `SELECT cc.email, cc.consent_key, cc.value, cc.source, cc.note, cc.updated_at, u.display_name AS updated_by_name
       FROM crm_contact_consents cc LEFT JOIN users u ON u.id = cc.updated_by
      WHERE cc.tenant_id = $1 AND cc.email = ANY($2)`, [tenantId, people.map(p => p.email)]) : { rows: [] };
  return people.map(p => ({
    ...p,
    consents: mergeWithTypes(types, cons.filter(c => c.email === p.email))
      .map(c => {
        const row = cons.find(x => x.email === p.email && x.consent_key === c.consent_key);
        return { ...c, source: row?.source || null, note: row?.note || null };
      }),
  }));
}

router.get('/people/:kind(leads|partners)/:id', scopeUnlessManager, async (req, res, next) => {
  try {
    const { kind } = req.params;
    const id = PEOPLE[kind].parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Niepoprawny identyfikator' });
    const denied = await checkPeopleAccess(kind, id, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    res.json(await loadPeople(kind, id, req.tenantId));
  } catch (err) { next(err); }
});

router.put('/people/:kind(leads|partners)/:id', scopeUnlessManager, async (req, res, next) => {
  try {
    const { kind } = req.params;
    const id = PEOPLE[kind].parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Niepoprawny identyfikator' });
    const denied = await checkPeopleAccess(kind, id, req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const email = normEmail(req.body?.email);
    const { key, value } = req.body || {};
    // How the salesperson obtained the consent — mandatory for "granted"
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
    if (value === 'granted' && (!note || note.length < 3)) {
      return res.status(400).json({ error: 'Wpisz, jak zgoda została pozyskana (np. ustnie na spotkaniu 12.11).' });
    }
    const types = await loadConsentTypes(req.tenantId);
    const ct = types.find(t => t.key === key);
    if (!ct || !VALID_VALUES.has(value)) return res.status(400).json({ error: 'Niepoprawna zgoda' });

    // A consent is saved only for a person who is a contact of this company
    const people = await loadPeople(kind, id, req.tenantId);
    const person = people.find(p => p.email === email);
    if (!person) return res.status(400).json({ error: 'Tej osoby nie ma w kontaktach firmy' });

    const old = person.consents.find(c => c.consent_key === key);
    const oldVal = old?.value || 'no_data';
    const oldNote = old?.note || null;
    if (oldVal !== value || oldNote !== note) {
      await db.query(
        `INSERT INTO crm_contact_consents (tenant_id, email, consent_key, value, source, note, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, 'crm', $5, $6, now())
         ON CONFLICT (tenant_id, email, consent_key)
         DO UPDATE SET value = EXCLUDED.value, source = 'crm', note = EXCLUDED.note,
                       updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, email, key, value, note, req.user.id],
      );
      await audit.log({
        user:        req.user,
        action:      PEOPLE[kind].action,
        beforeState: { consent_key: key, value: oldVal, label: VALUE_LABELS[oldVal] || oldVal, note: oldNote },
        afterState:  { consent_key: key, value,         label: VALUE_LABELS[value]  || value,  note },
        metadata:    { [PEOPLE[kind].metaKey]: String(id), consent_label: `${ct.label} — ${person.name || email}`, email },
        ipAddress:   req.auditContext?.ipAddress,
      });
    }
    res.json(await loadPeople(kind, id, req.tenantId));
  } catch (err) { next(err); }
});

module.exports = router;
