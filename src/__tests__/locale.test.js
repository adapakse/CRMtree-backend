'use strict';

// Interface language: a user's own choice, the tenant default set by the
// tenant admin, and how the two resolve.

const request = require('supertest');
const app     = require('../app');
const db      = require('../config/database');
const { signAccessToken } = require('../middleware/auth');
const { resolveLocale, SUPPORTED_LOCALES } = require('../config/locales');

const SLUG         = 'zz-locale-test';
const EMAIL_DOMAIN = '@locale-test.crmtree.local';

let tenantId, admin, employee;
const tokens = {};

const api = (method, url, user) =>
  request(app)[method](url).set('Authorization', `Bearer ${tokens[user.id]}`);

async function mkUser(local, isAdmin) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, tenant_id)
     VALUES ($1, $2, 'Test', $3, TRUE, $4) RETURNING *`,
    [`${local}${EMAIL_DOMAIN}`, local, isAdmin, tenantId],
  );
  tokens[user.id] = signAccessToken(user);
  return user;
}

const cleanup = () => db.query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Locale Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, default_locale = 'pl' RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await cleanup();
  admin = await mkUser('ladmin', true);
  employee = await mkUser('lemployee', false);
});

afterAll(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

test('ten languages are supported, Polish is the fallback', () => {
  expect(SUPPORTED_LOCALES).toEqual(['pl', 'en', 'de', 'it', 'es', 'fr', 'ro', 'ru', 'sl', 'hr']);
  expect(resolveLocale({ userLocale: 'de', tenantDefaultLocale: 'en' })).toBe('de');
  expect(resolveLocale({ userLocale: null, tenantDefaultLocale: 'en' })).toBe('en');
  expect(resolveLocale({ userLocale: 'xx', tenantDefaultLocale: null })).toBe('pl');
});

test('a new user has no own language and reports the tenant default', async () => {
  const me = await api('get', '/api/auth/me', employee);
  expect(me.body).toMatchObject({ locale: null, tenant_default_locale: 'pl' });
});

test('a user sets and clears their own language', async () => {
  expect((await api('put', '/api/profile/locale', employee).send({ locale: 'de' })).status).toBe(200);
  expect((await api('get', '/api/auth/me', employee)).body.locale).toBe('de');

  expect((await api('put', '/api/profile/locale', employee).send({ locale: 'xx' })).status).toBe(400);

  expect((await api('put', '/api/profile/locale', employee).send({ locale: null })).status).toBe(200);
  expect((await api('get', '/api/auth/me', employee)).body.locale).toBeNull();
});

test('only the tenant admin changes the tenant default', async () => {
  expect((await api('put', '/api/admin/settings/default-locale', employee).send({ locale: 'en' })).status).toBe(403);
  expect((await api('put', '/api/admin/settings/default-locale', admin).send({ locale: 'xx' })).status).toBe(400);

  expect((await api('put', '/api/admin/settings/default-locale', admin).send({ locale: 'en' })).status).toBe(200);
  expect((await api('get', '/api/auth/me', employee)).body.tenant_default_locale).toBe('en');
});
