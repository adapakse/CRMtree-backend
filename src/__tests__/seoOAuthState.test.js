'use strict';

// OAuth callbacks for GSC / LinkedIn / Facebook must return the user to the
// tenant subdomain they started from, not the global app host (2026-09-28).

const crypto = require('crypto');
const config = require('../config');
const { makeOAuthState, parseOAuthState, returnHostFor, frontendBaseFor } = require('../utils/seoOAuthState');

const TENANT = '1e610ab7-1f34-427f-bd05-b4094b8077c7';
const USER = '42';

describe('seoOAuthState', () => {
  it('round-trips the tenant subdomain and sends the user back there', () => {
    const parsed = parseOAuthState(makeOAuthState(TENANT, USER, 'comparme.crmtree.pl'));
    expect(parsed).toEqual({ tenantId: TENANT, userId: USER, returnHost: 'comparme.crmtree.pl' });
    expect(frontendBaseFor(parsed)).toBe('https://comparme.crmtree.pl');
  });

  it('falls back to the global app host without a subdomain', () => {
    const parsed = parseOAuthState(makeOAuthState(TENANT, USER));
    expect(parsed.returnHost).toBe('');
    expect(frontendBaseFor(parsed)).toBe(config.frontendUrl);
    expect(frontendBaseFor(null)).toBe(config.frontendUrl);
  });

  it('rejects a state whose return host was swapped', () => {
    const [tenantId, userId, ts, , sig] = makeOAuthState(TENANT, USER, 'comparme.crmtree.pl').split('.');
    const forged = [tenantId, userId, ts, Buffer.from('evil.example.com').toString('base64url'), sig].join('.');
    expect(parseOAuthState(forged)).toBeNull();
  });

  it('still accepts a legacy 4-part state issued before the deploy', () => {
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', config.jwt.secret).update(`${TENANT}:${USER}:${ts}`).digest('hex').slice(0, 16);
    expect(parseOAuthState(`${TENANT}.${USER}.${ts}.${sig}`)).toEqual({ tenantId: TENANT, userId: USER, returnHost: '' });
  });

  it('records only tenant subdomains as the return host', () => {
    expect(returnHostFor({ headers: { 'x-crm-tenant-host': 'comparme.crmtree.pl' } })).toBe('comparme.crmtree.pl');
    expect(returnHostFor({ headers: { 'x-crm-tenant-host': 'app.crmtree.pl' } })).toBe('');
    expect(returnHostFor({ headers: { 'x-crm-tenant-host': 'evil.example.com' } })).toBe('');
    expect(returnHostFor({ headers: {}, hostname: 'localhost' })).toBe('');
  });
});
