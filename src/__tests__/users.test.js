"use strict";

const request = require("supertest");
const app = require("../app");
const db  = require("../config/database");
const bcrypt = require("bcryptjs");
const { signAccessToken } = require("../middleware/auth");

const TEST_TENANT_SLUG = "zz-users-test";
const ADMIN_EMAIL   = "admin@users-test.crmtree.local";
const MANAGER_EMAIL = "manager@users-test.crmtree.local";
const REGULAR_EMAIL = "regular@users-test.crmtree.local";
const PASSWORD = "TestPass123!";

let tenantId, adminToken, managerToken, regularToken, adminId, managerId, regularId;

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Users Test Tenant', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE RETURNING id`,
    [TEST_TENANT_SLUG],
  );
  tenantId = tenant.id;

  const hash = await bcrypt.hash(PASSWORD, 4);
  // Clean up leftovers from previous runs in FK-safe order
  await db.query(`DELETE FROM audit_logs       WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM refresh_tokens   WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM user_group_roles WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@users-test.crmtree.local'`);

  const { rows: [admin] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, password_hash, tenant_id)
     VALUES ($1,'Admin','UsersTest',TRUE,TRUE,$2,$3) RETURNING *`,
    [ADMIN_EMAIL, hash, tenantId],
  );
  adminId    = admin.id;
  adminToken = signAccessToken(admin);

  const { rows: [manager] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, password_hash, tenant_id)
     VALUES ($1,'Manager','UsersTest',FALSE,TRUE,'sales_manager',$2,$3) RETURNING *`,
    [MANAGER_EMAIL, hash, tenantId],
  );
  managerId    = manager.id;
  managerToken = signAccessToken(manager);

  const { rows: [regular] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_admin, is_active, password_hash, tenant_id)
     VALUES ($1,'Regular','UsersTest',FALSE,TRUE,$2,$3) RETURNING *`,
    [REGULAR_EMAIL, hash, tenantId],
  );
  regularId    = regular.id;
  regularToken = signAccessToken(regular);
});

afterAll(async () => {
  // Delete in FK-safe order: audit_logs and refresh_tokens before users
  await db.query(`DELETE FROM audit_logs      WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM refresh_tokens  WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM user_group_roles WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE '%@users-test.crmtree.local'`);
  // Tenant left intentionally — reused on next run via ON CONFLICT
});

// ─── GET /api/admin/users ─────────────────────────────────
describe("GET /api/admin/users", () => {
  test("admin sees users for their tenant", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    const emails = res.body.data.map((u) => u.email);
    expect(emails).toContain(ADMIN_EMAIL);
    expect(emails).toContain(MANAGER_EMAIL);
    expect(emails).toContain(REGULAR_EMAIL);
  });

  test("sales_manager can list users", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
  });

  test("regular user gets 403", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${regularToken}`);
    expect(res.status).toBe(403);
  });

  test("401 without token", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  test("search filter narrows results", async () => {
    const res = await request(app)
      .get("/api/admin/users?search=Manager")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((u) => u.email.includes("manager") || u.first_name === "Manager")).toBe(true);
  });
});

// ─── POST /api/admin/users ────────────────────────────────
describe("POST /api/admin/users", () => {
  const NEW_EMAIL = "newbie@users-test.crmtree.local";
  let createdId;

  afterAll(async () => {
    if (createdId) await db.query("DELETE FROM users WHERE id = $1", [createdId]);
  });

  test("admin creates a user", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: NEW_EMAIL, first_name: "New", last_name: "Hire" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(NEW_EMAIL);
    createdId = res.body.id;
  });

  test("409 for duplicate email", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: NEW_EMAIL, first_name: "Dup", last_name: "User" });
    expect(res.status).toBe(409);
  });

  test("400 for invalid email", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "not-an-email", first_name: "X", last_name: "X" });
    expect(res.status).toBe(400);
  });

  test("sales_manager cannot create users (403)", async () => {
    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ email: "x@users-test.crmtree.local", first_name: "X", last_name: "X" });
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/admin/users/:id ──────────────────────────
describe("PATCH /api/admin/users/:id", () => {
  test("admin updates user first_name", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ first_name: "Updated" });
    expect(res.status).toBe(200);
    expect(res.body.first_name).toBe("Updated");
    await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ first_name: "Regular" });
  });

  test("security fix: sales_manager cannot modify admin account", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${adminId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ first_name: "Hacked" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  test("sales_manager can modify non-admin user", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ first_name: "ByManager" });
    expect(res.status).toBe(200);
    await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ first_name: "Regular" });
  });

  test("sales_manager cannot self-promote to sales_manager role", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ crm_role: "sales_manager" });
    expect(res.status).toBe(403);
  });

  test("400 when no fields provided", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test("404 for non-existent user", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ first_name: "Ghost" });
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/admin/users/:id ─────────────────────────────
describe("GET /api/admin/users/:id", () => {
  test("admin can fetch a specific user", async () => {
    const res = await request(app)
      .get(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(regularId);
  });

  test("404 for non-existent id", async () => {
    const res = await request(app)
      .get(`/api/admin/users/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/admin/users/:id/set-password ───────────────
describe("POST /api/admin/users/:id/set-password", () => {
  test("admin sets password for user", async () => {
    const res = await request(app)
      .post(`/api/admin/users/${regularId}/set-password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ password: "BrandNew99!" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("user can then login with new password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: REGULAR_EMAIL, password: "BrandNew99!" });
    expect(res.status).toBe(200);
  });

  test("non-admin gets 403", async () => {
    const res = await request(app)
      .post(`/api/admin/users/${regularId}/set-password`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ password: "BrandNew99!" });
    expect(res.status).toBe(403);
  });

  test("400 for password shorter than 8 characters", async () => {
    const res = await request(app)
      .post(`/api/admin/users/${regularId}/set-password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ password: "short" });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/admin/users/:id ─────────────────────────
describe("DELETE /api/admin/users/:id", () => {
  test("admin deletes a user", async () => {
    const { rows: [tmp] } = await db.query(
      `INSERT INTO users (email, first_name, last_name, tenant_id, is_active)
       VALUES ('todelete@users-test.crmtree.local','ToDelete','User',$1,TRUE) RETURNING *`,
      [tenantId],
    );
    const res = await request(app)
      .delete(`/api/admin/users/${tmp.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(tmp.id);
  });

  test("400 when admin tries to delete own account", async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${adminId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  test("non-admin gets 403", async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${regularId}`)
      .set("Authorization", `Bearer ${regularToken}`);
    expect(res.status).toBe(403);
  });

  test("404 for non-existent user", async () => {
    const res = await request(app)
      .delete(`/api/admin/users/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
