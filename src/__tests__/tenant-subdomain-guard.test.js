"use strict";

const request = require("supertest");
const app = require("../app");
const db  = require("../config/database");
const bcrypt = require("bcryptjs");
const { signAccessToken } = require("../middleware/auth");

const TENANT_A_SLUG = "zz-subdomain-guard-a";
const TENANT_B_SLUG = "zz-subdomain-guard-b";
const USER_A_EMAIL  = "user-a@subdomain-guard.crmtree.local";
const PASSWORD      = "TestPass123!";

let tenantAId, tenantBId, userAToken;

beforeAll(async () => {
  const { rows: [tenantA] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Subdomain Guard Tenant A', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [TENANT_A_SLUG],
  );
  tenantAId = tenantA.id;

  const { rows: [tenantB] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Subdomain Guard Tenant B', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [TENANT_B_SLUG],
  );
  tenantBId = tenantB.id;

  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(`DELETE FROM users WHERE email LIKE '%@subdomain-guard.crmtree.local'`);

  const { rows: [userA] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, password_hash, tenant_id)
     VALUES ($1,'User','A',FALSE,TRUE,$2,$3) RETURNING *`,
    [USER_A_EMAIL, hash, tenantAId],
  );
  userAToken = signAccessToken(userA);
});

afterAll(async () => {
  await db.query(`DELETE FROM audit_logs     WHERE tenant_id IN ($1, $2)`, [tenantAId, tenantBId]);
  await db.query(`DELETE FROM refresh_tokens WHERE tenant_id IN ($1, $2)`, [tenantAId, tenantBId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@subdomain-guard.crmtree.local'`);
  // Tenants left intentionally — reused on next run via ON CONFLICT
});

describe("tenant subdomain isolation guard (GET /api/auth/me)", () => {
  test("200 on app.crmtree.pl regardless of the session's tenant (universal fallback)", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Host", "app.crmtree.pl")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
  });

  test("200 on the session's own tenant subdomain", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Host", `${TENANT_A_SLUG}.crmtree.pl`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
  });

  test("403 TENANT_HOST_MISMATCH on a different tenant's subdomain", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Host", `${TENANT_B_SLUG}.crmtree.pl`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TENANT_HOST_MISMATCH");
  });

  test("403 TENANT_HOST_MISMATCH on an unrecognized subdomain (no matching tenant row) — a live session must not be usable there either", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Host", "no-such-tenant-xyz.crmtree.pl")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TENANT_HOST_MISMATCH");
  });

  // The frontend's own SSR reverse-proxy (server.ts) sits between the browser
  // and this API in production, and its changeOrigin:true rewrites the real
  // Host header to the API's own upstream host — so the request this backend
  // actually receives never carries the tenant subdomain in Host/req.hostname.
  // server.ts compensates by forwarding it via a custom X-CRM-Tenant-Host
  // header (see resolveRequestHost in config/tenantHost.js). These cases
  // simulate exactly that: a request whose Host is something else entirely,
  // with the real tenant host only present in X-CRM-Tenant-Host.
  describe("via the frontend's reverse-proxy (X-CRM-Tenant-Host header)", () => {
    test("403 TENANT_HOST_MISMATCH when X-CRM-Tenant-Host is a different tenant, even if Host is not a tenant host at all", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Host", "crmtree-backend.internal.azurecontainerapps.io")
        .set("X-CRM-Tenant-Host", `${TENANT_B_SLUG}.crmtree.pl`)
        .set("Authorization", `Bearer ${userAToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("TENANT_HOST_MISMATCH");
    });

    test("200 when X-CRM-Tenant-Host matches the session's own tenant", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Host", "crmtree-backend.internal.azurecontainerapps.io")
        .set("X-CRM-Tenant-Host", `${TENANT_A_SLUG}.crmtree.pl`)
        .set("Authorization", `Bearer ${userAToken}`);
      expect(res.status).toBe(200);
    });
  });
});
