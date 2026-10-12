"use strict";

// Etapy leada przez HTTP — to, czego test serwisu nie wyłapie: czy zapytania
// raportowe faktycznie się WYKONUJĄ po wymianie literałów na parametry.
//
// To nie jest paranoja: pierwsza wersja tej zmiany przekazywała do każdego
// zapytania wszystkie kody etapów ze stałą numeracją $N, a Postgres odrzuca
// zapytanie z parametrem, który nigdzie nie jest użyty („nie można określić typu
// danych parametru $7"). Test serwisu tego nie widział, bo liczył na własnych,
// ręcznie budowanych zapytaniach. Dlatego tu wołamy prawdziwe trasy.
//
// Najważniejszy scenariusz: tenant USUWA etap Wygrana. Raport musi dalej działać
// i zwracać null/0 tam, gdzie wygranej nie ma — a nie wywalać się 500.

const request = require("supertest");
const app = require("../app");
const db = require("../config/database");
const { signAccessToken } = require("../middleware/auth");

const SLUG = "zz-lead-stages-api";
const DOMAIN = "lead-stages-api.crmtree.local";

let tenantId;
let admin;
const auth = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

const listStages = () => request(app).get("/api/admin/settings/lead-stages").set(auth(admin));
const report = () => request(app).get("/api/crm/leads/report").set(auth(admin));
const leadList = (query = {}) => request(app).get("/api/crm/leads").query(query).set(auth(admin));

async function stage(key) {
  const res = await listStages();
  return res.body.stages.find((s) => s.key === key);
}

async function createLead(company, body = {}) {
  const res = await request(app).post("/api/crm/leads").set(auth(admin)).send({ company, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function cleanUp() {
  await db.query("DELETE FROM crm_leads WHERE tenant_id = $1", [tenantId]);
  await db.query("DELETE FROM tenant_lead_stages WHERE tenant_id = $1", [tenantId]);
}

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Lead Stages API', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
  await cleanUp();
  // Bez ON CONFLICT (email): ten sam e-mail może istnieć u wielu tenantów, więc
  // nie ma na nim globalnego unique — patrz CRMtree-backend/CLAUDE.md.
  await db.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  const { rows: [user] } = await db.query(
    `INSERT INTO users (email, first_name, last_name, is_active, is_admin, crm_role, tenant_id)
     VALUES ($1, 'Admin', 'Test', TRUE, TRUE, 'sales_manager', $2) RETURNING *`,
    [`admin@${DOMAIN}`, tenantId],
  );
  admin = user;
});

afterEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  // audit_logs trzyma FK na tenants — bez tego DELETE tenanta nie przechodzi.
  await db.query("DELETE FROM audit_logs WHERE tenant_id = $1", [tenantId]);
  await db.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await db.query("DELETE FROM tenants WHERE slug = $1", [SLUG]);
});

describe("GET /admin/settings/lead-stages", () => {
  test("zwraca wbudowany lejek bez pojęcia etapu systemowego", async () => {
    const res = await listStages();
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s) => s.key)).toContain("closed_won");
    // is_system zniknęło w migracji 0326 — żaden etap nie jest „nietykalny".
    expect(res.body.stages.every((s) => !("is_system" in s))).toBe(true);
  });

  test("etapy jadą też w payloadzie /admin/settings, czytanym przez każdego usera", async () => {
    const res = await request(app).get("/api/admin/settings").set(auth(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lead_stages)).toBe(true);
    expect(res.body.lead_stages.length).toBeGreaterThan(0);
  });
});

describe("zmiana nazwy", () => {
  test("Wygraną da się nazwać inaczej, a kod etapu i leady zostają", async () => {
    const lead = await createLead("Rename Co");
    const won = await stage("closed_won");

    const res = await request(app)
      .patch(`/api/admin/settings/lead-stages/${won.id}`)
      .set(auth(admin))
      .send({ label: "Deal zamknięty" });
    expect(res.status).toBe(200);
    expect(res.body.stage.key).toBe("closed_won");
    expect(res.body.stage.label).toBe("Deal zamknięty");

    const after = await request(app).get(`/api/crm/leads/${lead.id}`).set(auth(admin));
    expect(after.body.stage).toBe(lead.stage);
  });
});

describe("raport i lista po przebudowie SQL", () => {
  test("raport i lista działają na domyślnej konfiguracji", async () => {
    await createLead("Report Co", { stage: "qualification" });
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.kpi).toBeDefined();
    expect(res.body.funnel).toBeDefined();
    expect(res.body.stage_velocity).toBeDefined();

    const list = await leadList();
    expect(list.status).toBe(200);
  });

  test("raport działa po USUNIĘCIU etapu Wygrana — bez wygranej metryki są puste, nie zerowe-kłamliwe", async () => {
    const won = await stage("closed_won");
    const del = await request(app)
      .delete(`/api/admin/settings/lead-stages/${won.id}`)
      .set(auth(admin))
      .send({});
    expect(del.status).toBe(200);

    expect(await stage("closed_won")).toBeUndefined();

    await createLead("No Won Co", { stage: "offer" });
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.kpi.won).toBe(0);
    // Brak wygranych ORAZ przegranych → win rate nie istnieje, nie jest „0%".
    expect(res.body.kpi.win_rate).toBeNull();

    const list = await leadList();
    expect(list.status).toBe(200);
  });

  test("raport działa po usunięciu Przegranej", async () => {
    const lost = await stage("closed_lost");
    const del = await request(app)
      .delete(`/api/admin/settings/lead-stages/${lost.id}`)
      .set(auth(admin))
      .send({});
    expect(del.status).toBe(200);

    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.lost_reasons).toBeDefined();
  });

  test("raport działa po dodaniu własnego etapu i przestawieniu kolejności", async () => {
    const created = await request(app)
      .post("/api/admin/settings/lead-stages")
      .set(auth(admin))
      .send({ label: "Pilotaż" });
    expect(created.status).toBe(201);

    const all = (await listStages()).body.stages;
    const openIds = all.filter((s) => s.kind === "open").map((s) => s.id).reverse();
    const reordered = await request(app)
      .put("/api/admin/settings/lead-stages/order")
      .set(auth(admin))
      .send({ ordered_ids: openIds });
    expect(reordered.status).toBe(200);

    await createLead("Pilot Co", { stage: created.body.stage.key });
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body.funnel.some((f) => f.stage === created.body.stage.key)).toBe(true);
  });
});

describe("usuwanie etapu z leadami", () => {
  test("bez wskazania etapu docelowego usunięcie PRZECHODZI, a leady same się przenoszą", async () => {
    const created = await request(app)
      .post("/api/admin/settings/lead-stages").set(auth(admin)).send({ label: "Pilotaż" });
    const lead = await createLead("Auto Move Co", { stage: created.body.stage.key });

    const res = await request(app)
      .delete(`/api/admin/settings/lead-stages/${created.body.stage.id}`)
      .set(auth(admin)).send({});
    expect(res.status).toBe(200);
    expect(res.body.movedLeads).toBe(1);
    expect(res.body.movedTo).toBe("negotiation");

    const after = await request(app).get(`/api/crm/leads/${lead.id}`).set(auth(admin));
    expect(after.body.stage).toBe("negotiation");
  });

  test("lista podaje delete_target_key, żeby panel pokazał w pytaniu realny cel", async () => {
    const res = await listStages();
    const byKey = (k) => res.body.stages.find((s) => s.key === k);
    expect(byKey("offer").delete_target_key).toBe("presentation");
    expect(byKey("closed_won").delete_target_key).toBe("negotiation");
  });

  test("ze wskazanym etapem docelowym leady przechodzą i etap znika", async () => {
    const created = await request(app)
      .post("/api/admin/settings/lead-stages").set(auth(admin)).send({ label: "Pilotaż" });
    const lead = await createLead("Moved Co", { stage: created.body.stage.key });

    const res = await request(app)
      .delete(`/api/admin/settings/lead-stages/${created.body.stage.id}`)
      .set(auth(admin)).send({ move_leads_to: "offer" });
    expect(res.status).toBe(200);
    expect(res.body.movedLeads).toBe(1);

    const after = await request(app).get(`/api/crm/leads/${lead.id}`).set(auth(admin));
    expect(after.body.stage).toBe("offer");
    expect(await stage(created.body.stage.key)).toBeUndefined();
  });
});

describe("granice strukturalne", () => {
  test("archiwum i stanu konwersji nie da się usunąć — to nie kroki lejka", async () => {
    for (const key of ["archived", "onboarding"]) {
      const target = await stage(key);
      const res = await request(app)
        .delete(`/api/admin/settings/lead-stages/${target.id}`)
        .set(auth(admin)).send({});
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/aplikacja ustawia sama/);
    }
  });

  test("archiwum da się przemianować, mimo że nie da się go usunąć", async () => {
    const archived = await stage("archived");
    const res = await request(app)
      .patch(`/api/admin/settings/lead-stages/${archived.id}`)
      .set(auth(admin)).send({ label: "Kosz" });
    expect(res.status).toBe(200);
    expect(res.body.stage.label).toBe("Kosz");
  });

  test("nie da się usunąć ostatniego etapu lejka", async () => {
    const all = (await listStages()).body.stages.filter((s) => s.kind === "open");
    // Usuwamy wszystkie poza jednym — ostatni musi zostać.
    for (const s of all.slice(1)) {
      const res = await request(app)
        .delete(`/api/admin/settings/lead-stages/${s.id}`)
        .set(auth(admin)).send({ move_leads_to: all[0].key });
      expect(res.status).toBe(200);
    }
    const last = (await listStages()).body.stages.filter((s) => s.kind === "open");
    expect(last).toHaveLength(1);

    const res = await request(app)
      .delete(`/api/admin/settings/lead-stages/${last[0].id}`)
      .set(auth(admin)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/ostatniego etapu lejka/);
  });
});

describe("archiwizacja leada po zmianie nazwy archiwum", () => {
  test("działa na skonfigurowanym kodzie etapu, nie na literale", async () => {
    const lead = await createLead("Archive Co");
    const archived = await stage("archived");
    await request(app)
      .patch(`/api/admin/settings/lead-stages/${archived.id}`)
      .set(auth(admin)).send({ label: "Kosz" });

    const res = await request(app).put(`/api/crm/leads/${lead.id}/archive`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("archived");

    // Zarchiwizowany lead znika z domyślnej listy...
    const list = await leadList();
    expect(list.body.data.some((l) => l.id === lead.id)).toBe(false);
    // ...ale jest widoczny po jawnym filtrze.
    const filtered = await leadList({ stage: "archived" });
    expect(filtered.body.data.some((l) => l.id === lead.id)).toBe(true);
  });
});
