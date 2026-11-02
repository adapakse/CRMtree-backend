"use strict";

// The Hold reminder task and its closing comment are stored once for the whole
// team, so they are written in the tenant's default language.

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");
const leadStageService = require("../services/leadStageService");

const DOMAIN = "lead-hold-texts-test.crmtree.local";

let tenantId;
let rep;
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

async function cleanUp() {
  await db.query(`DELETE FROM crm_lead_activities WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM crm_leads WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active, default_locale) VALUES ('Lead Hold Texts Test', 'zz-lead-hold-texts', TRUE, 'ru')
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL, default_locale = 'ru' RETURNING id`,
  );
  tenantId = tenant.id;
  await cleanUp();
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, crm_role, tenant_id)
     VALUES ($1, 'rep', 'Test', TRUE, 'salesperson', $2) RETURNING *`,
    [`rep@${DOMAIN}`, tenantId],
  );
  rep = user;
});

afterAll(async () => {
  await cleanUp();
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

test("setting and removing a Hold writes the reminder task in the tenant language", async () => {
  const created = await request(app).post("/api/crm/leads").set(auth(rep)).send({ company: "Vantex" });
  expect(created.status).toBe(201);
  const { holdKeys } = await leadStageService.getStageConfig(tenantId);
  await db.query(`UPDATE crm_leads SET stage = $1 WHERE id = $2`, [holdKeys[0], created.body.id]);

  const held = await request(app).put(`/api/crm/leads/${created.body.id}/hold`).set(auth(rep))
    .send({ reason: "Бюджет на следующий год", until: "2099-01-15" });
  expect(held.status).toBe(200);

  const { rows: [task] } = await db.query(
    `SELECT a.id, a.title, a.body FROM crm_lead_activities a JOIN crm_leads l ON l.hold_task_id = a.id WHERE l.id = $1`,
    [created.body.id],
  );
  expect(task.title).toBe("Возобновите продажи — пауза завершена");
  expect(task.body).toBe("Пауза завершилась 2099-01-15. Причина: Бюджет на следующий год");

  const removed = await request(app).delete(`/api/crm/leads/${created.body.id}/hold`).set(auth(rep));
  expect(removed.status).toBe(200);
  const { rows: [closed] } = await db.query(`SELECT status, close_comment FROM crm_lead_activities WHERE id = $1`, [task.id]);
  expect(closed).toEqual({ status: "closed", close_comment: "Пауза снята" });
});
