"use strict";

// Checks real API responses against src/openapi/mobile-v1.yaml (ADR 001 §5).
// The mobile app's Dart client is generated from that file, so a response
// that stops matching it is a bug the app would only find in production.

const request = require("supertest");
const bcrypt = require("bcryptjs");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const app = require("../app");
const db = require("../config/database");
const { spec } = require("../routes/openapi");
const { signAccessToken } = require("../middleware/auth");

const DOMAIN = "openapi-test.crmtree.local";
const PASSWORD = "OpenApiPass123!";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, "spec");

const deref = (node) => (node && node.$ref ? node.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec) : node);

// Fails with the validation errors when `res` doesn't match the documented
// response for this operation and status.
function expectDocumented(res, method, path) {
  const operation = spec.paths[path]?.[method];
  if (!operation) throw new Error(`${method.toUpperCase()} ${path} is not in the spec`);
  const response = deref(operation.responses[String(res.status)]);
  if (!response) throw new Error(`${method.toUpperCase()} ${path} → ${res.status} is not documented (body: ${JSON.stringify(res.body).slice(0, 200)})`);
  const schema = response.content?.["application/json"]?.schema;
  if (!schema) return;
  // Inline schemas reference components relative to the spec document.
  const validate = ajv.compile(JSON.parse(JSON.stringify(schema).split('"$ref":"#/').join('"$ref":"spec#/')));
  const ok = validate(res.body);
  if (!ok) throw new Error(`${method.toUpperCase()} ${path} → ${res.status} does not match the spec:\n${ajv.errorsText(validate.errors, { separator: "\n" })}`);
}

let tenantId;
let user;
let auth;
let leadId;
let leadActivityId;
let partnerId;

beforeAll(async () => {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('OpenAPI Test', 'zz-openapi', TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
  );
  tenantId = t.id;
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
  const { rows: [u] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role, password_hash, tenant_id)
     VALUES ($1, 'Open', 'Api', TRUE, TRUE, 'sales_manager', $2, $3) RETURNING *`,
    [`manager@${DOMAIN}`, await bcrypt.hash(PASSWORD, 4), tenantId],
  );
  user = u;
  auth = { Authorization: `Bearer ${signAccessToken(user)}` };
});

afterAll(async () => {
  await db.query(`DELETE FROM crm_lead_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_leads WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partner_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partners WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM refresh_tokens WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
});

describe("the spec itself", () => {
  test("is served at /api/openapi.json", async () => {
    const res = await request(app).get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\.0\./);
  });

  test("every operation has a unique operationId and every $ref resolves", () => {
    const ids = Object.values(spec.paths).flatMap((p) => Object.entries(p).filter(([m]) => m !== "parameters").map(([, op]) => op.operationId));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = JSON.stringify(spec).match(/"\$ref":"#\/[^"]+"/g).map((r) => JSON.parse(`{${r}}`).$ref);
    for (const ref of refs) expect(deref({ $ref: ref })).toBeDefined();
  });
});

describe("auth and app config", () => {
  let account;

  test("GET /public/app-config", async () => {
    expectDocumented(await request(app).get("/api/public/app-config"), "get", "/public/app-config");
  });

  test("POST /auth/mobile/login — success, wrong password, missing device_id", async () => {
    const ok = await request(app).post("/api/auth/mobile/login")
      .send({ email: user.email, password: PASSWORD, device_id: "openapi-device-01", device_name: "Spec Phone" });
    expect(ok.status).toBe(200);
    expectDocumented(ok, "post", "/auth/mobile/login");
    account = ok.body.accounts[0];

    const wrong = await request(app).post("/api/auth/mobile/login")
      .send({ email: user.email, password: "wrong", device_id: "openapi-device-01" });
    expect(wrong.status).toBe(401);
    expectDocumented(wrong, "post", "/auth/mobile/login");

    const bad = await request(app).post("/api/auth/mobile/login").send({ email: user.email, password: PASSWORD });
    expect(bad.status).toBe(400);
    expectDocumented(bad, "post", "/auth/mobile/login");
  });

  test("GET /auth/me", async () => {
    const res = await request(app).get("/api/auth/me").set(auth);
    expect(res.status).toBe(200);
    expectDocumented(res, "get", "/auth/me");
  });

  test("GET /auth/devices, then POST /auth/refresh and its 401", async () => {
    const devices = await request(app).get("/api/auth/devices").set(auth);
    expect(devices.body).toHaveLength(1);
    expectDocumented(devices, "get", "/auth/devices");

    const refreshed = await request(app).post("/api/auth/refresh").send({ refresh_token: account.refresh_token });
    expect(refreshed.status).toBe(200);
    expectDocumented(refreshed, "post", "/auth/refresh");

    const replay = await request(app).post("/api/auth/refresh").send({ refresh_token: account.refresh_token });
    expect(replay.status).toBe(401);
    expectDocumented(replay, "post", "/auth/refresh");
  });
});

describe("leads", () => {
  test("create a lead and an activity (setup through the API)", async () => {
    const lead = await request(app).post("/api/crm/leads").set(auth)
      .send({ company: "Spec Sp. z o.o.", contact_name: "Jan Spec", email: "jan@spec.example", phone: "+48 600 100 200", value_pln: 25200, hot: true, tags: ["spec"] });
    expect(lead.status).toBe(201);
    expectDocumented(lead, "post", "/crm/leads");
    leadId = lead.body.id;

    const activity = await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth)
      .send({ type: "meeting", title: "Prezentacja", activity_at: new Date(Date.now() + 86400000).toISOString(), duration_min: 45, reminder_type: "1h_before" });
    expect(activity.status).toBe(201);
    expectDocumented(activity, "post", "/crm/leads/{id}/activities");
    leadActivityId = activity.body.id;
  });

  test("GET /crm/leads", async () => {
    const res = await request(app).get("/api/crm/leads?limit=10").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expectDocumented(res, "get", "/crm/leads");
    const created = res.body.data.find((lead) => lead.id === leadId);
    expect(created.next_activity_type).toBe("meeting");
    expect(created.next_activity_title).toBe("Prezentacja");
    expect(new Date(created.next_activity_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("GET /crm/leads/{id}/logo-img — a lead without a logo", async () => {
    const res = await request(app).get(`/api/crm/leads/${leadId}/logo-img`).set(auth);
    expect(res.status).toBe(404);
    expectDocumented(res, "get", "/crm/leads/{id}/logo-img");
  });

  test("GET /crm/leads/{id} and its 404", async () => {
    const res = await request(app).get(`/api/crm/leads/${leadId}`).set(auth);
    expect(res.status).toBe(200);
    expectDocumented(res, "get", "/crm/leads/{id}");
    expectDocumented(await request(app).get("/api/crm/leads/999999999").set(auth), "get", "/crm/leads/{id}");
  });

  test("PATCH /crm/leads/{id} — stage change and a skipped stage", async () => {
    const res = await request(app).patch(`/api/crm/leads/${leadId}`).set(auth).send({ stage: "qualification", probability: 30 });
    expect(res.status).toBe(200);
    expectDocumented(res, "patch", "/crm/leads/{id}");

    const skipped = await request(app).patch(`/api/crm/leads/${leadId}`).set(auth).send({ stage: "negotiation" });
    expect(skipped.status).toBe(422);
    expectDocumented(skipped, "patch", "/crm/leads/{id}");
  });

  test("GET /crm/leads/{id}/activities, PATCH and DELETE one", async () => {
    const list = await request(app).get(`/api/crm/leads/${leadId}/activities`).set(auth);
    expect(list.body.length).toBeGreaterThan(0);
    expectDocumented(list, "get", "/crm/leads/{id}/activities");

    const closed = await request(app).patch(`/api/crm/leads/${leadId}/activities/${leadActivityId}`).set(auth)
      .send({ status: "closed", close_comment: "Odbyła się" });
    expect(closed.status).toBe(200);
    expectDocumented(closed, "patch", "/crm/leads/{id}/activities/{actId}");

    const deleted = await request(app).delete(`/api/crm/leads/${leadId}/activities/${leadActivityId}`).set(auth);
    expectDocumented(deleted, "delete", "/crm/leads/{id}/activities/{actId}");
  });

  test("GET /admin/settings", async () => {
    const res = await request(app).get("/api/admin/settings").set(auth);
    expect(res.status).toBe(200);
    expectDocumented(res, "get", "/admin/settings");
  });

  test("GET /crm/leads/users", async () => {
    expectDocumented(await request(app).get("/api/crm/leads/users").set(auth), "get", "/crm/leads/users");
  });
});

describe("partners", () => {
  test("create a partner and an activity (setup through the API)", async () => {
    const partner = await request(app).post("/api/crm/partners").set(auth)
      .send({ company: "Spec Partner S.A.", contact_name: "Anna Spec", manager_id: user.id, contract_value: 12000, status: "active" });
    expect([200, 201]).toContain(partner.status);

    const list = await request(app).get("/api/crm/partners?search=Spec%20Partner").set(auth);
    expect(list.status).toBe(200);
    expectDocumented(list, "get", "/crm/partners");
    partnerId = list.body.data[0].crm_uuid;

    const activity = await request(app).post(`/api/crm/partners/${partnerId}/activities`).set(auth)
      .send({ type: "call", title: "Telefon kontrolny", activity_at: new Date(Date.now() + 2 * 86400000).toISOString() });
    expect(activity.status).toBe(201);
    expectDocumented(activity, "post", "/crm/partners/{partnerId}/activities");
  });

  test("GET /crm/partners/{partnerId} and its activities", async () => {
    const res = await request(app).get(`/api/crm/partners/${partnerId}`).set(auth);
    expect(res.status).toBe(200);
    expectDocumented(res, "get", "/crm/partners/{partnerId}");
    expectDocumented(await request(app).get(`/api/crm/partners/${partnerId}/activities`).set(auth), "get", "/crm/partners/{partnerId}/activities");
  });
});

describe("agenda", () => {
  test("tasks and calendar include both lead and partner activities in the documented shape", async () => {
    await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth)
      .send({ type: "task", title: "Wysłać ofertę", activity_at: new Date(Date.now() + 3600000).toISOString() });

    const tasks = await request(app).get("/api/crm/leads/tasks").set(auth);
    expect(tasks.body.length).toBeGreaterThan(0);
    expectDocumented(tasks, "get", "/crm/leads/tasks");

    const partnerTasks = await request(app).get("/api/crm/partners/tasks").set(auth);
    expect(partnerTasks.body.length).toBeGreaterThan(0);
    expectDocumented(partnerTasks, "get", "/crm/partners/tasks");

    const today = new Date();
    const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const calendar = await request(app).get(`/api/crm/leads/calendar?date_from=${day(-1)}&date_to=${day(7)}`).set(auth);
    expect(calendar.body.map((e) => e.source_type).sort()).toEqual(expect.arrayContaining(["lead", "partner"]));
    expectDocumented(calendar, "get", "/crm/leads/calendar");
  });

  test("GET /crm/mobile/today with today's lead and partner items, and its 400", async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const res = await request(app).get("/api/crm/mobile/today").set(auth)
      .query({
        day_start: new Date(startOfDay.getTime() - 86400000).toISOString(),
        day_end: new Date(startOfDay.getTime() + 8 * 86400000).toISOString(),
        month_start: new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1).toISOString(),
        month_end: new Date(startOfDay.getFullYear(), startOfDay.getMonth() + 1, 1).toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.agenda.map((item) => item.source_type).sort()).toEqual(expect.arrayContaining(["lead", "partner"]));
    expectDocumented(res, "get", "/crm/mobile/today");

    const missing = await request(app).get("/api/crm/mobile/today").set(auth);
    expect(missing.status).toBe(400);
    expectDocumented(missing, "get", "/crm/mobile/today");
  });
});
