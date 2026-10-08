"use strict";

// GET /api/crm/mobile/dashboard — the sales dashboard of the mobile app.

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");

const DOMAIN = "mobile-dashboard-test.crmtree.local";
const DAY_MS = 86400000;

const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const daysFromToday = (days) => new Date(startOfToday.getTime() + days * DAY_MS).toISOString();
const WEEK_START = daysFromToday(-3);
const PERIOD = {
  week_start: WEEK_START,
  week_end: daysFromToday(4),
  month_start: daysFromToday(-40),
  month_end: daysFromToday(40),
  period_end: daysFromToday(1),
  period_days: 7,
};

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

async function createLead(owner, company, stage, value, extra = "") {
  const res = await request(app).post("/api/crm/leads").set(auth(owner)).send({ company });
  expect(res.status).toBe(201);
  await db.query(`UPDATE crm_leads SET stage = $2, value_pln = $3 ${extra} WHERE id = $1`, [res.body.id, stage, value]);
  return res.body.id;
}

const getDashboard = (user, query = {}) => request(app)
  .get("/api/crm/mobile/dashboard")
  .query({ ...PERIOD, ...query })
  .set(auth(user));

async function cleanUp() {
  await db.query(`DELETE FROM crm_lead_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_leads WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Mobile Dashboard Test', 'zz-mobile-dashboard', TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
  );
  tenantId = tenant.id;
  await cleanUp();

  users.rep = await createUser("rep");
  users.colleague = await createUser("colleague");
  users.admin = await createUser("admin", { crmRole: "sales_manager", isAdmin: true });

  await createLead(users.rep, "W ofercie", "offer", 20000);
  await createLead(users.rep, "Z zeszłego tygodnia", "qualification", 5000, `, created_at = '${daysFromToday(-5)}'`);
  await createLead(users.rep, "Jeszcze nowy", "new", 1000);
  await createLead(users.rep, "Wstrzymany", "offer", 9999, ", hold_active = TRUE");
  // Won today: updated_at is set to now by the table trigger.
  await createLead(users.rep, "Wygrany", "closed_won", 40000);
  await createLead(users.rep, "Zarchiwizowany", "archived", 77777);
  await createLead(users.colleague, "Lead kolegi", "offer", 7000);
}, 60000);

afterAll(cleanUp);

describe("GET /api/crm/mobile/dashboard", () => {
  test("figures: new leads against the week before, the open pipeline and this month's wins", async () => {
    const res = await getDashboard(users.rep);
    expect(res.status).toBe(200);
    expect(res.body.kpis).toEqual({
      new_leads: 4,
      new_leads_previous: 1,
      new_leads_value_pln: 20000 + 1000 + 9999 + 40000,
      new_leads_value_previous_pln: 5000,
      active_leads: 2,
      pipeline_value_pln: 25000,
      month_won_count: 1,
      month_won_value_pln: 40000,
    });
  });

  test("funnel: every open stage in order, without leads on hold", async () => {
    const res = await getDashboard(users.rep);
    expect(res.body.funnel).toEqual([
      { stage: "new", count: 1, value_pln: 1000 },
      { stage: "qualification", count: 1, value_pln: 5000 },
      { stage: "presentation", count: 0, value_pln: 0 },
      { stage: "offer", count: 1, value_pln: 20000 },
      { stage: "negotiation", count: 0, value_pln: 0 },
    ]);
  });

  test("chart: won leads only, added up day by day, with the period before for comparison", async () => {
    const current = (await getDashboard(users.rep)).body.chart;
    expect(current).toEqual({ period_days: 7, total_pln: 40000, previous_total_pln: 0, points: [0, 0, 0, 0, 0, 0, 40000] });

    // A week later today's win belongs to the period before.
    const later = (await getDashboard(users.rep, { period_end: daysFromToday(8) })).body.chart;
    expect(later).toMatchObject({ total_pln: 0, previous_total_pln: 40000 });
    expect(later.points).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("an admin sees the whole company and can narrow it to one salesperson", async () => {
    const company = await getDashboard(users.admin);
    expect(company.body.kpis).toMatchObject({ active_leads: 3, pipeline_value_pln: 32000 });

    const one = await getDashboard(users.admin, { assigned_to: users.colleague.id });
    expect(one.body.kpis).toMatchObject({ active_leads: 1, pipeline_value_pln: 7000, month_won_count: 0 });
  });

  test("a salesperson cannot look at a colleague's numbers", async () => {
    expect((await getDashboard(users.rep, { assigned_to: users.colleague.id })).status).toBe(403);
    expect((await getDashboard(users.rep, { assigned_to: users.rep.id })).status).toBe(200);
  });

  test("the activity feed can be narrowed to one salesperson", async () => {
    const note = (owner, company, title) => db.query(
      `INSERT INTO crm_lead_activities (lead_id, type, title, status, created_by, tenant_id)
       SELECT id, 'note', $3, 'new', $1, tenant_id FROM crm_leads WHERE tenant_id = $4 AND company = $2`,
      [owner.id, company, title, tenantId],
    );
    await note(users.rep, "W ofercie", "Notatka handlowca");
    await note(users.colleague, "Lead kolegi", "Notatka kolegi");
    const feedTitles = async (query) => (await request(app).get("/api/crm/dashboard/activities")
      .query(query).set(auth(users.admin))).body.map((row) => row.title);

    expect(await feedTitles({})).toEqual(expect.arrayContaining(["Notatka handlowca", "Notatka kolegi"]));
    expect(await feedTitles({ assigned_to: users.colleague.id })).toEqual(["Notatka kolegi"]);
  });

  test("400 without the period, 401 without a token", async () => {
    expect((await request(app).get("/api/crm/mobile/dashboard").set(auth(users.rep))).status).toBe(400);
    expect((await getDashboard(users.rep, { period_days: 14 })).status).toBe(400);
    expect((await request(app).get("/api/crm/mobile/dashboard").query(PERIOD)).status).toBe(401);
  });
});
