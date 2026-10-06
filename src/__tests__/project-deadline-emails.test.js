'use strict';

// Automatic deadline e-mails of the Projects module: "end date changed" and
// "project became delayed" (sent at once) and the daily overdue summary (sent
// by the reminder job from 09:00 Europe/Warsaw, once per person per day).
// Covers who gets each mail, the per-user switch in "My settings", the
// language (the recipient's own, else the tenant default — as every other
// mail) and that a failing mail server breaks nothing.
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');
const { todayInWarsaw } = require('../services/projectDeadlineService');
const { sendDailySummaries } = require('../services/projectDeadlineNotificationService');

const SLUG         = 'zz-project-deadline-emails-test';
const EMAIL_DOMAIN = '@project-deadline-emails-test.crmtree.local';
const DAY_MS       = 86_400_000;

let tenantId;
let admin, pm, polishPm, worker, external;
let project, statusByName;
let sendMailSpy;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);
const tasksUrl = (suffix = '', target = project) => `/api/projects/${target.id}/tasks${suffix}`;
const day = (offset) =>
  new Date(Date.parse(`${todayInWarsaw()}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
const englishDate = (isoDate) => isoDate.split('-').reverse().join('/');
const polishDate = (isoDate) => isoDate.split('-').reverse().join('.');
// 13:00 or 14:00 in Warsaw on the given Warsaw day — after the 09:00 run.
const afternoonOf = (isoDate) => new Date(`${isoDate}T12:00:00Z`);

async function mkUser(local, { isAdmin = false, isExternal = false, canCreate = false, locale = null } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id, is_external, can_create_projects, locale)
     VALUES ($1, $2, 'Test', $3, TRUE, $4, $5, $6, $7) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, tenantId, isExternal, canCreate, locale],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

async function cleanup() {
  await db.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_statuses WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_types WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_task_priorities WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM project_deadline_digests WHERE tenant_id = $1', [tenantId]);
  await db.query(
    'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
}

async function createTask(body = {}, target = project) {
  const res = await api('post', tasksUrl('', target), pm).send({ name: 'Zadanie', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

const patchTask = (user, task, body) => api('patch', tasksUrl(`/${task.id}`), user).send(body);
const patchProject = (user, body) => api('patch', `/api/projects/${project.id}`, user).send(body);
const setNotifications = (user, isEnabled) =>
  api('put', '/api/profile/project-deadline-notifications', user).send({ is_enabled: isEnabled });

const mails = () => sendMailSpy.mock.calls.map(([mail]) => mail);
const mailsTo = (user) => mails().filter((mail) => mail.to === user.email);
const emailsOf = (...users) => users.map((user) => user.email).sort();
const DATE_CHANGED = /due date changed|Zmiana terminu/;
const dateChangedRecipients = () => mails().filter((mail) => DATE_CHANGED.test(mail.subject)).map((mail) => mail.to).sort();
const delayedRecipients = () =>
  mails().filter((mail) => /Project delayed|Projekt opóźniony/.test(mail.subject)).map((mail) => mail.to).sort();

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active, default_locale) VALUES ('Project Deadline Emails Test', $1, TRUE, 'en')
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, default_locale = 'en' RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await db.query(
    `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
     ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`,
    [tenantId],
  );
  await cleanup();

  admin    = await mkUser('eadmin', { isAdmin: true });
  pm       = await mkUser('epm', { canCreate: true });
  polishPm = await mkUser('epolishpm', { locale: 'pl' });
  worker   = await mkUser('eworker');
  external = await mkUser('eexternal', { isExternal: true });

  const config = (await api('get', '/api/projects/config', admin)).body;
  statusByName = Object.fromEntries(config.statuses.map((status) => [status.name, status.id]));

  project = (await api('post', '/api/projects', pm).send({ name: 'Wdrożenie Terminów' })).body;
  for (const member of [
    { user_id: polishPm.id, role: 'pm' },
    { user_id: worker.id,   role: 'internal_participant', access_level: 'full' },
    { user_id: external.id, role: 'external_participant', access_level: 'full' },
  ]) {
    expect((await api('post', `/api/projects/${project.id}/members`, pm).send(member)).status).toBe(201);
  }
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

beforeEach(async () => {
  await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
  await db.query('UPDATE projects SET start_date = NULL, end_date = NULL WHERE id = $1', [project.id]);
  await db.query('DELETE FROM project_deadline_digests WHERE tenant_id = $1', [tenantId]);
  await db.query('UPDATE users SET project_deadline_notifications_enabled = TRUE WHERE tenant_id = $1', [tenantId]);
  jest.spyOn(emailUtil, 'sendProjectTaskAssigned').mockResolvedValue();
  sendMailSpy = jest.spyOn(emailUtil, 'sendMail').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('the switch in "My settings"', () => {
  test('is on by default, returned by /api/auth/me and changed by the user', async () => {
    expect((await api('get', '/api/auth/me', worker)).body.project_deadline_notifications_enabled).toBe(true);

    const off = await setNotifications(worker, false);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ project_deadline_notifications_enabled: false });
    expect((await api('get', '/api/auth/me', worker)).body.project_deadline_notifications_enabled).toBe(false);
    expect((await api('get', '/api/auth/me', pm)).body.project_deadline_notifications_enabled).toBe(true);

    expect((await setNotifications(worker, true)).body).toEqual({ project_deadline_notifications_enabled: true });
    expect((await setNotifications(worker, 'no')).status).toBe(400);
    expect((await setNotifications(worker, undefined)).status).toBe(400);
  });

  test('an external account may change it too', async () => {
    expect((await setNotifications(external, false)).status).toBe(200);
    expect((await api('get', '/api/auth/me', external)).body.project_deadline_notifications_enabled).toBe(false);
  });
});

describe('end date changed', () => {
  test('goes to the PMs of the project when somebody else changes the date', async () => {
    const task = await createTask({ name: 'Import danych', end_date: day(5), assignee_ids: [worker.id] });
    sendMailSpy.mockClear();
    const res = await patchTask(worker, task, { end_date: day(8), end_date_change_reason: 'Klient <prosił> o przesunięcie' });
    expect(res.status).toBe(200);
    expect(dateChangedRecipients()).toEqual(emailsOf(pm, polishPm));

    const [mail] = mailsTo(pm);
    expect(mail.subject).toBe(`[CRMtree] Task due date changed: ${project.key}-${task.task_number} Import danych`);
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain('<strong>eworker Test</strong> has changed the due date of a task in a project you manage:');
    expect(mail.html).toContain('Wdrożenie Terminów');
    expect(mail.html).toContain(`${englishDate(day(5))} → ${englishDate(day(8))}`);
    expect(mail.html).toContain(`<span class="info-val">${englishDate(day(5))} (3 days later)</span>`);
    expect(mail.html).toContain('Klient &lt;prosił&gt; o przesunięcie');
    expect(mail.html).toContain(`/projects/${project.id}?task=${task.id}"`);
  });

  test('each PM reads it in their own language, else in the tenant default', async () => {
    const task = await createTask({ name: 'Import danych', end_date: day(5), assignee_ids: [worker.id] });
    await patchTask(worker, task, { end_date: day(4) });

    // The tenant default is English; this PM chose Polish.
    const [polish] = mailsTo(polishPm).filter((mail) => DATE_CHANGED.test(mail.subject));
    expect(polish.subject).toBe(`[CRMtree] Zmiana terminu zadania: ${project.key}-${task.task_number} Import danych`);
    expect(polish.html).toContain('<html lang="pl">');
    expect(polish.html).toContain(`${polishDate(day(5))} → ${polishDate(day(4))}`);
    expect(polish.html).toContain('(1 dzień wcześniej)');
    // No own choice → the tenant's default language.
    const [english] = mailsTo(pm).filter((mail) => DATE_CHANGED.test(mail.subject));
    expect(english.html).toContain('<html lang="en">');
    expect(english.html).toContain('(1 day earlier)');
  });

  test('a PM who changes the date gets no mail; the other PM does', async () => {
    const task = await createTask({ end_date: day(5) });
    sendMailSpy.mockClear();
    await patchTask(pm, task, { end_date: day(9) });
    expect(dateChangedRecipients()).toEqual(emailsOf(polishPm));

    sendMailSpy.mockClear();
    await patchTask(admin, task, { end_date: day(10) });
    expect(dateChangedRecipients()).toEqual(emailsOf(pm, polishPm));
  });

  test('a PM who switched the notifications off gets none', async () => {
    const task = await createTask({ end_date: day(5), assignee_ids: [worker.id] });
    await setNotifications(polishPm, false);
    sendMailSpy.mockClear();
    await patchTask(worker, task, { end_date: day(6) });
    expect(dateChangedRecipients()).toEqual(emailsOf(pm));
  });

  test('covers a date being set for the first time and being cleared; other edits send nothing', async () => {
    const task = await createTask({ assignee_ids: [worker.id] });
    sendMailSpy.mockClear();
    await patchTask(worker, task, { end_date: day(3) });
    expect(mailsTo(pm)[0].html).toContain(`none → ${englishDate(day(3))}`);

    sendMailSpy.mockClear();
    await patchTask(worker, task, { end_date: null });
    expect(mailsTo(pm)[0].html).toContain(`${englishDate(day(3))} → none`);

    sendMailSpy.mockClear();
    await patchTask(worker, task, { description: 'Postęp', status_id: statusByName['W toku'] });
    await patchTask(worker, task, { end_date: null });
    expect(mails()).toHaveLength(0);
  });

  test('a failing mail server does not break the change', async () => {
    const task = await createTask({ end_date: day(5), assignee_ids: [worker.id] });
    sendMailSpy.mockRejectedValue(new Error('smtp down'));
    const res = await patchTask(worker, task, { end_date: day(7) });
    expect(res.status).toBe(200);
    expect(res.body.end_date).toBe(day(7));
  });
});

describe('project became delayed', () => {
  beforeEach(async () => {
    await db.query('UPDATE projects SET end_date = $1 WHERE id = $2', [day(10), project.id]);
  });

  test('is sent once, when a task end date moves past the project end', async () => {
    const task = await createTask({ name: 'Testy', end_date: day(8), assignee_ids: [worker.id] });
    const other = await createTask({ name: 'Szkolenie', end_date: day(9) });
    sendMailSpy.mockClear();

    await patchTask(worker, task, { end_date: day(10) });
    expect(delayedRecipients()).toEqual([]);

    await patchTask(worker, task, { end_date: day(14) });
    expect(delayedRecipients()).toEqual(emailsOf(pm, polishPm));
    const [mail] = mailsTo(pm).filter((sent) => sent.subject.includes('Project delayed'));
    expect(mail.subject).toBe('[CRMtree] Project delayed: Wdrożenie Terminów');
    expect(mail.html).toContain(englishDate(day(10)));
    expect(mail.html).toContain(`${englishDate(day(14))} (4 days after the project end)`);
    expect(mail.html).toContain(`/projects/${project.id}"`);
    expect(mailsTo(polishPm).map((sent) => sent.subject)).toContain('[CRMtree] Projekt opóźniony: Wdrożenie Terminów');

    // Still delayed: further changes send no second mail.
    sendMailSpy.mockClear();
    await patchTask(worker, task, { end_date: day(20) });
    await patchTask(pm, other, { end_date: day(30) });
    expect(delayedRecipients()).toEqual([]);
  });

  test('is sent when reopening a task or a new task brings the delay', async () => {
    const finished = await createTask({ end_date: day(15), status_id: statusByName['Zakończone'] });
    expect(delayedRecipients()).toEqual([]);

    await patchTask(pm, finished, { status_id: statusByName['W toku'] });
    expect(delayedRecipients()).toEqual(emailsOf(pm, polishPm));

    await patchTask(pm, finished, { status_id: statusByName['Zakończone'] });
    sendMailSpy.mockClear();
    await createTask({ end_date: day(11) });
    expect(delayedRecipients()).toEqual(emailsOf(pm, polishPm));
  });

  test('is sent when the project end date is pulled in before a task', async () => {
    await createTask({ end_date: day(7) });
    sendMailSpy.mockClear();
    expect((await patchProject(pm, { end_date: day(8) })).status).toBe(200);
    expect(delayedRecipients()).toEqual([]);

    expect((await patchProject(pm, { end_date: day(6) })).status).toBe(200);
    expect(delayedRecipients()).toEqual(emailsOf(pm, polishPm));
  });

  test('respects the switch, and a delay by a passed end date alone waits for the daily summary', async () => {
    await setNotifications(pm, false);
    const task = await createTask({ end_date: day(8) });
    await patchTask(admin, task, { end_date: day(12) });
    expect(delayedRecipients()).toEqual(emailsOf(polishPm));

    await patchTask(admin, task, { end_date: null });
    sendMailSpy.mockClear();
    // The end date is now behind and an undated open task remains: delayed, but not by a task after the end.
    await patchProject(admin, { end_date: day(-2) });
    expect((await api('get', `/api/projects/${project.id}`, pm)).body.project.delay_reasons).toEqual(['end_passed']);
    expect(delayedRecipients()).toEqual([]);
    // Already delayed when a task after the end appears: not a flip, no mail.
    await patchTask(admin, task, { end_date: day(3) });
    expect(delayedRecipients()).toEqual([]);
  });
});

describe('daily overdue summary', () => {
  const runAt = (now) => sendDailySummaries({ now, tenantId });
  const today = () => afternoonOf(todayInWarsaw());
  let newlyOverdue, longOverdue, pmOwn;

  beforeEach(async () => {
    longOverdue  = await createTask({ name: 'Stare zadanie', end_date: day(-5), assignee_ids: [worker.id, external.id] });
    newlyOverdue = await createTask({ name: 'Świeże zadanie', end_date: day(-1), assignee_ids: [worker.id] });
    pmOwn        = await createTask({ name: 'Zadanie PM-a', end_date: day(-2), assignee_ids: [pm.id] });
    await createTask({ name: 'Na czas', end_date: day(3), assignee_ids: [worker.id] });
    await createTask({ name: 'Skończone po czasie', end_date: day(-4), assignee_ids: [worker.id], status_id: statusByName['Zakończone'] });
    sendMailSpy.mockClear();
  });

  test('is not sent before 09:00 Warsaw time', async () => {
    const earlyMorning = new Date(`${todayInWarsaw()}T05:30:00Z`);
    expect(await runAt(earlyMorning)).toEqual({ sentCount: 0 });
    expect(mails()).toHaveLength(0);
  });

  test('every assignee and every PM gets one mail; the tenant admin is not added', async () => {
    expect(await runAt(today())).toEqual({ sentCount: 4 });
    expect(mails().map((mail) => mail.to).sort()).toEqual(emailsOf(worker, external, pm, polishPm));
    expect(mailsTo(admin)).toHaveLength(0);
  });

  test('an assignee — also an external one — reads own overdue tasks, the new ones first', async () => {
    await runAt(today());
    const [mail] = mailsTo(worker);
    expect(mail.subject).toBe(`[CRMtree] Overdue tasks — ${englishDate(day(0))}`);
    expect(mail.html).toContain('Your overdue tasks');
    expect(mail.html).not.toContain('Overdue tasks in your projects');
    expect(mail.html.indexOf('Świeże zadanie')).toBeLessThan(mail.html.indexOf('Stare zadanie'));
    expect(mail.html).toContain(`due: ${englishDate(day(-1))} · 1 day overdue`);
    expect(mail.html).toContain(`due: ${englishDate(day(-5))} · 5 days overdue`);
    expect(mail.html.match(/badge-red">new</g)).toHaveLength(1);
    expect(mail.html).toContain(`/projects/${project.id}?task=${newlyOverdue.id}"`);
    expect(mail.html).not.toContain('Na czas');
    expect(mail.html).not.toContain('Skończone po czasie');
    expect(mail.html).not.toContain('Zadanie PM-a');
    expect(mail.html).toContain('You can switch project deadline notifications off in My settings.');

    const [toExternal] = mailsTo(external);
    expect(toExternal.html).toContain('Stare zadanie');
    expect(toExternal.html).not.toContain('Świeże zadanie');
  });

  test('a PM reads the overdue tasks of the project with assignees; a PM with own tasks gets both parts in one mail', async () => {
    await runAt(today());
    expect(mailsTo(pm)).toHaveLength(1);
    const [mail] = mailsTo(pm);
    expect(mail.html).toContain('Your overdue tasks');
    expect(mail.html).toContain('Overdue tasks in your projects');
    expect(mail.html).toContain('Wdrożenie Terminów');
    expect(mail.html).toContain('assigned to: eexternal Test, eworker Test');
    expect(mail.html).toContain(`${project.key}-${pmOwn.task_number} Zadanie PM-a`);
    const managedPart = mail.html.slice(mail.html.indexOf('Overdue tasks in your projects'));
    expect(managedPart.indexOf('Świeże zadanie')).toBeLessThan(managedPart.indexOf('Stare zadanie'));

    // The other PM has no task of their own, and reads the mail in Polish.
    const [polish] = mailsTo(polishPm);
    expect(polish.subject).toBe(`[CRMtree] Zadania po terminie — ${polishDate(day(0))}`);
    expect(polish.html).toContain('<html lang="pl">');
    expect(polish.html).not.toContain('Twoje zadania po terminie');
    expect(polish.html).toContain('Zadania po terminie w Twoich projektach');
    expect(polish.html).toContain(`termin: ${polishDate(day(-5))} · 5 dni po terminie`);
    expect(polish.html).toContain('1 dzień po terminie');
    expect(polish.html).toContain('osoby: eexternal Test, eworker Test');
    expect(polish.html.match(/badge-red">nowe</g)).toHaveLength(1);
  });

  test('goes out once per person per day, however often the job ticks or restarts', async () => {
    expect((await runAt(today())).sentCount).toBe(4);
    sendMailSpy.mockClear();
    expect((await runAt(today())).sentCount).toBe(0);
    expect((await runAt(new Date(today().getTime() + 3 * 3_600_000))).sentCount).toBe(0);
    expect(mails()).toHaveLength(0);

    const { rows } = await db.query(
      'SELECT user_id, digest_date FROM project_deadline_digests WHERE tenant_id = $1', [tenantId],
    );
    expect(rows.map((row) => row.user_id).sort()).toEqual([worker.id, external.id, pm.id, polishPm.id].sort());
    expect(new Set(rows.map((row) => row.digest_date))).toEqual(new Set([day(0)]));

    // The next day everybody is written to again, with one more day on the counter.
    expect((await runAt(afternoonOf(day(1)))).sentCount).toBe(4);
    expect(mailsTo(worker)[0].html).toContain('6 days overdue');
  });

  test('a person who gained something to report later the same day is still written to once', async () => {
    await setNotifications(worker, false);
    await db.query('DELETE FROM project_task_assignees WHERE user_id = $1', [external.id]);
    expect((await runAt(today())).sentCount).toBe(2);

    await patchTask(pm, longOverdue, { assignee_ids: [external.id] });
    sendMailSpy.mockClear();
    expect((await runAt(today())).sentCount).toBe(1);
    expect(mails().map((mail) => mail.to)).toEqual([external.email]);
  });

  test('a user who switched the notifications off gets neither part', async () => {
    await setNotifications(worker, false);
    await setNotifications(pm, false);
    expect((await runAt(today())).sentCount).toBe(2);
    expect(mails().map((mail) => mail.to).sort()).toEqual(emailsOf(external, polishPm));
  });

  test('lists the delayed projects of a PM with the reason, marking an end date that passed today', async () => {
    await db.query('DELETE FROM project_tasks WHERE project_id = $1', [project.id]);
    await createTask({ name: 'Bez terminu' });
    await createTask({ name: 'Daleko', end_date: day(6) });
    await db.query('UPDATE projects SET end_date = $1 WHERE id = $2', [day(-1), project.id]);

    // Nothing is overdue, but the project is delayed: only its PMs are written to.
    expect((await runAt(today())).sentCount).toBe(2);
    const [mail] = mailsTo(pm);
    expect(mail.html).not.toContain('Overdue tasks in your projects');
    expect(mail.html).toContain('Delayed projects');
    expect(mail.html).toContain(`Unfinished tasks due after the project end: 1. Latest due date: ${englishDate(day(6))} (7 days after the project end).`);
    expect(mail.html).toContain(`The project end date passed on ${englishDate(day(-1))} (1 day ago) and unfinished tasks remain: 2.`);
    expect(mail.html.match(/badge-red">new</g)).toHaveLength(1);

    const [polish] = mailsTo(polishPm);
    expect(polish.html).toContain('Opóźnione projekty');
    expect(polish.html).toContain(`Termin zakończenia projektu minął ${polishDate(day(-1))} (1 dzień temu), a niezakończonych zadań jest: 2.`);

    // A day later the end date is old news: reported, no longer marked as new.
    sendMailSpy.mockClear();
    await runAt(afternoonOf(day(1)));
    expect(mailsTo(pm)[0].html).toContain('(2 days ago)');
    expect(mailsTo(pm)[0].html).not.toContain('badge-red">new<');
  });

  test('a closed project sends nothing', async () => {
    await api('post', `/api/projects/${project.id}/close`, pm);
    try {
      expect(await runAt(today())).toEqual({ sentCount: 0 });
      expect(mails()).toHaveLength(0);
    } finally {
      await api('post', `/api/projects/${project.id}/reopen`, pm);
    }
  });

  test('a failing mail server does not break the run, and the person is written to on the next tick', async () => {
    jest.spyOn(emailUtil, 'sendProjectDeadlineSummary').mockRejectedValueOnce(new Error('smtp down'));
    await expect(runAt(today())).resolves.toEqual({ sentCount: 3 });

    emailUtil.sendProjectDeadlineSummary.mockRestore();
    sendMailSpy.mockClear();
    expect((await runAt(today())).sentCount).toBe(1);
    expect(mails()).toHaveLength(1);
  });
});
