"use strict";

// POST /api/auth/mobile/login + mobile refresh tokens (ADR 001, crmtree-frontend
// docs/adr/001-mobile-app.md §2 and §4).

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { signAccessToken } = require("../middleware/auth");

const DOMAIN = "mobile-test.crmtree.local";
const PASSWORD = "MobilePass123!";
const OTHER_PASSWORD = "OtherPass456!";
const DEVICE = "device-test-0001";

let tenantA, tenantB;
const users = {};

async function upsertTenant(name, slug) {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [name, slug],
  );
  return t.id;
}

async function createUser(email, tenantId, crmRole, password) {
  const { rows: [u] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, crm_role, password_hash, tenant_id)
     VALUES ($1, 'Mobile', 'Test', TRUE, $2, $3, $4) RETURNING *`,
    [email, crmRole, await bcrypt.hash(password, 4), tenantId],
  );
  return u;
}

function mobileLogin(body) {
  return request(app).post("/api/auth/mobile/login").send({ device_id: DEVICE, device_name: "Test Phone", ...body });
}

const tokenRow = (refreshToken) => db.query(
  `SELECT client, device_id, device_name, revoked, expires_at FROM refresh_tokens WHERE token_hash = $1`,
  [crypto.createHash("sha256").update(refreshToken).digest("hex")],
).then((r) => r.rows[0]);

beforeAll(async () => {
  tenantA = await upsertTenant("Mobile Test A", "zz-mobile-a");
  tenantB = await upsertTenant("Mobile Test B", "zz-mobile-b");
  await db.query(`DELETE FROM refresh_tokens WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);

  // Same email, same password, allowed role in both tenants.
  users.multiA = await createUser(`multi@${DOMAIN}`, tenantA, "salesperson", PASSWORD);
  users.multiB = await createUser(`multi@${DOMAIN}`, tenantB, "sales_manager", PASSWORD);
  // Same email, different passwords per tenant.
  users.splitA = await createUser(`split@${DOMAIN}`, tenantA, "salesperson", PASSWORD);
  users.splitB = await createUser(`split@${DOMAIN}`, tenantB, "salesperson", OTHER_PASSWORD);
  // Only a non-sales role.
  users.admin = await createUser(`admin@${DOMAIN}`, tenantA, null, PASSWORD);
  // Single tenant, used for refresh / password-change tests.
  users.solo = await createUser(`solo@${DOMAIN}`, tenantA, "salesperson", PASSWORD);
});

afterAll(async () => {
  await db.query(`DELETE FROM audit_logs WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await db.query(`DELETE FROM refresh_tokens WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
});

describe("POST /api/auth/mobile/login", () => {
  test("one password matching two tenants returns both, each with its own tokens", async () => {
    const res = await mobileLogin({ email: `multi@${DOMAIN}`, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.tenant_slug).sort()).toEqual(["zz-mobile-a", "zz-mobile-b"]);
    const [a, b] = res.body.accounts;
    expect(a.access_token).not.toBe(b.access_token);
    expect(a.refresh_token).not.toBe(b.refresh_token);
    const row = await tokenRow(a.refresh_token);
    expect(row).toMatchObject({ client: "mobile", device_id: DEVICE, device_name: "Test Phone", revoked: false });
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(50 * 24 * 3600 * 1000);
  });

  test("email is matched case- and whitespace-insensitively", async () => {
    const res = await mobileLogin({ email: `  MULTI@${DOMAIN.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
  });

  test("different passwords per tenant: only the tenant the password matches is returned", async () => {
    const res = await mobileLogin({ email: `split@${DOMAIN}`, password: OTHER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.tenant_slug)).toEqual(["zz-mobile-b"]);
  });

  test("401 for a wrong password, without revealing any tenant", async () => {
    const res = await mobileLogin({ email: `multi@${DOMAIN}`, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.accounts).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/zz-mobile/);
  });

  test("401 for an unknown email", async () => {
    const res = await mobileLogin({ email: `nobody@${DOMAIN}`, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test("403 MOBILE_ROLE_NOT_ALLOWED when the password only matches a non-sales account", async () => {
    const res = await mobileLogin({ email: `admin@${DOMAIN}`, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MOBILE_ROLE_NOT_ALLOWED");
  });

  test("400 without device_id", async () => {
    const res = await request(app).post("/api/auth/mobile/login").send({ email: `solo@${DOMAIN}`, password: PASSWORD });
    expect(res.status).toBe(400);
  });
});

describe("mobile refresh tokens", () => {
  test("rotation keeps the device binding", async () => {
    const login = await mobileLogin({ email: `solo@${DOMAIN}`, password: PASSWORD });
    const res = await request(app).post("/api/auth/refresh").send({ refresh_token: login.body.accounts[0].refresh_token });
    expect(res.status).toBe(200);
    expect(await tokenRow(res.body.refresh_token)).toMatchObject({ client: "mobile", device_id: DEVICE, revoked: false });
  });

  test("reusing a rotated token revokes the whole device family", async () => {
    const login = await mobileLogin({ email: `solo@${DOMAIN}`, password: PASSWORD });
    const first = login.body.accounts[0].refresh_token;
    const rotated = await request(app).post("/api/auth/refresh").send({ refresh_token: first });
    expect(rotated.status).toBe(200);

    const replay = await request(app).post("/api/auth/refresh").send({ refresh_token: first });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("REFRESH_TOKEN_REUSED");

    const afterReplay = await request(app).post("/api/auth/refresh").send({ refresh_token: rotated.body.refresh_token });
    expect(afterReplay.status).toBe(401);
  });

  test("a password change revokes mobile tokens, except the device that made the change", async () => {
    const login = await mobileLogin({ email: `solo@${DOMAIN}`, password: PASSWORD });
    const thisDevice = login.body.accounts[0].refresh_token;
    const other = await request(app).post("/api/auth/mobile/login")
      .send({ email: `solo@${DOMAIN}`, password: PASSWORD, device_id: "device-test-0002" });
    const otherDevice = other.body.accounts[0].refresh_token;

    const res = await request(app).post("/api/auth/change-password")
      .set("Authorization", `Bearer ${signAccessToken(users.solo)}`)
      .send({ current_password: PASSWORD, new_password: PASSWORD, device_id: DEVICE });
    expect(res.status).toBe(200);

    expect((await tokenRow(thisDevice)).revoked).toBe(false);
    expect((await tokenRow(otherDevice)).revoked).toBe(true);
  });
});

describe("suspended tenant", () => {
  test("a mobile refresh is refused once the tenant is suspended", async () => {
    const login = await mobileLogin({ email: `split@${DOMAIN}`, password: OTHER_PASSWORD });
    const refreshToken = login.body.accounts[0].refresh_token;
    await db.query(`UPDATE tenants SET is_active = FALSE WHERE id = $1`, [tenantB]);
    try {
      const res = await request(app).post("/api/auth/refresh").send({ refresh_token: refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("TENANT_INACTIVE");
    } finally {
      await db.query(`UPDATE tenants SET is_active = TRUE WHERE id = $1`, [tenantB]);
    }
  });
});

describe("GET / DELETE /api/auth/devices", () => {
  const auth = () => ({ Authorization: `Bearer ${signAccessToken(users.multiA)}` });

  test("lists each signed-in phone once and signs one out", async () => {
    await mobileLogin({ email: `multi@${DOMAIN}`, password: PASSWORD });
    await mobileLogin({ email: `multi@${DOMAIN}`, password: PASSWORD });
    const other = await request(app).post("/api/auth/mobile/login")
      .send({ email: `multi@${DOMAIN}`, password: PASSWORD, device_id: "device-test-0003", device_name: "Other Phone" });
    const otherTokenA = other.body.accounts.find((a) => a.tenant_slug === "zz-mobile-a").refresh_token;

    const list = await request(app).get("/api/auth/devices").set(auth());
    expect(list.status).toBe(200);
    expect(list.body.map((d) => d.device_id).sort()).toEqual([DEVICE, "device-test-0003"]);
    expect(list.body.find((d) => d.device_id === "device-test-0003").device_name).toBe("Other Phone");

    const del = await request(app).delete("/api/auth/devices/device-test-0003").set(auth());
    expect(del.status).toBe(204);
    expect((await tokenRow(otherTokenA)).revoked).toBe(true);

    const after = await request(app).get("/api/auth/devices").set(auth());
    expect(after.body.map((d) => d.device_id)).toEqual([DEVICE]);
  });

  test("signing out a phone only affects this account, not the same email in another tenant", async () => {
    const login = await request(app).post("/api/auth/mobile/login")
      .send({ email: `multi@${DOMAIN}`, password: PASSWORD, device_id: "device-test-0004" });
    const tokenB = login.body.accounts.find((a) => a.tenant_slug === "zz-mobile-b").refresh_token;
    await request(app).delete("/api/auth/devices/device-test-0004").set(auth());
    expect((await tokenRow(tokenB)).revoked).toBe(false);
  });

  test("404 for a device that isn't signed in", async () => {
    const res = await request(app).delete("/api/auth/devices/not-a-device").set(auth());
    expect(res.status).toBe(404);
  });
});

describe("GET /api/public/app-config", () => {
  test("returns the minimum supported app version without auth", async () => {
    const res = await request(app).get("/api/public/app-config");
    expect(res.status).toBe(200);
    expect(res.body.min_supported_version).toEqual({ android: expect.any(String), ios: expect.any(String) });
  });
});

describe("mobile access token lifetime", () => {
  const ttlSeconds = (token) => {
    const { exp, iat } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return exp - iat;
  };

  test("mobile access tokens live 15 minutes, also after a refresh", async () => {
    const login = await mobileLogin({ email: `solo@${DOMAIN}`, password: PASSWORD });
    expect(ttlSeconds(login.body.accounts[0].access_token)).toBe(15 * 60);
    const refreshed = await request(app).post("/api/auth/refresh").send({ refresh_token: login.body.accounts[0].refresh_token });
    expect(ttlSeconds(refreshed.body.access_token)).toBe(15 * 60);
  });

  test("web access tokens keep the configured lifetime", () => {
    expect(ttlSeconds(signAccessToken(users.solo))).toBeGreaterThan(15 * 60);
  });
});
