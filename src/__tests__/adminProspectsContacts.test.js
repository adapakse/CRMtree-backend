'use strict';

// PATCH /api/admin/prospects/:id/score, /:id/contact, /:id/key-contacts — ręczna
// edycja score i kontaktów prospektu (port z worktrips.doc, 2026-11-09).

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');
const { normalizeKeyContacts } = require('../routes/admin-prospects');

const OWN_TENANT_SLUG = 'zz-prospects-contacts-test';
const OTHER_TENANT_SLUG = 'zz-prospects-contacts-other';
const OWN_NIP = '9999999911';
const OTHER_NIP = '9999999912';

let ownTenantId, otherTenantId, adminToken, ownProspectId, otherProspectId;

async function upsertTenant(name, slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [name, slug],
  );
  return tenant.id;
}

async function insertProspect(tenantId, nip) {
  await db.query('DELETE FROM prospect_companies WHERE nip = $1', [nip]);
  const { rows: [prospect] } = await db.query(
    `INSERT INTO prospect_companies
       (tenant_id, nip, company_name, icp_score, decision_maker_name, decision_maker_title,
        decision_maker_phone, decision_maker_email, key_contacts)
     VALUES ($1, $2, 'Kontakty Test sp. z o.o.', 40, 'Jan Stary', 'Prezes', '+48 111', 'jan@example.com',
             '[{"name":"Anna AI","title":"Handlowiec","email":"anna@example.com","phone":null}]'::jsonb)
     RETURNING id`,
    [tenantId, nip],
  );
  return prospect.id;
}

beforeAll(async () => {
  ownTenantId = await upsertTenant('Prospects Contacts Test Tenant', OWN_TENANT_SLUG);
  otherTenantId = await upsertTenant('Prospects Contacts Other Tenant', OTHER_TENANT_SLUG);

  await db.query(`DELETE FROM users WHERE email = 'admin@zz-prospects-contacts-test.worktrips.com'`);
  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id)
     VALUES ('admin@zz-prospects-contacts-test.worktrips.com', 'Admin', 'User', TRUE, $1) RETURNING *`,
    [ownTenantId],
  );
  adminToken = signAccessToken(admin);
});

beforeEach(async () => {
  ownProspectId = await insertProspect(ownTenantId, OWN_NIP);
  otherProspectId = await insertProspect(otherTenantId, OTHER_NIP);
});

afterAll(async () => {
  await db.query('DELETE FROM prospect_companies WHERE nip = ANY($1)', [[OWN_NIP, OTHER_NIP]]);
});

function patch(path, body) {
  return request(app).patch(`/api/admin/prospects${path}`).set('Authorization', `Bearer ${adminToken}`).send(body);
}

async function loadProspect(id) {
  const { rows: [row] } = await db.query('SELECT * FROM prospect_companies WHERE id = $1', [id]);
  return row;
}

describe('PATCH /:id/score', () => {
  test('zapisuje icp_score 0–100', async () => {
    const res = await patch(`/${ownProspectId}/score`, { icp_score: 77 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ownProspectId, icp_score: 77 });
    expect((await loadProspect(ownProspectId)).icp_score).toBe(77);
  });

  test.each([[-1], [101], [12.5], ['abc'], [null]])('odrzuca %p', async value => {
    const res = await patch(`/${ownProspectId}/score`, { icp_score: value });
    expect(res.status).toBe(400);
    expect((await loadProspect(ownProspectId)).icp_score).toBe(40);
  });

  test('prospekt innego tenanta → 404 i bez zmian', async () => {
    const res = await patch(`/${otherProspectId}/score`, { icp_score: 90 });
    expect(res.status).toBe(404);
    expect((await loadProspect(otherProspectId)).icp_score).toBe(40);
  });

  test('bez tokenu → 401', async () => {
    const res = await request(app).patch(`/api/admin/prospects/${ownProspectId}/score`).send({ icp_score: 50 });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /:id/contact', () => {
  test('zmienia tylko przekazane pole, pusty tekst czyści', async () => {
    const res = await patch(`/${ownProspectId}/contact`, { decision_maker_phone: '  +48 222  ', decision_maker_email: '' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision_maker_name: 'Jan Stary', decision_maker_phone: '+48 222', decision_maker_email: null,
    });
    expect((await loadProspect(ownProspectId)).decision_maker_title).toBe('Prezes');
  });

  test('aktualizuje też kontakt z rolą decision_maker w key_contacts', async () => {
    await db.query(
      `UPDATE prospect_companies SET key_contacts = $2::jsonb WHERE id = $1`,
      [ownProspectId, JSON.stringify([
        { name: 'Anna AI', title: null, email: 'anna@example.com', phone: null, role: null },
        { name: 'Jan Stary', title: 'Prezes', email: 'jan@example.com', phone: '+48 111', role: 'decision_maker' },
      ])],
    );
    const res = await patch(`/${ownProspectId}/contact`, { decision_maker_name: 'Jan Nowy' });
    expect(res.status).toBe(200);
    expect(res.body.key_contacts).toEqual([
      { name: 'Anna AI', title: null, email: 'anna@example.com', phone: null, role: null },
      { name: 'Jan Nowy', title: 'Prezes', email: 'jan@example.com', phone: '+48 111', role: 'decision_maker' },
    ]);
  });

  test('bez pól → 400', async () => {
    const res = await patch(`/${ownProspectId}/contact`, {});
    expect(res.status).toBe(400);
  });

  test('za długi telefon → 400', async () => {
    const res = await patch(`/${ownProspectId}/contact`, { decision_maker_phone: '1'.repeat(51) });
    expect(res.status).toBe(400);
  });

  test('prospekt innego tenanta → 404 i bez zmian', async () => {
    const res = await patch(`/${otherProspectId}/contact`, { decision_maker_name: 'Obcy' });
    expect(res.status).toBe(404);
    expect((await loadProspect(otherProspectId)).decision_maker_name).toBe('Jan Stary');
  });
});

describe('PATCH /:id/key-contacts', () => {
  test('dwóch decision_makerów w żądaniu → wygrywa pierwszy, pola decision_maker_* zsynchronizowane', async () => {
    const res = await patch(`/${ownProspectId}/key-contacts`, {
      contacts: [
        { name: 'Ewa Pierwsza', title: 'CEO', email: 'ewa@example.com', phone: '+48 333', role: 'decision_maker' },
        { name: 'Piotr Drugi', title: 'CFO', email: 'piotr@example.com', phone: null, role: 'decision_maker' },
        { name: '', title: '', email: '', phone: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.key_contacts).toEqual([
      { name: 'Ewa Pierwsza', title: 'CEO', email: 'ewa@example.com', phone: '+48 333', role: 'decision_maker' },
      { name: 'Piotr Drugi', title: 'CFO', email: 'piotr@example.com', phone: null, role: null },
    ]);
    const row = await loadProspect(ownProspectId);
    expect(row).toMatchObject({
      decision_maker_name: 'Ewa Pierwsza', decision_maker_title: 'CEO',
      decision_maker_phone: '+48 333', decision_maker_email: 'ewa@example.com',
    });
    expect(row.key_contacts.filter(c => c.role === 'decision_maker')).toHaveLength(1);
  });

  test('bez osoby decyzyjnej czyści pola decision_maker_*', async () => {
    const res = await patch(`/${ownProspectId}/key-contacts`, {
      contacts: [{ name: 'Anna AI', title: null, email: 'anna@example.com', phone: null, role: null }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision_maker_name: null, decision_maker_title: null, decision_maker_phone: null, decision_maker_email: null,
    });
  });

  test('pusta lista jest dozwolona', async () => {
    const res = await patch(`/${ownProspectId}/key-contacts`, { contacts: [] });
    expect(res.status).toBe(200);
    expect(res.body.key_contacts).toEqual([]);
  });

  test.each([
    ['ponad 20 kontaktów', { contacts: Array.from({ length: 21 }, (_, i) => ({ name: `Osoba ${i}` })) }],
    ['nieznana rola', { contacts: [{ name: 'X', role: 'owner' }] }],
    ['za długie imię', { contacts: [{ name: 'a'.repeat(201) }] }],
    ['za długi telefon', { contacts: [{ phone: '1'.repeat(51) }] }],
    ['brak tablicy', { contacts: 'x' }],
    ['element nie jest obiektem', { contacts: ['Jan'] }],
  ])('odrzuca: %s', async (_label, body) => {
    const res = await patch(`/${ownProspectId}/key-contacts`, body);
    expect(res.status).toBe(400);
    expect((await loadProspect(ownProspectId)).decision_maker_name).toBe('Jan Stary');
  });

  test('prospekt innego tenanta → 404 i bez zmian', async () => {
    const res = await patch(`/${otherProspectId}/key-contacts`, { contacts: [] });
    expect(res.status).toBe(404);
    const row = await loadProspect(otherProspectId);
    expect(row.decision_maker_name).toBe('Jan Stary');
    expect(row.key_contacts).toHaveLength(1);
  });
});

describe('POST /:id/to-lead po edycji kontaktów', () => {
  afterEach(async () => {
    await db.query(`DELETE FROM crm_leads WHERE tenant_id = $1 AND source = 'Prospekt'`, [ownTenantId]);
  });

  test('osoba decyzyjna z key_contacts nie dubluje się w kontaktach leada (sam telefon)', async () => {
    const saved = await patch(`/${ownProspectId}/key-contacts`, {
      contacts: [
        { name: null, title: null, email: null, phone: '+48 444', role: 'decision_maker' },
        { name: 'Anna AI', title: null, email: 'anna@example.com', phone: null, role: null },
      ],
    });
    expect(saved.status).toBe(200);

    const res = await request(app)
      .post(`/api/admin/prospects/${ownProspectId}/to-lead`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nip: OWN_NIP, force: true });
    expect(res.status).toBe(200);
    expect(res.body.contacts_total).toBe(2);
    const { rows } = await db.query(
      'SELECT phone FROM crm_leads WHERE id = $1', [res.body.crm_lead_id],
    );
    expect(rows[0].phone).toBe('+48 444');
  });
});

describe('normalizeKeyContacts', () => {
  test('ignoruje nieznane pola i zostawia jedną osobę decyzyjną', () => {
    const { contacts, decisionMaker } = normalizeKeyContacts([
      { name: 'A', role: 'decision_maker', tenant_id: 5 },
      { email: 'b@example.com', role: 'decision_maker' },
    ]);
    expect(contacts).toEqual([
      { name: 'A', title: null, email: null, phone: null, role: 'decision_maker' },
      { name: null, title: null, email: 'b@example.com', phone: null, role: null },
    ]);
    expect(decisionMaker.name).toBe('A');
  });
});
