'use strict';

// POST /api/admin/prospects/import — two column rules:
//  - "Komórka" holds a mobile number in some source files and an organisational
//    unit in others; a phone number must not end up in the department field;
//  - an address corrected by hand must survive a re-import of the same file.

const request = require('supertest');
const app = require('../app');
const db = require('../config/database');
const { signAccessToken } = require('../middleware/auth');

const TENANT_SLUG = 'zz-prospects-import-columns';
const ADMIN_EMAIL = 'admin@zz-prospects-import-columns.worktrips.com';
const NIP = { mobile: '9999999711', unit: '9999999712', both: '9999999713', corrected: '9999999714', plain: '9999999715' };
const ALL_NIPS = Object.values(NIP);
let tenantId, adminToken;

function importCsv(lines) {
  return request(app)
    .post('/api/admin/prospects/import')
    .set('Authorization', `Bearer ${adminToken}`)
    .attach('file', Buffer.from(lines.join('\n'), 'utf8'), 'import.csv');
}

async function prospect(nip) {
  const { rows } = await db.query(
    `SELECT decision_maker_phone, decision_maker_dept, website_url, website_source, enrichment_status
       FROM prospect_companies WHERE tenant_id = $1 AND nip = $2`, [tenantId, nip],
  );
  return rows[0];
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Prospects Import Columns Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`, [TENANT_SLUG],
  );
  tenantId = tenant.id;
  await db.query('DELETE FROM users WHERE email = $1', [ADMIN_EMAIL]);
  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, tenant_id) VALUES ($1, 'Admin', 'User', TRUE, $2) RETURNING *`,
    [ADMIN_EMAIL, tenantId],
  );
  adminToken = signAccessToken(admin);
});

const removeTestRows = () => db.query('DELETE FROM prospect_companies WHERE tenant_id = $1 AND nip = ANY($2)', [tenantId, ALL_NIPS]);
beforeEach(removeTestRows);
afterAll(removeTestRows);

describe('import — the "Komórka" column', () => {
  test('a mobile number goes to the phone field, not the department', async () => {
    const res = await importCsv(['BAZA;NIP;Nazwa;Komórka', `zz-columns;${NIP.mobile};Firma;48602350630`]);

    expect(res.body).toMatchObject({ added: 1, errors: 0 });
    expect(await prospect(NIP.mobile)).toMatchObject({ decision_maker_phone: '48602350630', decision_maker_dept: null });
  });

  test.each(['+48 602 350 630', '602-350-630', '(22) 123 45 67'])('a number written as "%s" is recognised as a phone', async (value) => {
    await importCsv(['BAZA;NIP;Nazwa;Komórka', `zz-columns;${NIP.mobile};Firma;${value}`]);

    expect(await prospect(NIP.mobile)).toMatchObject({ decision_maker_phone: value, decision_maker_dept: null });
  });

  test.each(['Dział Handlowy', 'Biuro Zarządu', 'IT', 'Oddział 2'])('an organisational unit "%s" stays in the department', async (value) => {
    await importCsv(['BAZA;NIP;Nazwa;Komórka;Telefon', `zz-columns;${NIP.unit};Firma;${value};48221234567`]);

    expect(await prospect(NIP.unit)).toMatchObject({ decision_maker_dept: value, decision_maker_phone: '48221234567' });
  });

  test('with both "Komórka" and "Telefon" the mobile number wins', async () => {
    await importCsv(['BAZA;NIP;Nazwa;Komórka;Telefon', `zz-columns;${NIP.both};Firma;48602350630;48221234567`]);

    expect(await prospect(NIP.both)).toMatchObject({ decision_maker_phone: '48602350630', decision_maker_dept: null });
  });

  test('an empty "Komórka" leaves "Telefon" as the phone', async () => {
    await importCsv(['BAZA;NIP;Nazwa;Komórka;Telefon', `zz-columns;${NIP.both};Firma;;48221234567`]);

    expect(await prospect(NIP.both)).toMatchObject({ decision_maker_phone: '48221234567', decision_maker_dept: null });
  });
});

describe('import — re-importing a file after a manual correction', () => {
  test('an address corrected by hand is not overwritten by the file', async () => {
    await importCsv(['BAZA;NIP;Nazwa;WWW', `zz-columns;${NIP.corrected};Firma;www.zly-adres.pl`]);
    await db.query(
      `UPDATE prospect_companies SET website_url = 'https://wlasciwy-adres.pl', website_source = 'manual_correction', enrichment_status = 'done'
        WHERE tenant_id = $1 AND nip = $2`, [tenantId, NIP.corrected],
    );

    const res = await importCsv(['BAZA;NIP;Nazwa;WWW', `zz-columns;${NIP.corrected};Firma;www.zly-adres.pl`]);

    expect(res.body).toMatchObject({ added: 0, skipped: 1 });
    expect(await prospect(NIP.corrected)).toMatchObject({
      website_url: 'https://wlasciwy-adres.pl', website_source: 'manual_correction', enrichment_status: 'done',
    });
  });

  test('an address that came from an earlier import is still updated by a newer file', async () => {
    await importCsv(['BAZA;NIP;Nazwa;WWW', `zz-columns;${NIP.plain};Firma;www.stary-adres.pl`]);

    await importCsv(['BAZA;NIP;Nazwa;WWW', `zz-columns;${NIP.plain};Firma;www.nowy-adres.pl`]);

    expect((await prospect(NIP.plain)).website_url).toContain('nowy-adres.pl');
  });
});
