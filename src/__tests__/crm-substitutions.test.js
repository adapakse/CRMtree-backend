'use strict';

// Substitutions module — critical permissions / RBAC / edge cases + the substitute-scope extension
// (an active substitution grants the same access to the absent person's
// leads/partners as the assigned salesperson).
//
// Multi-tenant: everything is created under one dedicated test tenant and
// cleaned up by tenant_id.

const request = require('supertest');
const app       = require('../app');
const db        = require('../config/database');
const emailUtil = require('../utils/email');
const { signAccessToken } = require('../middleware/auth');

const SLUG         = 'zz-subst-test';
const EMAIL_DOMAIN = '@subst-test.crmtree.local';
const GROUP_NAME   = 'SubstTestGroup';

let tenantId;
let adminTok, mgrTok, spaTok, spbTok, spcTok, noRoleTok;
let adminId, mgrId, spaId, spbId, spcId;

const D = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function mkUser(local, { admin = false, role = null } = {}) {
  const { rows: [u] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, tenant_id)
     VALUES ($1,$2,'Test',$3,TRUE,$4,$5) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, admin, role, tenantId],
  );
  return u;
}

async function cleanup() {
  await db.query(
    `DELETE FROM crm_lead_activities WHERE lead_id IN (
       SELECT id FROM crm_leads WHERE tenant_id = $1)`,
    [tenantId],
  );
  await db.query(`DELETE FROM crm_leads    WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_absences WHERE tenant_id = $1`, [tenantId]);
  await db.query(
    `DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%${EMAIL_DOMAIN}`],
  );
  await db.query(`DELETE FROM user_group_roles WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM group_profiles   WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%${EMAIL_DOMAIN}`]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active)
     VALUES ('Subst Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;

  await cleanup();

  const admin  = await mkUser('sadmin', { admin: true });
  const mgr    = await mkUser('smgr',   { role: 'sales_manager' });
  const spa    = await mkUser('spa',    { role: 'salesperson' });
  const spb    = await mkUser('spb',    { role: 'salesperson' });
  const spc    = await mkUser('spc',    { role: 'salesperson' });
  const noRole = await mkUser('snorole', {});

  adminId = admin.id; mgrId = mgr.id; spaId = spa.id; spbId = spb.id; spcId = spc.id;
  adminTok  = signAccessToken(admin);
  mgrTok    = signAccessToken(mgr);
  spaTok    = signAccessToken(spa);
  spbTok    = signAccessToken(spb);
  spcTok    = signAccessToken(spc);
  noRoleTok = signAccessToken(noRole);

  // Group: manager + spa + spb (spc deliberately left out)
  const { rows: [g] } = await db.query(
    `INSERT INTO group_profiles (name, display_name, tenant_id)
     VALUES ($1, 'Subst Test Group', $2) RETURNING id`,
    [GROUP_NAME, tenantId],
  );
  for (const uid of [mgrId, spaId, spbId]) {
    await db.query(
      `INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id)
       VALUES ($1,$2,'full',$3)`,
      [uid, g.id, tenantId],
    );
  }
});

afterAll(async () => {
  await cleanup();
  await db.query(`DELETE FROM tenants WHERE slug = $1`, [SLUG]);
});

beforeEach(async () => {
  await db.query(
    `DELETE FROM crm_lead_activities WHERE lead_id IN (
       SELECT id FROM crm_leads WHERE tenant_id = $1)`,
    [tenantId],
  );
  await db.query(`DELETE FROM crm_leads    WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_absences WHERE tenant_id = $1`, [tenantId]);
  await db.query(
    `DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%${EMAIL_DOMAIN}`],
  );
});

async function mkLead(ownerId, company) {
  const { rows: [l] } = await db.query(
    `INSERT INTO crm_leads (company, stage, assigned_to, created_by, tenant_id)
     VALUES ($1, 'new', $2, $2, $3) RETURNING id`,
    [company, ownerId, tenantId],
  );
  return l.id;
}

async function mkAbsenceRow({ absent, substitute, starts, ends, cancelled = false }) {
  const { rows: [a] } = await db.query(
    `INSERT INTO crm_absences
       (tenant_id, absent_user_id, substitute_user_id, starts_on, ends_on, reason, created_by, cancelled_at, cancelled_by)
     VALUES ($1,$2,$3,$4,$5,'vacation',$3,$6,$7) RETURNING id`,
    [tenantId, absent, substitute, starts, ends, cancelled ? new Date() : null, cancelled ? absent : null],
  );
  return a.id;
}

const post = (tok, body) =>
  request(app).post('/api/crm/substitutions').set('Authorization', `Bearer ${tok}`).send(body);
const list = (tok) =>
  request(app).get('/api/crm/substitutions').set('Authorization', `Bearer ${tok}`);
const del = (tok, id) =>
  request(app).delete(`/api/crm/substitutions/${id}`).set('Authorization', `Bearer ${tok}`);

describe('auth', () => {
  test('401 bez tokena', async () => {
    expect((await request(app).get('/api/crm/substitutions')).status).toBe(401);
  });
  test('403 user bez roli CRM', async () => {
    expect((await list(noRoleTok)).status).toBe(403);
  });
});

describe('POST — utworzenie i walidacje', () => {
  test('salesperson tworzy zastępstwo dla siebie → 201 + kształt + audit = zastępujący', async () => {
    const res = await post(spaTok, {
      substitute_user_id: spbId, starts_on: D(3), ends_on: D(7),
      reason: 'vacation', note: 'pilne do spb',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      absent_user_id: spaId, substitute_user_id: spbId,
      starts_on: D(3), ends_on: D(7), reason: 'vacation', note: 'pilne do spb',
      cancelled_at: null,
    });
    expect(res.body.absent_user_name).toBe('spa Test');
    expect(res.body.substitute_user_name).toBe('spb Test');

    const audit = await db.query(
      `SELECT user_id FROM audit_logs WHERE action = 'crm_substitution_create'
         AND user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`%${EMAIL_DOMAIN}`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].user_id).toBe(spaId);
  });

  test('400 — wskazanie samego siebie', async () => {
    const res = await post(spaTok, { substitute_user_id: spaId, starts_on: D(3), ends_on: D(7) });
    expect(res.status).toBe(400);
  });

  test('400 — ends_on < starts_on', async () => {
    const res = await post(spaTok, { substitute_user_id: spbId, starts_on: D(7), ends_on: D(3) });
    expect(res.status).toBe(400);
  });

  test('400 — okno w całości w przeszłości', async () => {
    const res = await post(spaTok, { substitute_user_id: spbId, starts_on: D(-10), ends_on: D(-3) });
    expect(res.status).toBe(400);
  });

  test('409 — zastępca ma własną nieobecność w nakładającym się terminie', async () => {
    await post(spbTok, { substitute_user_id: spaId, starts_on: D(5), ends_on: D(10) }).expect(201);
    const res = await post(spcTok, { substitute_user_id: spbId, starts_on: D(8), ends_on: D(12) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/własną nieobecność/i);
  });

  test('409 — nakładająca się nieobecność tej samej osoby', async () => {
    await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) }).expect(201);
    const res = await post(spaTok, { substitute_user_id: spcId, starts_on: D(6), ends_on: D(9) });
    expect(res.status).toBe(409);
  });

  test('201 — druga, nienakładająca się nieobecność tej samej osoby', async () => {
    await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) }).expect(201);
    const res = await post(spaTok, { substitute_user_id: spcId, starts_on: D(8), ends_on: D(12) });
    expect(res.status).toBe(201);
  });

  test('jedna osoba zastępuje kilka osób jednocześnie — dozwolone', async () => {
    await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) }).expect(201);
    const res = await post(spcTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect(res.status).toBe(201);
  });

  test('DB constraint — nakładające się nieodwołane okno tej samej osoby odrzucone (23P01, nie 500)', async () => {
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(3), ends: D(7) });
    await expect(
      mkAbsenceRow({ absent: spaId, substitute: spcId, starts: D(5), ends: D(9) }),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  test('DB constraint — odwołane okno nie blokuje nowego nakładającego się', async () => {
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(3), ends: D(7), cancelled: true });
    await expect(
      mkAbsenceRow({ absent: spaId, substitute: spcId, starts: D(5), ends: D(9) }),
    ).resolves.toBeDefined();
  });
});

describe('POST — uprawnienia „za kogoś”', () => {
  test('403 — salesperson w imieniu innej osoby', async () => {
    const res = await post(spaTok, {
      absent_user_id: spbId, substitute_user_id: spcId, starts_on: D(3), ends_on: D(7),
    });
    expect(res.status).toBe(403);
  });

  test('201 — manager dla członka swojej grupy; audit on_behalf', async () => {
    const res = await post(mgrTok, {
      absent_user_id: spaId, substitute_user_id: spbId, starts_on: D(3), ends_on: D(7),
    });
    expect(res.status).toBe(201);
    const audit = await db.query(
      `SELECT user_id, metadata FROM audit_logs WHERE action = 'crm_substitution_create'
         AND user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`%${EMAIL_DOMAIN}`],
    );
    expect(audit.rows[0].user_id).toBe(mgrId);
    expect(audit.rows[0].metadata.on_behalf).toBe(true);
  });

  test('403 — manager dla osoby spoza grupy (spc)', async () => {
    const res = await post(mgrTok, {
      absent_user_id: spcId, substitute_user_id: spaId, starts_on: D(3), ends_on: D(7),
    });
    expect(res.status).toBe(403);
  });

  test('403 — manager będący zastępcą osoby spoza grupy próbuje utworzyć nieobecność za tę osobę', async () => {
    // Being an active substitute of spc does NOT grant the right to manage spc's
    // absence — spc is outside the manager's group (permission bleed fix).
    await mkAbsenceRow({ absent: spcId, substitute: mgrId, starts: D(1), ends: D(5) });
    const res = await post(mgrTok, {
      absent_user_id: spcId, substitute_user_id: spaId, starts_on: D(10), ends_on: D(14),
    });
    expect(res.status).toBe(403);
  });

  test('201 — admin dla dowolnej osoby (spc, poza grupą)', async () => {
    const res = await post(adminTok, {
      absent_user_id: spcId, substitute_user_id: spaId, starts_on: D(3), ends_on: D(7),
    });
    expect(res.status).toBe(201);
  });
});

describe('GET — widoczność', () => {
  test('nieobecny i zastępca widzą wpis; osoba trzecia nie', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect((await list(spaTok)).body.map(r => r.id)).toContain(body.id);
    expect((await list(spbTok)).body.map(r => r.id)).toContain(body.id);
    expect((await list(spcTok)).body.map(r => r.id)).not.toContain(body.id);
  });

  test('manager widzi nieobecności członków grupy; admin widzi wszystko', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect((await list(mgrTok)).body.map(r => r.id)).toContain(body.id);
    expect((await list(adminTok)).body.map(r => r.id)).toContain(body.id);
  });
});

describe('DELETE — odwołanie', () => {
  test('nieobecny odwołuje własny wpis → cancelled_at; ponowne DELETE → 409; audit cancel', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    const res = await del(spaTok, body.id);
    expect(res.status).toBe(200);
    expect(res.body.cancelled_at).toBeTruthy();
    expect(res.body.cancelled_by).toBe(spaId);

    expect((await del(spaTok, body.id)).status).toBe(409);

    const audit = await db.query(
      `SELECT 1 FROM audit_logs WHERE action = 'crm_substitution_cancel'
         AND user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`%${EMAIL_DOMAIN}`],
    );
    expect(audit.rows).toHaveLength(1);
  });

  test('403 — zastępca (nie nieobecny) próbuje odwołać', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect((await del(spbTok, body.id)).status).toBe(403);
  });

  test('manager odwołuje wpis członka grupy', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect((await del(mgrTok, body.id)).status).toBe(200);
  });

  test('admin odwołuje dowolny wpis', async () => {
    const { body } = await post(spaTok, { substitute_user_id: spbId, starts_on: D(3), ends_on: D(7) });
    expect((await del(adminTok, body.id)).status).toBe(200);
  });

  test('403 — manager odwołuje wpis osoby spoza swojej grupy (spc)', async () => {
    const { body } = await post(spcTok, { substitute_user_id: spaId, starts_on: D(3), ends_on: D(7) });
    expect((await del(mgrTok, body.id)).status).toBe(403);
  });

  test('403 — manager będący zastępcą osoby spoza grupy NIE może odwołać jej wpisu', async () => {
    const id = await mkAbsenceRow({ absent: spcId, substitute: mgrId, starts: D(1), ends: D(5) });
    expect((await del(mgrTok, id)).status).toBe(403);
  });

  test('404 — odwołanie nieistniejącego wpisu', async () => {
    expect((await del(spaTok, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('powiadomienie e-mail dla zastępcy', () => {
  test('route wywołuje sendSubstitutionAssigned z danymi zastępcy (w tym opcjonalną notatką)', async () => {
    const spy = jest.spyOn(emailUtil, 'sendSubstitutionAssigned').mockResolvedValue();
    await post(spaTok, {
      substitute_user_id: spbId, starts_on: D(3), ends_on: D(7), reason: 'sick_leave',
      note: 'pilne sprawy kierować do spb',
    }).expect(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      to: `spb${EMAIL_DOMAIN}`,
      substituteName: 'spb Test',
      absentName: 'spa Test',
      assignerName: 'spa Test',
      startsOn: D(3),
      endsOn: D(7),
      reason: 'sick_leave',
      note: 'pilne sprawy kierować do spb',
    });
    spy.mockRestore();
  });

  test('brak notatki → sendSubstitutionAssigned dostaje note = null', async () => {
    const spy = jest.spyOn(emailUtil, 'sendSubstitutionAssigned').mockResolvedValue();
    await post(spaTok, {
      substitute_user_id: spbId, starts_on: D(3), ends_on: D(7), reason: 'vacation',
    }).expect(201);
    expect(spy.mock.calls[0][0].note).toBeNull();
    spy.mockRestore();
  });

  test('błąd wysyłki maila NIE cofa utworzenia zastępstwa', async () => {
    const spy = jest.spyOn(emailUtil, 'sendSubstitutionAssigned')
      .mockRejectedValue(new Error('SMTP down'));
    const res = await post(spaTok, {
      substitute_user_id: spbId, starts_on: D(3), ends_on: D(7), reason: 'vacation',
    });
    expect(res.status).toBe(201);
    const { rows } = await db.query(
      `SELECT id FROM crm_absences WHERE id = $1 AND tenant_id = $2`, [res.body.id, tenantId],
    );
    expect(rows).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('treść maila „wskazano Cię jako zastępcę”', () => {
  let sendMailSpy;
  const base = {
    to: 'zastepca@example.com',
    substituteName: 'Jan Kowalski',
    absentName: 'Anna Nowak',
    assignerName: 'Anna Nowak',
    startsOn: '2026-09-10',
    endsOn: '2026-09-17',
    reason: 'vacation',
  };
  const lastHtml = () => sendMailSpy.mock.calls[0][0].html;

  beforeEach(() => { sendMailSpy = jest.spyOn(emailUtil, 'sendMail').mockResolvedValue(); });
  afterEach(() => { sendMailSpy.mockRestore(); });

  test('używa wrappera/brandingu CRMtree i zawiera wymagane dane', async () => {
    await emailUtil.sendSubstitutionAssigned({ ...base, note: null });
    const html = lastHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('class="wrap"');
    expect(html).toContain('CRM<span>tree</span>');
    expect(html).toContain('class="info-box"');
    expect(html).toContain('badge badge-orange');
    expect(html).not.toContain('worktrips');
    expect(html).toContain('Anna Nowak');
    expect(html).toContain('10.09.2026');
    expect(html).toContain('17.09.2026');
    expect(html).toContain('Urlop');
  });

  test('renderuje sekcję „Notatka”, gdy note została podana', async () => {
    const note = 'Pilne oferty kierować do Piotra, faktury proforma już wysłane.';
    await emailUtil.sendSubstitutionAssigned({ ...base, note });
    const html = lastHtml();
    expect(html).toContain('>Notatka<');
    expect(html).toContain(note);
  });

  test('escapuje HTML w notatce i zachowuje nowe linie jako <br>', async () => {
    await emailUtil.sendSubstitutionAssigned({
      ...base,
      note: 'Linia 1\nLinia 2 <b>x</b> & <script>alert(1)</script>',
    });
    const html = lastHtml();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('Linia 1<br>Linia 2');
  });

  test('pomija sekcję „Notatka”, gdy note jest pusta / null / undefined', async () => {
    for (const note of ['', null, undefined]) {
      sendMailSpy.mockClear();
      await emailUtil.sendSubstitutionAssigned({ ...base, note });
      expect(lastHtml()).not.toContain('>Notatka<');
    }
  });
});

describe('RBAC — aktywne zastępstwo rozszerza scope (odczyt + zapis + can_edit)', () => {
  const listLeads = (tok) =>
    request(app).get('/api/crm/leads').set('Authorization', `Bearer ${tok}`);
  const getLead = (tok, id) =>
    request(app).get(`/api/crm/leads/${id}`).set('Authorization', `Bearer ${tok}`);
  const patchLead = (tok, id, body) =>
    request(app).patch(`/api/crm/leads/${id}`).set('Authorization', `Bearer ${tok}`).send(body);

  test('aktywne zastępstwo → odczyt, can_edit, zapis; audit = zastępca', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA active');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(-1), ends: D(3) });

    expect((await listLeads(spbTok)).body.data.map(r => r.id)).toContain(leadSpa);
    expect((await getLead(spbTok, leadSpa)).body.can_edit).toBe(true);

    const patched = await patchLead(spbTok, leadSpa, { notes: 'wpis zastępcy' });
    expect(patched.status).toBe(200);

    const audit = await db.query(
      `SELECT user_id FROM audit_logs WHERE action = 'crm_lead_update'
         AND user_id IN (SELECT id FROM users WHERE email LIKE $1)
       ORDER BY created_at DESC LIMIT 1`,
      [`%${EMAIL_DOMAIN}`],
    );
    expect(audit.rows[0].user_id).toBe(spbId);
  });

  test('aktywne zastępstwo → tworzenie i edycja aktywności na leadzie osoby nieobecnej', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA act');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(0), ends: D(0) });

    const created = await request(app)
      .post(`/api/crm/leads/${leadSpa}/activities`)
      .set('Authorization', `Bearer ${spbTok}`)
      .send({ type: 'call', title: 'telefon' });
    expect(created.status).toBe(201);

    const upd = await request(app)
      .patch(`/api/crm/leads/${leadSpa}/activities/${created.body.id}`)
      .set('Authorization', `Bearer ${spbTok}`)
      .send({ title: 'telefon (zmiana)' });
    expect(upd.status).toBe(200);
  });

  test('przyszłe zastępstwo → brak dostępu', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA future');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(3), ends: D(7) });
    expect((await listLeads(spbTok)).body.data.map(r => r.id)).not.toContain(leadSpa);
    expect((await getLead(spbTok, leadSpa)).body.can_edit).toBe(false);
    expect((await patchLead(spbTok, leadSpa, { notes: 'x' })).status).toBe(403);
  });

  test('zakończone zastępstwo → brak dostępu', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA ended');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(-10), ends: D(-3) });
    expect((await listLeads(spbTok)).body.data.map(r => r.id)).not.toContain(leadSpa);
    expect((await patchLead(spbTok, leadSpa, { notes: 'x' })).status).toBe(403);
  });

  test('odwołane zastępstwo (okno aktywne) → brak dostępu', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA cancelled');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(-1), ends: D(5), cancelled: true });
    expect((await listLeads(spbTok)).body.data.map(r => r.id)).not.toContain(leadSpa);
    expect((await patchLead(spbTok, leadSpa, { notes: 'x' })).status).toBe(403);
  });

  test('kilka równoczesnych zastępstw → scope obejmuje wszystkie', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA multi');
    const leadSpc = await mkLead(spcId, 'Lead SPC multi');
    await mkAbsenceRow({ absent: spaId, substitute: spbId, starts: D(-1), ends: D(3) });
    await mkAbsenceRow({ absent: spcId, substitute: spbId, starts: D(0),  ends: D(5) });

    const ids = (await listLeads(spbTok)).body.data.map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining([leadSpa, leadSpc]));
    expect((await patchLead(spbTok, leadSpa, { notes: 'a' })).status).toBe(200);
    expect((await patchLead(spbTok, leadSpc, { notes: 'b' })).status).toBe(200);
  });

  test('handlowiec bez zastępstwa → tylko własne, brak dodatkowego dostępu', async () => {
    const leadSpa = await mkLead(spaId, 'Lead SPA own');
    const leadSpc = await mkLead(spcId, 'Lead SPC other');
    const ids = (await listLeads(spaTok)).body.data.map(r => r.id);
    expect(ids).toContain(leadSpa);
    expect(ids).not.toContain(leadSpc);
    expect((await getLead(spaTok, leadSpc)).body.can_edit).toBe(false);
    expect((await patchLead(spaTok, leadSpc, { notes: 'x' })).status).toBe(403);
  });
});
