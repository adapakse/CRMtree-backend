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

  test("PUT and DELETE /auth/devices/{deviceId}/push-token", async () => {
    const path = "/api/auth/devices/spec-device-0001/push-token";
    const registered = await request(app).put(path).set(auth).send({ token: "spec-fcm-token-000000000000", platform: "android" });
    expect(registered.status).toBe(204);
    expectDocumented(registered, "put", "/auth/devices/{deviceId}/push-token");
    expectDocumented(await request(app).put(path).set(auth).send({ platform: "android" }), "put", "/auth/devices/{deviceId}/push-token");
    const removed = await request(app).delete(path).set(auth);
    expect(removed.status).toBe(204);
    expectDocumented(removed, "delete", "/auth/devices/{deviceId}/push-token");
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

    const leadContacts = await request(app).post(`/api/crm/leads/${leadId}/contacts`).set(auth)
      .send({ contacts: [{ contact_name: "Piotr Drugi", phone: "600300400" }] });
    expectDocumented(leadContacts, "post", "/crm/leads/{id}/contacts");
    expect(leadContacts.body).toHaveLength(1);

    const task = await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth)
      .send({ type: "task", title: "Wysłać ofertę", assigned_to: user.id, priority: "asap" });
    expectDocumented(task, "post", "/crm/leads/{id}/activities");
    expect(task.body.priority).toBe("asap");
    expect(task.body.assigned_to).toBe(user.id);

    const note = await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth)
      .send({ type: "note", title: "Notatka", priority: "asap" });
    expect(note.body.priority).toBeNull();

    const edited = await request(app).patch(`/api/crm/leads/${leadId}/activities/${task.body.id}`).set(auth)
      .send({ title: "Wysłać ofertę dziś", priority: "low", reminder_type: null, assigned_to: null });
    expectDocumented(edited, "patch", "/crm/leads/{id}/activities/{actId}");
    expect(edited.body.priority).toBe("low");
    expect(edited.body.title).toBe("Wysłać ofertę dziś");
    expect(edited.body.assigned_to).toBeNull();

    const wrong = await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth)
      .send({ type: "task", title: "Zadanie", priority: "urgent" });
    expect(wrong.status).toBe(400);
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

  test("GET /crm/leads/sources", async () => {
    const res = await request(app).get("/api/crm/leads/sources").set(auth);
    expect(res.status).toBe(200);
    expectDocumented(res, "get", "/crm/leads/sources");
  });

  test("GET /crm/leads/users", async () => {
    expectDocumented(await request(app).get("/api/crm/leads/users").set(auth), "get", "/crm/leads/users");
  });
});

const listed0ActiveSince = (res) => !Number.isNaN(new Date(res.body.data[0].active_since).getTime());

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

    const task = await request(app).post(`/api/crm/partners/${partnerId}/activities`).set(auth)
      .send({ type: "task", title: "Odnowić umowę", priority: "important" });
    expect(task.body.priority).toBe("important");

    const closed = await request(app).patch(`/api/crm/partners/${partnerId}/activities/${task.body.id}`).set(auth)
      .send({ status: "closed", close_comment: "Zrobione" });
    expect(closed.status).toBe(200);
    expectDocumented(closed, "patch", "/crm/partners/{partnerId}/activities/{actId}");
    expect(closed.body.status).toBe("closed");

    const reprioritised = await request(app).patch(`/api/crm/partners/${partnerId}/activities/${task.body.id}`).set(auth)
      .send({ priority: "low" });
    expect(reprioritised.body.priority).toBe("low");
    expect(listed0ActiveSince(await request(app).get("/api/crm/partners?search=Spec%20Partner").set(auth))).toBe(true);

    const report = await request(app).get("/api/crm/sales-data/report?period_from=2026-01&period_to=2026-12").set(auth);
    expect(report.status).toBe(200);
    expectDocumented(report, "get", "/crm/sales-data/report");

    const listed = await request(app).get("/api/crm/partners?search=Spec%20Partner").set(auth);
    expectDocumented(listed, "get", "/crm/partners");
    expect(listed.body.data[0].next_activity_title).toBe("Telefon kontrolny");

    const contacts = await request(app).post(`/api/crm/partners/${partnerId}/contacts`).set(auth)
      .send({ contacts: [{ contact_name: "Ewa Druga", contact_title: "CFO", email: "ewa@spec.example", phone: "600200300" }, { contact_title: "pusty" }] });
    expect(contacts.status).toBe(200);
    expectDocumented(contacts, "post", "/crm/partners/{partnerId}/contacts");
    expect(contacts.body.map((c) => c.contact_name)).toEqual(["Ewa Druga"]);
    const card = await request(app).get(`/api/crm/partners/${partnerId}`).set(auth);
    expect(card.body.extra_contacts.map((c) => c.email)).toEqual(["ewa@spec.example"]);
    expect((await request(app).get(`/api/crm/partners/${partnerId}/contacts`).set(auth)).body).toHaveLength(1);

    const renamed = await request(app).patch(`/api/crm/partners/${partnerId}`).set(auth)
      .send({ phone: "+48 600 100 300", contact_title: null, address: "ul. Testowa 1" });
    expect(renamed.status).toBe(200);
    expectDocumented(renamed, "patch", "/crm/partners/{partnerId}");
    expect(renamed.body.phone).toBe("+48 600 100 300");

    const active = await request(app).get("/api/crm/partners?search=Spec%20Partner&status=active").set(auth);
    expect(active.body.data.map((p) => p.crm_uuid)).toContain(partnerId);
    const churned = await request(app).get("/api/crm/partners?search=Spec%20Partner&status=churned").set(auth);
    expect(churned.body.data).toEqual([]);
    expectDocumented(await request(app).get("/api/crm/partners/group-names").set(auth), "get", "/crm/partners/group-names");

    const logo = await request(app).get(`/api/crm/partners/${partnerId}/logo-img`).set(auth);
    expect(logo.status).toBe(404);
    expectDocumented(logo, "get", "/crm/partners/{partnerId}/logo-img");
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

  test("POST /assistant/activity and /assistant/project-task, with the model replaced", async () => {
    const { assistantClient } = require("../services/assistant/assistantClient");
    const ask = jest.spyOn(assistantClient, "ask");
    // The task assistant belongs to the Projects module, which a new tenant may have switched off.
    const { rows: before } = await db.query(
      "SELECT is_enabled FROM tenant_features WHERE tenant_id = $1 AND feature = 'projects'", [tenantId],
    );
    await db.query(
      `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`, [tenantId],
    );
    try {
      const conversation = { messages: [{ role: "user", content: "zadzwonić jutro" }], today: "2026-10-08", language: "pl" };
      ask.mockResolvedValueOnce(JSON.stringify({
        summary: "Telefon jutro o 10:00.",
        question: null,
        intent: {
          title: "Telefon", body: null, activityAt: "2026-10-09T10:00", meetingLocation: null,
          reminder: "1h_before", priority: "important", assigneeNumber: 1, participantNames: ["Nikt Taki"], companyName: "Contract",
        },
      }));
      const activity = await request(app).post("/api/assistant/activity").set(auth)
        .send({ ...conversation, now: "14:20", type: "task", needs_company: true });
      expect(activity.status).toBe(200);
      expectDocumented(activity, "post", "/assistant/activity");

      ask.mockResolvedValueOnce(JSON.stringify({
        summary: "Zadanie: import danych.",
        question: null,
        intent: { name: "Import danych", description: null, startDate: "2026-10-12", endDate: null, durationDays: 5, typeNumber: 1, priorityNumber: null, assigneeNumbers: [1] },
      }));
      const task = await request(app).post("/api/assistant/project-task").set(auth)
        .send({ ...conversation, types: [{ id: "t1", name: "Bug" }], members: [{ id: "m1", name: "Anna" }] });
      expect(task.status).toBe(200);
      expectDocumented(task, "post", "/assistant/project-task");

      const invalid = await request(app).post("/api/assistant/activity").set(auth).send({});
      expect(invalid.status).toBe(400);
      expectDocumented(invalid, "post", "/assistant/activity");

      ask.mockRejectedValueOnce(Object.assign(new Error("Asystent jest chwilowo niedostępny, spróbuj ponownie."), { status: 503 }));
      const down = await request(app).post("/api/assistant/project-task").set(auth).send(conversation);
      expect(down.status).toBe(503);
      expectDocumented(down, "post", "/assistant/project-task");
    } finally {
      ask.mockRestore();
      if (before.length) {
        await db.query(
          "UPDATE tenant_features SET is_enabled = $2 WHERE tenant_id = $1 AND feature = 'projects'", [tenantId, before[0].is_enabled],
        );
      } else {
        await db.query("DELETE FROM tenant_features WHERE tenant_id = $1 AND feature = 'projects'", [tenantId]);
      }
    }
  });

  test("GET /crm/mobile/dashboard and its 400", async () => {
    const now = Date.now();
    const res = await request(app).get("/api/crm/mobile/dashboard").set(auth)
      .query({
        week_start: new Date(now - 3 * 86400000).toISOString(),
        week_end: new Date(now + 4 * 86400000).toISOString(),
        month_start: new Date(now - 15 * 86400000).toISOString(),
        month_end: new Date(now + 15 * 86400000).toISOString(),
        period_end: new Date(now + 86400000).toISOString(),
        period_days: 30,
      });
    expect(res.status).toBe(200);
    expect(res.body.chart.points).toHaveLength(30);
    expectDocumented(res, "get", "/crm/mobile/dashboard");

    const feed = await request(app).get("/api/crm/dashboard/activities?limit=5").set(auth);
    expect(feed.status).toBe(200);
    expect(feed.body.length).toBeGreaterThan(0);
    expectDocumented(feed, "get", "/crm/dashboard/activities");

    const missing = await request(app).get("/api/crm/mobile/dashboard").set(auth);
    expect(missing.status).toBe(400);
    expectDocumented(missing, "get", "/crm/mobile/dashboard");
  });
});

describe("projects", () => {
  const emailUtil = require("../utils/email");
  const { todayInWarsaw } = require("../services/projectDeadlineService");

  const FINANCE_SETTING_KEY = "projects_finance_enabled";
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
  const TASKS = "/projects/{projectId}/tasks";
  const TASK = `${TASKS}/{taskId}`;
  const day = (offset) =>
    new Date(Date.parse(`${todayInWarsaw()}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const get = (path, headers = auth) => request(app).get(`/api${path}`).set(headers);
  const send = (method, path, body, headers = auth) => request(app)[method](`/api${path}`).set(headers).send(body);
  const documented = (res, method, path, status = 200) => {
    expect(res.status).toBe(status);
    expectDocumented(res, method, path);
    return res.body;
  };

  let sendMail;
  let featureBefore;
  let financeSettingBefore;
  let participant;
  let participantAuth;
  let outsiderAuth;
  let config;
  let project;
  let partnerProject;
  let parentTask;
  let subtask;

  // Projects cascade to their members, tasks, messages and finance.
  async function deleteProjectData() {
    await db.query("DELETE FROM projects WHERE tenant_id = $1", [tenantId]);
    for (const table of ["project_cost_categories", "project_task_statuses", "project_task_types", "project_task_priorities"]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
  }

  async function createUser(name) {
    const { rows: [created] } = await db.query(
      `INSERT INTO users (email, first_name, last_name, is_active, is_admin, tenant_id)
       VALUES ($1, $2, 'Spec', TRUE, FALSE, $3) RETURNING *`,
      [`${name.toLowerCase()}@${DOMAIN}`, name, tenantId],
    );
    return created;
  }

  const projectUrl = (suffix = "", target = project) => `/projects/${target.id}${suffix}`;

  beforeAll(async () => {
    sendMail = jest.spyOn(emailUtil, "sendMail").mockResolvedValue();
    // A new tenant may have the Projects module and project finance switched off.
    ({ rows: featureBefore } = await db.query(
      "SELECT is_enabled FROM tenant_features WHERE tenant_id = $1 AND feature = 'projects'", [tenantId],
    ));
    await db.query(
      `INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1, 'projects', TRUE)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE`, [tenantId],
    );
    ({ rows: financeSettingBefore } = await db.query(
      "SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2", [tenantId, FINANCE_SETTING_KEY],
    ));
    await deleteProjectData();

    participant = await createUser("Uczestnik");
    participantAuth = { Authorization: `Bearer ${signAccessToken(participant)}` };
    outsiderAuth = { Authorization: `Bearer ${signAccessToken(await createUser("Postronny"))}` };

    expect((await send("put", "/admin/project-config/finance", { is_enabled: true })).status).toBe(200);
    config = (await get("/projects/config")).body;

    const created = await send("post", "/projects", {
      name: "Spec Wdrożenie", description: "Wdrożenie u klienta", start_date: day(-30), end_date: day(12),
    });
    expect(created.status).toBe(201);
    project = created.body;
    expect((await send("post", projectUrl("/members"), {
      user_id: participant.id, role: "internal_participant", access_level: "full",
    })).status).toBe(201);
    expect((await send("put", projectUrl("/crm-link"), { lead_id: leadId })).status).toBe(200);

    partnerProject = (await send("post", "/projects", { name: "Spec Serwis" })).body;
    expect((await send("put", projectUrl("/crm-link", partnerProject), { partner_ref: partnerId })).status).toBe(200);
  });

  afterAll(async () => {
    sendMail.mockRestore();
    await deleteProjectData();
    if (financeSettingBefore.length) {
      await db.query(
        "UPDATE app_settings SET value = $3 WHERE tenant_id = $1 AND key = $2",
        [tenantId, FINANCE_SETTING_KEY, financeSettingBefore[0].value],
      );
    } else {
      await db.query("DELETE FROM app_settings WHERE tenant_id = $1 AND key = $2", [tenantId, FINANCE_SETTING_KEY]);
    }
    if (featureBefore.length) {
      await db.query(
        "UPDATE tenant_features SET is_enabled = $2 WHERE tenant_id = $1 AND feature = 'projects'",
        [tenantId, featureBefore[0].is_enabled],
      );
    } else {
      await db.query("DELETE FROM tenant_features WHERE tenant_id = $1 AND feature = 'projects'", [tenantId]);
    }
  });

  test("POST and PATCH a task, then costs and messages (setup through the API)", async () => {
    parentTask = documented(await send("post", projectUrl("/tasks"), {
      name: "Wdrożenie modułu", description: "Instalacja i konfiguracja", start_date: day(-5), end_date: day(10),
      type_id: config.types[0].id, priority_id: config.priorities[0].id,
      assignee_ids: [user.id, participant.id], reminder_type: "1d_before",
    }), "post", TASKS, 201);
    subtask = documented(await send("post", projectUrl("/tasks"), {
      name: "Import danych", parent_task_id: parentTask.id, start_date: day(-10), end_date: day(-2),
      assignee_ids: [participant.id],
    }), "post", TASKS, 201);
    const doneStatus = config.statuses.find((status) => status.category === "done");
    documented(await send("post", projectUrl("/tasks"), {
      name: "Analiza", status_id: doneStatus.id, end_date: day(-3),
    }), "post", TASKS, 201);

    // Moved past the project's end date: the task slips and the project becomes delayed.
    const moved = documented(await send("patch", projectUrl(`/tasks/${parentTask.id}`), {
      end_date: day(15), end_date_change_reason: "Klient przesunął odbiór",
    }), "patch", TASK);
    expect(moved).toMatchObject({ original_end_date: day(10), slip_days: 5, has_overdue_subtasks: true });
    expect(moved.permissions.can_edit_structure).toBe(true);

    const category = config.cost_categories[0];
    expect((await send("patch", projectUrl("/finance"), {
      planned_revenue: 20000, category_budgets: [{ category_id: category.id, planned_cost: 5000 }],
    })).status).toBe(200);
    expect((await send("post", projectUrl("/finance/costs"), {
      date: day(-1), amount: 1200.5, category_id: category.id, task_id: parentTask.id,
      description: "Licencje", supplier_name: "Dostawca Sp. z o.o.", document_number: "FV/1/2026",
    })).status).toBe(201);

    documented(await send("post", projectUrl("/messages"), { body: "Startujemy w poniedziałek" }),
      "post", "/projects/{projectId}/messages", 201);
    documented(await send("post", projectUrl(`/tasks/${parentTask.id}/messages`), { body: "Dane od klienta są gotowe" }, participantAuth),
      "post", `${TASK}/messages`, 201);

    documented(await send("post", projectUrl("/tasks"), {}), "post", TASKS, 400);
    documented(await send("post", projectUrl("/tasks"), { name: "Nie moje" }, participantAuth), "post", TASKS, 403);
    documented(await send("patch", projectUrl(`/tasks/${UNKNOWN_ID}`), { name: "Brak" }), "patch", TASK, 404);
    documented(await send("post", projectUrl("/messages"), { body: "" }), "post", "/projects/{projectId}/messages", 400);
  });

  test("GET /projects/config", async () => {
    const body = documented(await get("/projects/config"), "get", "/projects/config");
    expect(body).toMatchObject({ finance_enabled: true, has_cross_project_view: true });
    expect(body.cost_categories.length).toBeGreaterThan(0);
    expect(documented(await get("/projects/config", participantAuth), "get", "/projects/config").has_cross_project_view).toBe(false);
  });

  test("GET /projects — filters, sorting, a member without finance, and its 400", async () => {
    const page = documented(
      await get(`/projects?status=open&name=Spec&delayed=true&lead_id=${leadId}&my_role=pm&sort=end_date&order=desc&page=1&page_size=10`),
      "get", "/projects",
    );
    expect(page).toMatchObject({ total: 1, page: 1, page_size: 10, can_create: true, can_filter_finance: true });
    expect(page.items[0]).toMatchObject({
      id: project.id, lead_id: leadId, is_delayed: true, delay_reasons: ["task_after_end"], task_count: 3, progress_percent: 33,
    });
    expect(page.items[0].delay_details).toMatchObject({ latest_task_end_date: day(15), days_after_end: 3 });
    expect(page.items[0].finance.cost).toEqual({ planned: 5000, actual: 1200.5 });
    expect(page.projects).toEqual(page.items);

    const all = documented(await get("/projects?status=all&sort=name"), "get", "/projects");
    expect(all.items.map((row) => row.name)).toEqual(["Spec Serwis", "Spec Wdrożenie"]);

    const asParticipant = documented(await get("/projects", participantAuth), "get", "/projects");
    expect(asParticipant.items.map((row) => row.finance)).toEqual([null]);
    expect(asParticipant.can_filter_finance).toBe(false);

    documented(await get("/projects?page_size=500"), "get", "/projects", 400);
  });

  test("GET /projects/{projectId}, its 400 and its 404 for someone outside the project", async () => {
    const card = documented(await get(projectUrl()), "get", "/projects/{projectId}");
    expect(card).toMatchObject({ my_role: "pm", can_manage: true, finance: { currency: "PLN", can_read: true, can_write: true } });
    expect(card.project).toMatchObject({ is_delayed: true, end_date: day(12) });
    expect(card.members).toHaveLength(2);

    expect(documented(await get(projectUrl(), participantAuth), "get", "/projects/{projectId}").finance).toBeNull();
    documented(await get("/projects/not-a-uuid"), "get", "/projects/{projectId}", 400);
    documented(await get(projectUrl(), outsiderAuth), "get", "/projects/{projectId}", 404);
  });

  test("GET the task tree, one task and its history", async () => {
    const tree = documented(await get(projectUrl("/tasks")), "get", TASKS);
    expect(tree.map((task) => task.timeliness)).toEqual(["on_time", "overdue", null]);
    expect(tree[1]).toMatchObject({ parent_task_id: parentTask.id, days_overdue: 2 });
    expect(tree[2]).toMatchObject({ is_completed_late: true });
    expect(tree[2].completed_at).not.toBeNull();
    expect(documented(await get(projectUrl("/tasks?mine=true")), "get", TASKS)).toHaveLength(1);

    const task = documented(await get(projectUrl(`/tasks/${parentTask.id}`)), "get", TASK);
    expect(task.reminder_at).not.toBeNull();
    const asParticipant = documented(await get(projectUrl(`/tasks/${subtask.id}`), participantAuth), "get", TASK);
    expect(asParticipant.permissions).toMatchObject({ can_edit_content: true, can_edit_structure: false });
    documented(await get(projectUrl(`/tasks/${UNKNOWN_ID}`)), "get", TASK, 404);
    documented(await get(projectUrl("/tasks/not-a-uuid")), "get", TASK, 400);

    const history = documented(await get(projectUrl(`/tasks/${parentTask.id}/history`)), "get", `${TASK}/history`);
    expect(history.map((entry) => entry.action)).toEqual(["project_task_updated", "project_task_created"]);
    expect(history[0].end_date_change_reason).toBe("Klient przesunął odbiór");
    documented(await get(projectUrl(`/tasks/${UNKNOWN_ID}/history`)), "get", `${TASK}/history`, 404);
  });

  test("GET /projects/{projectId}/tasks/search and /gantt", async () => {
    const rows = documented(await get(projectUrl("/tasks/search")), "get", `${TASKS}/search`);
    expect(rows).toMatchObject({ total: 3, page: 1, page_size: 50 });
    expect(rows.items[0]).toMatchObject({ slip_days: 5, cost_total: 1200.5, cost_currency: "PLN", project_key: project.key });
    expect(rows.items[1]).toMatchObject({ parent_task_number: parentTask.task_number, parent_task_name: "Wdrożenie modułu" });

    const filtered = documented(
      await get(projectUrl(`/tasks/search?name=modu&number=${project.key}&status_category=todo,in_progress&timeliness=on_time,overdue`
        + `&assignee=${participant.id}&priority_ids=${config.priorities[0].id}&type_ids=${config.types[0].id}`
        + `&end_from=${day(0)}&original_end_to=${day(10)}&slip_min=1&slip_max=30&cost_min=1000&sort=slip_days&order=desc&page_size=5`)),
      "get", `${TASKS}/search`,
    );
    expect(filtered.items.map((task) => task.id)).toEqual([parentTask.id]);
    expect(documented(await get(projectUrl("/tasks/search?assignee=unassigned&mine=false")), "get", `${TASKS}/search`).total).toBe(1);
    expect(documented(await get(projectUrl("/tasks/search"), participantAuth), "get", `${TASKS}/search`).items[0].cost_total).toBeNull();
    documented(await get(projectUrl("/tasks/search?sort=nonsense")), "get", `${TASKS}/search`, 400);

    const gantt = documented(await get(projectUrl("/tasks/gantt?timeliness=overdue")), "get", `${TASKS}/gantt`);
    expect(gantt).toMatchObject({ truncated: false, limit: 500 });
    expect(gantt.items.map((task) => task.id)).toEqual([subtask.id]);
    documented(await get(projectUrl("/tasks/gantt?start_from=tomorrow")), "get", `${TASKS}/gantt`, 400);
  });

  test("GET /projects/my-tasks and /projects/assigned-tasks", async () => {
    const mine = documented(await get("/projects/my-tasks?include_done=true&sort=end_date"), "get", "/projects/my-tasks");
    expect(mine.items.map((task) => task.id)).toEqual([parentTask.id]);
    expect(mine.items[0].cost_total).toBe(1200.5);
    documented(await get("/projects/my-tasks?include_done=maybe"), "get", "/projects/my-tasks", 400);

    const assigned = documented(
      await get(`/projects/assigned-tasks?assigned_to=${participant.id},${user.id}`), "get", "/projects/assigned-tasks",
    );
    expect(assigned.map((task) => task.name)).toEqual(["Import danych", "Wdrożenie modułu"]);
    expect(assigned[1]).toMatchObject({ project_key: project.key, reminder_type: "1d_before", priority_name: config.priorities[0].name });
    documented(await get("/projects/assigned-tasks?assigned_to=someone"), "get", "/projects/assigned-tasks", 400);
  });

  test("GET /projects/portfolio/* and its 403 without a scope", async () => {
    const projects = documented(await get("/projects/portfolio/projects?sort=delay&overdue_min=1"), "get", "/projects/portfolio/projects");
    expect(projects.items.map((row) => row.id)).toEqual([project.id]);
    expect(projects.items[0].overdue_task_count).toBe(1);

    const tasks = documented(
      await get(`/projects/portfolio/tasks?project_ids=${project.id}&sort=cost&order=desc&page_size=2`), "get", "/projects/portfolio/tasks",
    );
    expect(tasks).toMatchObject({ total: 3, page_size: 2 });
    expect(tasks.items[0].id).toBe(parentTask.id);

    const gantt = documented(await get(`/projects/portfolio/gantt?project_ids=${project.id}`), "get", "/projects/portfolio/gantt");
    expect(gantt.items).toHaveLength(3);

    const people = documented(await get("/projects/portfolio/people"), "get", "/projects/portfolio/people");
    expect(people.people.map((person) => person.user_id).sort()).toEqual([participant.id, user.id].sort());
    const options = documented(await get("/projects/portfolio/project-options"), "get", "/projects/portfolio/project-options");
    expect(options.projects.map((option) => option.name).sort()).toEqual(["Spec Serwis", "Spec Wdrożenie"]);

    documented(await get("/projects/portfolio/projects?progress_max=101"), "get", "/projects/portfolio/projects", 400);
    documented(await get("/projects/portfolio/tasks?slip_min=a"), "get", "/projects/portfolio/tasks", 400);
    for (const list of ["projects", "tasks", "gantt", "people", "project-options"]) {
      documented(await get(`/projects/portfolio/${list}`, participantAuth), "get", `/projects/portfolio/${list}`, 403);
    }
  });

  test("GET the project chat and a task chat", async () => {
    const projectChat = documented(await get(projectUrl("/messages")), "get", "/projects/{projectId}/messages");
    expect(projectChat.map((message) => message.body)).toEqual(["Startujemy w poniedziałek"]);
    const taskChat = documented(await get(projectUrl(`/tasks/${parentTask.id}/messages`)), "get", `${TASK}/messages`);
    expect(taskChat[0]).toMatchObject({ author_id: participant.id, author_name: "Uczestnik Spec" });

    documented(await get(projectUrl("/messages"), outsiderAuth), "get", "/projects/{projectId}/messages", 404);
    documented(await get(projectUrl(`/tasks/${UNKNOWN_ID}/messages`)), "get", `${TASK}/messages`, 404);
    documented(await send("post", projectUrl(`/tasks/${parentTask.id}/messages`), {}), "post", `${TASK}/messages`, 400);
  });

  test("GET /projects/{projectId}/finance and /finance/costs, and their 403 for a participant", async () => {
    const summary = documented(await get(projectUrl("/finance")), "get", "/projects/{projectId}/finance");
    expect(summary).toMatchObject({
      currency: "PLN", is_currency_locked: true, remaining_budget: 3799.5, suggested_planned_revenue: null,
      revenue: { planned: 20000, actual: 0 }, cost: { planned: 5000, actual: 1200.5 },
    });
    expect(summary.margin.planned).toEqual({ amount: 15000, percent: 75 });
    expect(summary.categories.find((category) => category.budget === 5000)).toMatchObject({ incurred: 1200.5, variance: 3799.5 });
    expect(summary.tasks).toHaveLength(1);

    const costs = documented(await get(projectUrl(`/finance/costs?task_id=${parentTask.id}`)), "get", "/projects/{projectId}/finance/costs");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      amount: 1200.5, status: "incurred", task_number: parentTask.task_number, document_number: "FV/1/2026",
      ksef_invoice: null, document: null, other_links: [],
    });

    documented(await get(projectUrl("/finance"), participantAuth), "get", "/projects/{projectId}/finance", 403);
    documented(await get(projectUrl("/finance/costs"), participantAuth), "get", "/projects/{projectId}/finance/costs", 403);
    documented(await get(projectUrl("/finance/costs?task_id=1")), "get", "/projects/{projectId}/finance/costs", 400);
    documented(await get(`/projects/${UNKNOWN_ID}/finance`), "get", "/projects/{projectId}/finance", 404);
  });

  test("GET /crm/leads/{id}/projects and /crm/partners/{partnerId}/projects", async () => {
    const ofLead = documented(await get(`/crm/leads/${leadId}/projects`), "get", "/crm/leads/{id}/projects");
    expect(ofLead).toHaveLength(1);
    expect(ofLead[0]).toMatchObject({ id: project.id, can_open: true, is_delayed: true });
    expect(ofLead[0].tasks.map((task) => task.status_category)).toEqual(["todo", "todo", "done"]);
    expect(ofLead[0].finance.margin.actual).toEqual({ amount: -1200.5, percent: null });

    const ofPartner = documented(await get(`/crm/partners/${partnerId}/projects`), "get", "/crm/partners/{partnerId}/projects");
    expect(ofPartner.map((linked) => linked.id)).toEqual([partnerProject.id]);
    expect(ofPartner[0].tasks).toEqual([]);

    documented(await get("/crm/leads/999999999/projects"), "get", "/crm/leads/{id}/projects", 404);
    documented(await get("/crm/leads/abc/projects"), "get", "/crm/leads/{id}/projects", 400);
    documented(await get(`/crm/partners/${UNKNOWN_ID}/projects`), "get", "/crm/partners/{partnerId}/projects", 404);
    documented(await get(`/crm/leads/${leadId}/projects`, participantAuth), "get", "/crm/leads/{id}/projects", 403);
  });

  test("PUT /profile/project-deadline-notifications and its 400", async () => {
    const path = "/profile/project-deadline-notifications";
    expect(documented(await send("put", path, { is_enabled: false }), "put", path)).toEqual({ project_deadline_notifications_enabled: false });
    documented(await send("put", path, { is_enabled: true }), "put", path);
    documented(await send("put", path, { is_enabled: "true" }), "put", path, 400);
  });

  test("a closed project is read-only: 409 on writes", async () => {
    expect((await send("post", projectUrl("/close", partnerProject))).status).toBe(200);
    documented(await send("post", projectUrl("/messages", partnerProject), { body: "Za późno" }), "post", "/projects/{projectId}/messages", 409);
    documented(await send("post", projectUrl("/tasks", partnerProject), { name: "Za późno" }), "post", TASKS, 409);
  });
});
