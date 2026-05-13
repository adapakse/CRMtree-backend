"use strict";

const request = require("supertest");
const app = require("../app");
const db  = require("../config/database");
const bcrypt = require("bcryptjs");
const { signAccessToken } = require("../middleware/auth");

const TEST_TENANT_SLUG = "zz-auth-test";
const ADMIN_EMAIL   = "admin@auth-test.crmtree.local";
const USER_EMAIL    = "user@auth-test.crmtree.local";
const SSO_EMAIL     = "sso@auth-test.crmtree.local";
const PASSWORD      = "TestPass123!";

let tenantId, adminId, adminToken, userToken;

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Auth Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [TEST_TENANT_SLUG],
  );
  tenantId = tenant.id;

  const hash = await bcrypt.hash(PASSWORD, 4);

  await db.query(`DELETE FROM users WHERE email LIKE '%@auth-test.crmtree.local'`);

  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, password_hash, tenant_id)
     VALUES ($1,'Admin','AuthTest',TRUE,TRUE,$2,$3) RETURNING *`,
    [ADMIN_EMAIL, hash, tenantId],
  );
  adminId   = admin.id;
  adminToken = signAccessToken(admin);

  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, password_hash, tenant_id)
     VALUES ($1,'User','AuthTest',FALSE,TRUE,$2,$3) RETURNING *`,
    [USER_EMAIL, hash, tenantId],
  );
  userToken = signAccessToken(user);

  // SSO-only account — no password_hash
  await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, tenant_id)
     VALUES ($1,'SSO','AuthTest',TRUE,$2)`,
    [SSO_EMAIL, tenantId],
  );
});

afterAll(async () => {
  // Delete audit_logs and refresh_tokens first — FK RESTRICT prevents deleting users otherwise
  await db.query(`DELETE FROM audit_logs     WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM refresh_tokens WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@auth-test.crmtree.local'`);
  // Tenant left intentionally — reused on next run via ON CONFLICT
});

// ─── Login ────────────────────────────────────────────────
describe("POST /api/auth/login", () => {
  test("200 + tokens for valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("access_token");
    expect(res.body).toHaveProperty("refresh_token");
    expect(typeof res.body.must_change_password).toBe("boolean");
  });

  test("401 for wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: "WrongPassword!" });
    expect(res.status).toBe(401);
  });

  test("401 for SSO-only account", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SSO_EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/SSO/i);
  });

  test("401 for unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@doesnotexist.local", password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test("401 for inactive account", async () => {
    await db.query(`UPDATE users SET is_active = FALSE WHERE email = $1`, [USER_EMAIL]);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: USER_EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    await db.query(`UPDATE users SET is_active = TRUE WHERE email = $1`, [USER_EMAIL]);
  });

  test("400 when email or password missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL });
    expect(res.status).toBe(400);
  });
});

// ─── Token refresh ────────────────────────────────────────
describe("POST /api/auth/refresh", () => {
  let refreshToken;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    refreshToken = res.body.refresh_token;
  });

  test("200 + rotated tokens for valid refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("access_token");
    expect(res.body).toHaveProperty("refresh_token");
    refreshToken = res.body.refresh_token;
  });

  test("401 after the old token was rotated (single-use)", async () => {
    // Use the original token again — should be revoked
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    const oldToken = loginRes.body.refresh_token;

    // Rotate it once
    await request(app).post("/api/auth/refresh").send({ refresh_token: oldToken });

    // Try the same token again
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: oldToken });
    expect(res.status).toBe(401);
  });

  test("401 for invalid refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: "completely_invalid_string" });
    expect(res.status).toBe(401);
  });
});

// ─── GET /me ──────────────────────────────────────────────
describe("GET /api/auth/me", () => {
  test("200 + profile for authenticated admin", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(ADMIN_EMAIL);
    expect(res.body.is_admin).toBe(true);
    expect(res.body).not.toHaveProperty("password_hash");
  });

  test("401 without token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});

// ─── Change password ──────────────────────────────────────
describe("POST /api/auth/change-password", () => {
  test("200 on forced reset (must_change_password — current not required)", async () => {
    await db.query(
      `UPDATE users SET must_change_password = TRUE WHERE id = $1`, [adminId],
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    const tmpToken = loginRes.body.access_token;

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${tmpToken}`)
      .send({ new_password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("400 for new_password shorter than 8 characters", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ new_password: "short" });
    expect(res.status).toBe(400);
  });

  test("400 when current_password missing (password already set, not forced)", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ new_password: "NewPassword456!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aktualne hasło/i);
  });

  test("401 for wrong current_password", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ current_password: "WrongCurrent!", new_password: "NewPassword456!" });
    expect(res.status).toBe(401);
  });

  test("200 with correct current_password", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ current_password: PASSWORD, new_password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

// ─── GET /saml-diag — security fix ───────────────────────
describe("GET /api/auth/saml-diag", () => {
  test("401 without authentication", async () => {
    const res = await request(app).get("/api/auth/saml-diag");
    expect(res.status).toBe(401);
  });

  test("403 for authenticated non-admin", async () => {
    const res = await request(app)
      .get("/api/auth/saml-diag")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test("200 for admin — returns config info", async () => {
    const res = await request(app)
      .get("/api/auth/saml-diag")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("node_env");
    expect(res.body).toHaveProperty("strategy_loaded");
  });
});
