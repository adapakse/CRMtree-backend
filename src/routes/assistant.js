'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/assistant.js — the form assistants of the mobile app. The person
// says or types what they want to add; the answer is the form's fields plus
// a reply to show, and the app opens its own form filled in with them.
// Nothing is saved here. Contract: src/openapi/mobile-v1.yaml.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { body } = require('express-validator');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const { crmAuth, loadCrmScope, crmScope, requireFeature } = require('../middleware/crm-rbac');
const { SUPPORTED_LOCALES } = require('../config/locales');
const { translate } = require('../utils/i18n');
const { assistantClient, parseAnswer } = require('../services/assistant/assistantClient');
const { ACTIVITY_TYPES, ACTIVITY_INTENT_SCHEMA, activitySystemPrompt, activityReply, matchParticipants } = require('../services/assistant/activityIntent');
const { PROJECT_TASK_INTENT_SCHEMA, projectTaskSystemPrompt, projectTaskReply } = require('../services/assistant/projectTaskIntent');

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_OPTIONS = 100;
const COMPANY_MATCH_LIMIT = 6;

router.use(requireAuth);

const conversationRules = [
  body('messages').isArray({ min: 1, max: MAX_MESSAGES }),
  body('messages.*.role').isIn(['user', 'assistant']),
  body('messages.*.content').isString().trim().isLength({ min: 1, max: MAX_MESSAGE_LENGTH }),
  body('today').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('language').isIn(SUPPORTED_LOCALES),
];

const optionListRules = (field) => [
  body(field).optional().isArray({ max: MAX_OPTIONS }),
  body(`${field}.*.id`).isString().isLength({ min: 1, max: 64 }),
  body(`${field}.*.name`).isString().trim().isLength({ min: 1, max: 255 }),
];

const conversationOf = (req) => req.body.messages.map(({ role, content }) => ({ role, content }));

// % and _ typed by a person are letters, not wildcards.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// Leads and partners the person may see whose name contains `name`; an
// exact match first. When the whole phrase matches nothing its first word
// is tried, because people rarely say a company's full registered name.
async function findCompanies(req, name) {
  const search = async (phrase) => {
    const leadParams = [req.tenantId, likePattern(phrase), phrase];
    const leadScope = req.scopeFilter('l', 'assigned_to', leadParams);
    const partnerParams = [req.tenantId, likePattern(phrase), phrase];
    const partnerScope = req.scopeFilter('p', 'manager_id', partnerParams);
    const [leads, partners] = await Promise.all([
      db.query(`
        SELECT 'lead' AS source_type, l.id::text AS source_id, l.company AS name
          FROM crm_leads l
         WHERE l.tenant_id = $1 AND l.company ILIKE $2 AND l.converted_at IS NULL
           AND l.stage NOT IN ('archived', 'closed_lost') ${leadScope}
         ORDER BY (lower(l.company) = lower($3)) DESC, l.company
         LIMIT ${COMPANY_MATCH_LIMIT}`, leadParams),
      db.query(`
        SELECT 'partner' AS source_type, p.id::text AS source_id, p.company AS name
          FROM crm_partners p
         WHERE p.tenant_id = $1 AND p.company ILIKE $2 ${partnerScope}
         ORDER BY (lower(p.company) = lower($3)) DESC, p.company
         LIMIT ${COMPANY_MATCH_LIMIT}`, partnerParams),
    ]);
    return [...leads.rows, ...partners.rows];
  };

  const matches = await search(name);
  const firstWord = name.split(/\s+/)[0];
  return matches.length || firstWord === name || firstWord.length < 3 ? matches : search(firstWord);
}

// The people of a lead or partner who can be invited to a meeting: its main
// contact and its additional contacts. Empty when the person may not see
// the record.
async function contactsOf(req, sourceType, sourceId) {
  const isLead = sourceType === 'lead';
  const params = [req.tenantId, String(sourceId)];
  const scope = req.scopeFilter('r', isLead ? 'assigned_to' : 'manager_id', params);
  const { rows } = await db.query(`
    SELECT r.contact_name AS name, r.email
      FROM ${isLead ? 'crm_leads' : 'crm_partners'} r
     WHERE r.tenant_id = $1 AND r.id::text = $2 ${scope}
    UNION ALL
    SELECT c.contact_name AS name, c.email
      FROM ${isLead ? 'crm_lead_contacts' : 'crm_partner_contacts'} c
      JOIN ${isLead ? 'crm_leads' : 'crm_partners'} r ON r.id = c.${isLead ? 'lead_id' : 'partner_id'}
     WHERE r.tenant_id = $1 AND r.id::text = $2 ${scope}`, params);
  return rows.filter((row) => row.name && row.email);
}

// ── POST /api/assistant/activity ──────────────────────────────────
// A note, call, task or meeting in the person's own words. With
// `needs_company` (the assistant opened from the start screen, outside any
// card) the company is recognised by name: `companies` lists the leads and
// partners that match, and the app makes the person pick when there are
// several. For a meeting the people named are matched by first name and
// surname with the company's contacts and the team: inside a card
// (`source_type` + `source_id`) into `participants`, otherwise into each
// entry of `companies`.
router.post('/activity',
  crmAuth, loadCrmScope, crmScope,
  [
    ...conversationRules,
    body('now').matches(/^\d{2}:\d{2}$/),
    body('type').isIn(ACTIVITY_TYPES),
    body('needs_company').optional().isBoolean().toBoolean(),
    body('source_type').optional().isIn(['lead', 'partner']),
    body('source_id').optional().isString().isLength({ min: 1, max: 64 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { today, now, language, type } = req.body;
      const needsCompany = req.body.needs_company === true;
      const { rows: users } = await db.query(`
        SELECT id, COALESCE(NULLIF(display_name, ''), email) AS name, email
          FROM users
         WHERE is_active = true AND tenant_id = $1
           AND (crm_role IN ('salesperson', 'sales_manager') OR is_admin = true)
         ORDER BY display_name
         LIMIT ${MAX_OPTIONS}`, [req.tenantId]);

      const invitesPeople = type === 'meeting';
      const contacts = invitesPeople && !needsCompany && req.body.source_type && req.body.source_id
        ? await contactsOf(req, req.body.source_type, req.body.source_id)
        : [];

      const content = await assistantClient.ask({
        name: 'activity_intent',
        schema: ACTIVITY_INTENT_SCHEMA,
        system: activitySystemPrompt({ type, today, now, language, users, contacts, needsCompany }),
        messages: conversationOf(req),
      });
      const answer = parseAnswer(content);
      const result = activityReply(answer, { type, language, users, needsCompany });

      const { participant_names: participantNames, ...intent } = result.intent;
      let companies = [];
      if (needsCompany && intent.company_name) {
        companies = await findCompanies(req, intent.company_name);
        if (!companies.length) {
          result.complete = false;
          result.reply = translate(language, 'assistant.activity.companyNotFound', { name: intent.company_name });
        }
        // Which contacts the names mean depends on the company.
        companies = await Promise.all(companies.map(async (company) => ({
          ...company,
          ...matchParticipants(participantNames, {
            contacts: invitesPeople && participantNames.length ? await contactsOf(req, company.source_type, company.source_id) : [],
            colleagues: users,
          }),
        })));
      }
      res.json({
        ...result,
        intent,
        ...matchParticipants(needsCompany ? [] : participantNames, { contacts, colleagues: users }),
        companies,
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/assistant/project-task ──────────────────────────────
// A project task in the person's own words. The app sends the project's
// task types, priorities and members; the answer names them by their ids.
router.post('/project-task',
  requireFeature('projects'),
  [
    ...conversationRules,
    ...optionListRules('types'),
    ...optionListRules('priorities'),
    ...optionListRules('members'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { today, language } = req.body;
      const lists = {
        types: req.body.types ?? [],
        priorities: req.body.priorities ?? [],
        members: req.body.members ?? [],
      };
      const content = await assistantClient.ask({
        name: 'project_task_intent',
        schema: PROJECT_TASK_INTENT_SCHEMA,
        system: projectTaskSystemPrompt({ today, language, ...lists }),
        messages: conversationOf(req),
      });
      res.json(projectTaskReply(parseAnswer(content), { language, ...lists }));
    } catch (err) { next(err); }
  },
);

module.exports = router;
