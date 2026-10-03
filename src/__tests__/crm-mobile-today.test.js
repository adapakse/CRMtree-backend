"use strict";

// GET /api/crm/mobile/today — the "Dziś" screen of the mobile app (ADR 001).

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");

const DOMAIN = "mobile-today-test.crmtree.local";
const DAY_START = "2026-10-05T00:00:00+02:00";
const DAY_END = "2026-10-06T00:00:00+02:00";

let tenantId;
const users = {};
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

async function createUser(name, { crmRole = "salesperson", isAdmin = false } = {}) {
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role, tenant_id)
     VALUES ($1, $2, 'Test', TRUE, $3, $4, $5) RETURNING *`,
    [`${name}@${DOMAIN}`, name, isAdmin, crmRole, tenantId],
  );
  return user;
}

async function createLead(owner, company) {
  const res = await request(app).post("/api/crm/leads").set(auth(owner)).send({ company });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addLeadActivity(owner, leadId, activity) {
  const res = await request(app).post(`/api/crm/leads/${leadId}/activities`).set(auth(owner)).send(activity);
  expect(res.status).toBe(201);
  return res.body.id;
}

const getToday = (user) => request(app)
  .get("/api/crm/mobile/today")
  .query({ day_start: DAY_START, day_end: DAY_END })
  .set(auth(user));

const titles = (items) => items.map((item) => item.title);

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Mobile Today Test', 'zz-mobile-today', TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
  );
  tenantId = tenant.id;
  await cleanUp();

  users.rep = await createUser("rep");
  users.colleague = await createUser("colleague");
  users.admin = await createUser("admin", { crmRole: "sales_manager", isAdmin: true });

  const myLead = await createLead(users.rep, "Vantex Sp. z o.o.");
  const colleagueLead = await createLead(users.colleague, "Kolmex S.A.");
  users.myLead = myLead;

  await addLeadActivity(users.rep, myLead, { type: "meeting", title: "Prezentacja 14:00", activity_at: "2026-10-05T14:00:00+02:00", duration_min: 45 });
  await addLeadActivity(users.rep, myLead, { type: "call", title: "Telefon 09:30", activity_at: "2026-10-05T09:30:00+02:00" });
  await addLeadActivity(users.rep, myLead, { type: "task", title: "Tuż po północy", activity_at: "2026-10-05T00:05:00+02:00" });
  await addLeadActivity(users.rep, myLead, { type: "task", title: "Jutro", activity_at: "2026-10-06T00:00:00+02:00" });
  await addLeadActivity(users.rep, myLead, { type: "task", title: "Zaległe sprzed tygodnia", activity_at: "2026-09-28T10:00:00+02:00" });
  await addLeadActivity(users.rep, myLead, { type: "task", title: "Zaległe wczoraj", activity_at: "2026-10-04T23:50:00+02:00" });
  await addLeadActivity(users.rep, myLead, { type: "note", title: "Notatka z datą", activity_at: "2026-10-05T11:00:00+02:00" });
  const closedId = await addLeadActivity(users.rep, myLead, { type: "task", title: "Zamknięte dziś", activity_at: "2026-10-05T12:00:00+02:00" });
  await db.query(`UPDATE crm_lead_activities SET status = 'closed' WHERE id = $1`, [closedId]);
  // On my lead, but handed to a colleague.
  await addLeadActivity(users.rep, myLead, { type: "task", title: "Oddane koledze", activity_at: "2026-10-05T13:00:00+02:00", assigned_to: users.colleague.id });
  await addLeadActivity(users.colleague, colleagueLead, { type: "task", title: "Zadanie kolegi", activity_at: "2026-10-05T10:00:00+02:00" });

  const partner = await request(app).post("/api/crm/partners").set(auth(users.admin))
    .send({ company: "Nortex Group", manager_id: users.rep.id, status: "active" });
  expect([200, 201]).toContain(partner.status);
  const partnerActivity = await request(app).post(`/api/crm/partners/${partner.body.id}/activities`).set(auth(users.admin))
    .send({ type: "call", title: "Telefon do partnera 16:00", activity_at: "2026-10-05T16:00:00+02:00" });
  expect(partnerActivity.status).toBe(201);
  users.partnerId = partner.body.id;

  await db.query(
    `INSERT INTO crm_lead_activities (lead_id, type, title, is_read, status, created_by, tenant_id)
     VALUES ($1, 'email', 'Odpowiedź klienta', FALSE, 'new', $2, $3)`,
    [myLead, users.rep.id, tenantId],
  );
}, 60000);

async function cleanUp() {
  await db.query(`DELETE FROM crm_lead_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_leads WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partner_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_partners WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
}

afterAll(cleanUp);

describe("GET /api/crm/mobile/today", () => {
  test("agenda: my open meetings, calls and tasks of the day, from leads and partners, in time order", async () => {
    const res = await getToday(users.rep);
    expect(res.status).toBe(200);
    expect(titles(res.body.agenda)).toEqual([
      "Tuż po północy",
      "Telefon 09:30",
      "Prezentacja 14:00",
      "Telefon do partnera 16:00",
    ]);
    const partnerCall = res.body.agenda[3];
    expect(partnerCall).toMatchObject({ source_type: "partner", source_id: users.partnerId, source_name: "Nortex Group" });
    expect(res.body.agenda[2]).toMatchObject({ source_type: "lead", source_id: String(users.myLead), duration_min: 45, status: "new" });
  });

  test("overdue: open items dated before the day, oldest first", async () => {
    const res = await getToday(users.rep);
    expect(titles(res.body.overdue)).toEqual(["Zaległe sprzed tygodnia", "Zaległe wczoraj"]);
  });

  test("attention: my leads with unread messages, with the counts", async () => {
    const res = await getToday(users.rep);
    expect(res.body.attention).toEqual([{
      lead_id: String(users.myLead),
      company: "Vantex Sp. z o.o.",
      new_email_count: 1,
      unread_sms_count: 0,
      unread_whatsapp_count: 0,
      missed_call_count: 0,
    }]);
  });

  test("a task handed to someone else shows up in their day, not in mine", async () => {
    const mine = await getToday(users.rep);
    expect(titles(mine.body.agenda)).not.toContain("Oddane koledze");

    const theirs = await getToday(users.colleague);
    expect(titles(theirs.body.agenda)).toEqual(["Zadanie kolegi", "Oddane koledze"]);
    expect(theirs.body.attention).toEqual([]);
  });

  test("an admin sees only their own day, not the whole company's", async () => {
    const res = await getToday(users.admin);
    expect(res.body).toEqual({ agenda: [], overdue: [], attention: [] });
  });

  test("400 without the day bounds, 401 without a token", async () => {
    const missing = await request(app).get("/api/crm/mobile/today").set(auth(users.rep));
    expect(missing.status).toBe(400);
    const anonymous = await request(app).get("/api/crm/mobile/today").query({ day_start: DAY_START, day_end: DAY_END });
    expect(anonymous.status).toBe(401);
  });
});
