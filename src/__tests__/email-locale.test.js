'use strict';

// E-mails go out in the language of their recipient: the recipient's own
// users.locale, else the default of their tenant, else Polish.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const crmReminderService = require('../services/crmReminderService');
const projectTaskService = require('../services/projectTaskService');
const { signAccessToken } = require('../middleware/auth');

const EMAIL_DOMAIN = '@email-locale-test.crmtree.local';
const TENANTS = [
  { slug: 'zz-email-locale-pl', defaultLocale: 'pl' },
  { slug: 'zz-email-locale-en', defaultLocale: 'en' },
];

const tenantIds = {};
let ownEnglish, noChoicePolishTenant, noChoiceEnglishTenant, ownPolish;
let sendMailSpy;

async function mkUser(local, tenantId, locale) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, crm_role, locale, tenant_id)
     VALUES ($1, $2, 'Test', TRUE, 'salesperson', $3, $4) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, locale, tenantId],
  );
  return user;
}

async function mkDueReminder({ tenantId, assignedTo, createdBy }) {
  const { rows: [lead] } = await db.query(
    `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
     VALUES ('Locale Sp. z o.o.', 'new', $1, $1, $2) RETURNING id`,
    [createdBy, tenantId],
  );
  await db.query(
    `INSERT INTO crm_lead_activities
       (lead_id, type, title, activity_at, assigned_to, created_by, tenant_id, reminder_type, reminder_at)
     VALUES ($1, 'meeting', 'Demo', '2026-11-14T10:00:00Z', $2, $3, $4, '2d_before', '2020-01-01T08:00:00Z')`,
    [lead.id, assignedTo, createdBy, tenantId],
  );
}

async function cleanup() {
  const ids = Object.values(tenantIds);
  await db.query(
    'DELETE FROM crm_lead_activities WHERE lead_id IN (SELECT id FROM crm_leads WHERE tenant_id = ANY($1::uuid[]))',
    [ids],
  );
  await db.query('DELETE FROM crm_leads    WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM crm_absences WHERE tenant_id = ANY($1::uuid[])', [ids]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

const mailTo = (user) => sendMailSpy.mock.calls.map(([mail]) => mail).filter((mail) => mail.to === user.email);

beforeAll(async () => {
  for (const { slug, defaultLocale } of TENANTS) {
    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug, is_active, default_locale) VALUES ($1, $1, TRUE, $2)
       ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, default_locale = $2 RETURNING id`,
      [slug, defaultLocale],
    );
    tenantIds[defaultLocale] = tenant.id;
  }
  await cleanup();
  ownEnglish            = await mkUser('own-english', tenantIds.pl, 'en');
  noChoicePolishTenant  = await mkUser('no-choice-pl', tenantIds.pl, null);
  noChoiceEnglishTenant = await mkUser('no-choice-en', tenantIds.en, null);
  ownPolish             = await mkUser('own-polish', tenantIds.en, 'pl');
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = ANY($1::text[])', [TENANTS.map((tenant) => tenant.slug)]);
});

beforeEach(() => { sendMailSpy = jest.spyOn(emailUtil, 'sendMail').mockResolvedValue(); });
afterEach(() => { sendMailSpy.mockRestore(); });

describe('reminder job', () => {
  beforeAll(async () => {
    for (const user of [ownEnglish, noChoicePolishTenant]) {
      await mkDueReminder({ tenantId: tenantIds.pl, assignedTo: user.id, createdBy: noChoicePolishTenant.id });
    }
    for (const user of [noChoiceEnglishTenant, ownPolish]) {
      await mkDueReminder({ tenantId: tenantIds.en, assignedTo: user.id, createdBy: ownPolish.id });
    }
  });

  test('each recipient gets the reminder in their own language, else in the tenant default', async () => {
    await crmReminderService.sendDueReminders();

    const [english] = mailTo(ownEnglish);
    expect(english.subject).toBe('[CRMtree] ⏰ Reminder: Meeting — Demo');
    expect(english.html).toContain('<html lang="en">');
    expect(english.html).toContain('Hi own-english Test,');
    expect(english.html).toContain('2 days before the due date');
    expect(english.html).toContain('Open lead →');
    expect(english.html).toContain('This message was generated automatically by CRMtree.');
    expect(english.html).not.toContain('Cześć');

    const [polish] = mailTo(noChoicePolishTenant);
    expect(polish.subject).toBe('[CRMtree] ⏰ Przypomnienie: Spotkanie — Demo');
    expect(polish.html).toContain('<html lang="pl">');
    expect(polish.html).toContain('2 dni przed terminem');

    expect(mailTo(noChoiceEnglishTenant)[0].subject).toBe('[CRMtree] ⏰ Reminder: Meeting — Demo');
    expect(mailTo(ownPolish)[0].subject).toBe('[CRMtree] ⏰ Przypomnienie: Spotkanie — Demo');
  });

  test('an unassigned activity reminds its creator, in the creator\'s language', async () => {
    await mkDueReminder({ tenantId: tenantIds.pl, assignedTo: null, createdBy: ownEnglish.id });
    await crmReminderService.sendDueReminders();
    expect(mailTo(ownEnglish).map((mail) => mail.subject)).toEqual(['[CRMtree] ⏰ Reminder: Meeting — Demo']);
  });
});

describe('project task assignment', () => {
  test('every new assignee is notified in their own language', async () => {
    await projectTaskService.notifyNewAssignees({
      project: { id: 'project-id', key: 'ZZ', name: 'Rollout' },
      task: { id: 'task-id', task_number: 7, name: 'Import', end_date: '2026-11-14' },
      assigner: { id: ownPolish.id, display_name: 'Assigner Test' },
      assigneeIds: [ownEnglish.id, noChoicePolishTenant.id, noChoiceEnglishTenant.id],
    });

    expect(mailTo(ownEnglish)[0].subject).toBe('[CRMtree] New project task: ZZ-7 Import');
    expect(mailTo(ownEnglish)[0].html).toContain('<span class="info-label">Due date</span>');
    expect(mailTo(noChoicePolishTenant)[0].subject).toBe('[CRMtree] Nowe zadanie w projekcie: ZZ-7 Import');
    expect(mailTo(noChoiceEnglishTenant)[0].subject).toBe('[CRMtree] New project task: ZZ-7 Import');
  });
});

describe('new owner of a lead or a partner', () => {
  const { notifyNewOwner } = require('../services/crmOwnerNotification');
  const assigner = { display_name: 'Anna <Boss>', email: 'anna@example.com' };

  test('the new owner gets an e-mail in their own language, linking to the card', async () => {
    await notifyNewOwner({
      ownerId: ownEnglish.id, assigner, tenantId: tenantIds.pl,
      sourceType: 'lead', sourceId: 12, sourceName: 'Vantex & Co',
    });
    await notifyNewOwner({
      ownerId: noChoicePolishTenant.id, assigner, tenantId: tenantIds.pl,
      sourceType: 'partner', sourceId: 34, sourceName: 'Alpine Travel',
    });

    const [english] = mailTo(ownEnglish);
    expect(english.subject).toBe('[CRMtree] New lead: Vantex & Co');
    expect(english.html).toContain('You are the new owner of a lead');
    expect(english.html).toContain('<strong>Anna &lt;Boss&gt;</strong> has assigned a lead to you:');
    expect(english.html).toContain('<span class="info-val">Vantex &amp; Co</span>');
    expect(english.html).toContain('/crm/leads/12"');

    const [polish] = mailTo(noChoicePolishTenant);
    expect(polish.subject).toBe('[CRMtree] Nowy partner: Alpine Travel');
    expect(polish.html).toContain('Jesteś nowym opiekunem partnera');
    expect(polish.html).toContain('/crm/partners/34"');
  });

  test('a user of another tenant is never written to, and a failing mail server breaks nothing', async () => {
    await notifyNewOwner({
      ownerId: noChoiceEnglishTenant.id, assigner, tenantId: tenantIds.pl,
      sourceType: 'lead', sourceId: 12, sourceName: 'Vantex',
    });
    expect(sendMailSpy).not.toHaveBeenCalled();

    sendMailSpy.mockRejectedValue(new Error('smtp down'));
    await expect(notifyNewOwner({
      ownerId: ownEnglish.id, assigner, tenantId: tenantIds.pl,
      sourceType: 'lead', sourceId: 12, sourceName: 'Vantex',
    })).resolves.toBeUndefined();
  });
});

describe('substitution route', () => {
  const day = (offsetDays) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };

  test('the substitute is told in their language, not in the language of the person who named them', async () => {
    const response = await request(app)
      .post('/api/crm/substitutions')
      .set('Authorization', `Bearer ${signAccessToken(noChoicePolishTenant)}`)
      .send({ substitute_user_id: ownEnglish.id, starts_on: day(3), ends_on: day(7), reason: 'vacation' });
    expect(response.status).toBe(201);

    const [mail] = mailTo(ownEnglish);
    expect(mail.subject).toMatch(/^\[CRMtree\] Substituting for no-choice-pl Test \(\d{2}\/\d{2}\/\d{4}–\d{2}\/\d{2}\/\d{4}\)$/);
    expect(mail.html).toContain('You have been named as a substitute');
    expect(mail.html).toContain('<span class="badge badge-orange">Vacation</span>');
  });
});

describe('send functions called without a locale', () => {
  test('write in Polish', async () => {
    await emailUtil.sendUserInvitation({ to: 'someone@example.com', displayName: 'Jan', invitedByName: 'Anna' });
    await emailUtil.sendUserInvitation({ to: 'someone@example.com', displayName: 'Jan', invitedByName: 'Anna', locale: 'xx' });
    for (const [mail] of sendMailSpy.mock.calls) {
      expect(mail.subject).toBe('[CRMtree] Zaproszenie do systemu');
      expect(mail.html).toContain('<html lang="pl">');
    }
  });
});
