"use strict";

// GET /api/crm/dashboard/my-calls — the sales dashboard's "My phone calls" panel and
// "Calls today" medal — and the min_duration_sec filter of the Prospects dashboard's
// calls-per-salesperson chart.

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");

const DOMAIN = "my-calls-test.crmtree.local";
const DAY_MS = 86400000;

let tenantId;
let otherTenantId;
const users = {};
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

async function createTenant(name, slug) {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [name, slug],
  );
  return tenant.id;
}

async function createUser(name, tenant, { crmRole = "salesperson", isAdmin = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role, tenant_id)
     VALUES ($1, $2, 'Test', TRUE, $3, $4, $5) RETURNING *`,
    [`${name}@${DOMAIN}`, name, isAdmin, crmRole, tenant],
  );
  return user;
}

async function logCall(user, tenant, { direction = "outbound", status = "answered", durationSec, startedAt = new Date() }) {
  await db.query(
    `INSERT INTO pbx_call_log (direction, status, duration_sec, started_at, user_id, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [direction, status, durationSec, startedAt, user.id, tenant],
  );
}

const countOf = (rows, direction, status) =>
  rows.filter(r => r.direction === direction && r.status === status)
    .reduce((sum, r) => sum + Number(r.count), 0);

async function cleanUp() {
  await db.query(`DELETE FROM pbx_call_log WHERE tenant_id = ANY($1::uuid[])`, [[tenantId, otherTenantId]]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  tenantId = await createTenant("My Calls Test", "zz-my-calls");
  otherTenantId = await createTenant("My Calls Other", "zz-my-calls-other");
  await cleanUp();

  users.rep = await createUser("rep", tenantId);
  users.colleague = await createUser("colleague", tenantId);
  users.admin = await createUser("admin", tenantId, { crmRole: "sales_manager", isAdmin: true });

  // Today: two calls over 35 s, one exactly 35 s, one short, one missed inbound.
  await logCall(users.rep, tenantId, { durationSec: 36 });
  await logCall(users.rep, tenantId, { durationSec: 120 });
  await logCall(users.rep, tenantId, { durationSec: 35 });
  await logCall(users.rep, tenantId, { durationSec: 5 });
  await logCall(users.rep, tenantId, { direction: "inbound", status: "missed", durationSec: 0 });
  // Long ago — outside "today" and outside the current week.
  await logCall(users.rep, tenantId, { durationSec: 300, startedAt: new Date(Date.now() - 40 * DAY_MS) });
  // Someone else's call must never count.
  await logCall(users.colleague, tenantId, { durationSec: 200 });
}, 60000);

afterAll(cleanUp);

describe("GET /api/crm/dashboard/my-calls", () => {
  it("counts only the user's own calls of today, longer than 35 s for the medal", async () => {
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "today", min_duration_sec: 36 })
      .set(auth(users.rep));
    expect(res.status).toBe(200);
    expect(countOf(res.body, "outbound", "answered")).toBe(2);
    expect(countOf(res.body, "inbound", "missed")).toBe(0);
  });

  it("without the duration filter returns every call of today grouped by direction and status", async () => {
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "today" })
      .set(auth(users.rep));
    expect(res.status).toBe(200);
    expect(countOf(res.body, "outbound", "answered")).toBe(4);
    expect(countOf(res.body, "inbound", "missed")).toBe(1);
  });

  it("the >= 35 s checkbox keeps the 35 s call and drops the shorter ones", async () => {
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "cw", min_duration_sec: 35 })
      .set(auth(users.rep));
    expect(res.status).toBe(200);
    expect(countOf(res.body, "outbound", "answered")).toBe(3);
  });

  it("a custom range covering the old call includes it", async () => {
    const from = new Date(Date.now() - 45 * DAY_MS).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "custom", from_date: from, to_date: to, min_duration_sec: 35 })
      .set(auth(users.rep));
    expect(res.status).toBe(200);
    expect(countOf(res.body, "outbound", "answered")).toBe(4);
  });

  it("rejects a custom range whose start is after its end", async () => {
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "custom", from_date: "2026-10-10", to_date: "2026-10-01" })
      .set(auth(users.rep));
    expect(res.status).toBe(400);
  });

  it("does not count calls logged under another tenant", async () => {
    await logCall(users.rep, otherTenantId, { durationSec: 90 });
    const res = await request(app)
      .get("/api/crm/dashboard/my-calls")
      .query({ period: "today", min_duration_sec: 36 })
      .set(auth(users.rep));
    expect(countOf(res.body, "outbound", "answered")).toBe(2);
  });
});

describe("GET /api/crm/prospects-dashboard/calls-by-salesperson — min_duration_sec", () => {
  const repCount = (rows) => rows.filter(r => r.user_id === users.rep.id)
    .reduce((sum, r) => sum + Number(r.count), 0);

  it("drops calls shorter than the threshold", async () => {
    const all = await request(app)
      .get("/api/crm/prospects-dashboard/calls-by-salesperson")
      .query({ period: "this_week" })
      .set(auth(users.admin));
    const filtered = await request(app)
      .get("/api/crm/prospects-dashboard/calls-by-salesperson")
      .query({ period: "this_week", min_duration_sec: 35 })
      .set(auth(users.admin));
    expect(all.status).toBe(200);
    expect(filtered.status).toBe(200);
    expect(repCount(all.body)).toBe(5);
    expect(repCount(filtered.body)).toBe(3);
  });
});
