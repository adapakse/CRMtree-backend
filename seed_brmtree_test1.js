"use strict";
/**
 * Seed script: BRMtree_test1 tenant
 * Generates realistic test data: tenant, users, documents, leads, partners, DWH sales
 * Run: node seed_brmtree_test1.js
 */

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "crmtree",
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "",
  ssl:      process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const TENANT_NAME  = "BRMtree_test1";
const TENANT_SLUG  = "brmtree-test1";
const DWH_PREFIX   = "brmtree_test1";
const PASSWORD_HASH = bcrypt.hashSync("Test1234!", 4);

// ── helpers ─────────────────────────────────────────────────────────────────
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rndInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rndFloat = (min, max) => parseFloat((Math.random() * (max - min) + min).toFixed(2));
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const daysFrom = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const monthAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };

// ── DATA POOLS ───────────────────────────────────────────────────────────────
const LEAD_SOURCES  = ["Cold_Call", "LinkedIn_Lead_Form", "Partner", "Formularz_online", "Alias_Hello", "LinkedIn_in_mail"];
const LEAD_STAGES   = ["new", "qualification", "presentation", "offer", "negotiation", "closed_won", "closed_lost"];
const INDUSTRIES    = ["Tourism", "IT", "Finance", "Transport", "Retail", "Other"];
const SERVICES      = ["hotel", "lot", "pociag", "transfer", "wynajem_auta", "ubezpieczenie"];
const PARTNER_GROUPS_NAMES = ["Premium Partners", "Online Portals", "Corporate Agents", "DMC Partners"];

const LEADS_DATA = [
  { company: "VoyageMax Sp. z o.o.",    contact: "Paweł Nowak",      email: "p.nowak@voyagemax.pl",    stage: "offer",         value: 48000,  prob: 65, source: "LinkedIn_Lead_Form",  hot: true },
  { company: "TravelPro Polska",        contact: "Katarzyna Wiśniewska", email: "k.wisniewska@travelpro.pl", stage: "negotiation", value: 72000,  prob: 80, source: "Partner",           hot: true },
  { company: "FlySmart Tours",          contact: "Andrzej Kowalczyk", email: "a.kowalczyk@flysmart.pl", stage: "presentation",  value: 35000,  prob: 40, source: "Cold_Call",           hot: false },
  { company: "HotelConnect Sp. z o.o.", contact: "Monika Jabłońska",  email: "m.jablonska@hotelconnect.pl", stage: "qualification", value: 55000, prob: 30, source: "Formularz_online", hot: false },
  { company: "EuroCity Travel",         contact: "Tomasz Zając",      email: "t.zajac@eurocity.pl",     stage: "new",           value: 22000,  prob: 20, source: "Alias_Hello",         hot: false },
  { company: "Meridian Holidays",       contact: "Anna Kowalska",     email: "a.kowalska@meridian.pl",  stage: "offer",         value: 91000,  prob: 70, source: "LinkedIn_in_mail",    hot: true },
  { company: "SkyRoute Polska",         contact: "Marcin Lewandowski",email: "m.lewandowski@skyroute.pl",stage: "closed_won",   value: 63000,  prob: 100,source: "Cold_Call",           hot: false },
  { company: "Baltica Tours",           contact: "Ewa Wróblewska",    email: "e.wroblewska@baltica.pl", stage: "negotiation",   value: 44000,  prob: 75, source: "Partner",             hot: true },
  { company: "ProActive Travel",        contact: "Grzegorz Dąbrowski",email: "g.dabrowski@proactive.pl",stage: "presentation",  value: 28000,  prob: 35, source: "LinkedIn_Lead_Form",  hot: false },
  { company: "NordTours Sp. z o.o.",    contact: "Joanna Kamińska",   email: "j.kaminska@nordtours.pl", stage: "closed_lost",   value: 38000,  prob: 0,  source: "Cold_Call",           hot: false },
  { company: "WestWing Travel",         contact: "Piotr Maj",         email: "p.maj@westwing.pl",       stage: "qualification", value: 17000,  prob: 25, source: "Formularz_online",    hot: false },
  { company: "Adria Holidays",          contact: "Sylwia Michalska",  email: "s.michalska@adria.pl",    stage: "offer",         value: 82000,  prob: 60, source: "Partner",             hot: true },
  { company: "AirBridge Tours",         contact: "Rafał Woźniak",     email: "r.wozniak@airbridge.pl",  stage: "new",           value: 12000,  prob: 15, source: "Alias_Hello",         hot: false },
  { company: "GlobeTrek Polska",        contact: "Natalia Pawlak",    email: "n.pawlak@globetrek.pl",   stage: "presentation",  value: 59000,  prob: 45, source: "LinkedIn_in_mail",    hot: false },
  { company: "AlphaRoute Sp. z o.o.",   contact: "Krzysztof Sikora",  email: "k.sikora@alpharoute.pl",  stage: "closed_won",    value: 76000,  prob: 100,source: "Partner",             hot: false },
  { company: "SunCarrier Poland",       contact: "Magdalena Duda",    email: "m.duda@suncarrier.pl",    stage: "negotiation",   value: 105000, prob: 85, source: "LinkedIn_Lead_Form",  hot: true },
  { company: "TransAlps Travel",        contact: "Łukasz Adamczyk",   email: "l.adamczyk@transalps.pl", stage: "qualification", value: 31000,  prob: 30, source: "Cold_Call",           hot: false },
  { company: "VivaTour Polska",         contact: "Izabela Krawczyk",  email: "i.krawczyk@vivatour.pl",  stage: "offer",         value: 67000,  prob: 55, source: "Formularz_online",    hot: true },
];

const PARTNERS_DATA = [
  { company: "Orbis Travel Sp. z o.o.",   nip: "5271001234", status: "active",     group: 0, contract_value: 180000, dwh_id: 101, step: 0 },
  { company: "Rainbow Tours S.A.",         nip: "6261002345", status: "active",     group: 0, contract_value: 245000, dwh_id: 102, step: 0 },
  { company: "NetTours Polska Sp. z o.o.", nip: "7770003456", status: "active",     group: 1, contract_value: 320000, dwh_id: 103, step: 0 },
  { company: "Almatur Sp. z o.o.",         nip: "5210004567", status: "active",     group: 2, contract_value: 95000,  dwh_id: 104, step: 0 },
  { company: "Ecco Holiday Polska",        nip: "5510005678", status: "active",     group: 0, contract_value: 210000, dwh_id: 105, step: 0 },
  { company: "Coral Travel Sp. z o.o.",    nip: "9510006789", status: "active",     group: 1, contract_value: 155000, dwh_id: 106, step: 0 },
  { company: "Wezyr Holidays",             nip: "6661007890", status: "onboarding", group: 0, contract_value: 75000,  dwh_id: null, step: 1 },
  { company: "Prima Holiday Sp. z o.o.",   nip: "7721008901", status: "onboarding", group: 2, contract_value: 48000,  dwh_id: null, step: 2 },
  { company: "GoGlobal Travel",            nip: "5211009012", status: "onboarding", group: 1, contract_value: 62000,  dwh_id: null, step: 0 },
  { company: "Grecos Holiday Polska",      nip: "6311010123", status: "inactive",   group: 0, contract_value: 88000,  dwh_id: 107, step: 0 },
  { company: "TravelMate Pro",             nip: "9741011234", status: "active",     group: 3, contract_value: 130000, dwh_id: 108, step: 0 },
  { company: "Enter Air Tours",            nip: "5221012345", status: "churned",    group: 0, contract_value: 0,      dwh_id: 109, step: 0 },
];

// DWH: 6 active partners with 15 months of sales data
const DWH_PARTNERS = [
  { id: 101, name: "orbis",       company: "Orbis Travel Sp. z o.o.",   group: "Premium",  country: "Polska" },
  { id: 102, name: "rainbow",     company: "Rainbow Tours S.A.",          group: "Premium",  country: "Polska" },
  { id: 103, name: "nettours",    company: "NetTours Polska Sp. z o.o.", group: "Online",   country: "Polska" },
  { id: 104, name: "almatur",     company: "Almatur Sp. z o.o.",          group: "Corporate",country: "Polska" },
  { id: 105, name: "ecco",        company: "Ecco Holiday Polska",         group: "Premium",  country: "Polska" },
  { id: 106, name: "coral",       company: "Coral Travel Sp. z o.o.",     group: "Online",   country: "Polska" },
  { id: 107, name: "grecos",      company: "Grecos Holiday Polska",       group: "Premium",  country: "Polska" },
  { id: 108, name: "travelmate",  company: "TravelMate Pro",              group: "DMC",      country: "Polska" },
  { id: 109, name: "enterair",    company: "Enter Air Tours",             group: "Premium",  country: "Polska" },
];

// Monthly sales multipliers per partner (simulates seasonal variation + growth)
const PARTNER_SALES_BASE = {
  101: { hotel: 15, lot: 40, pociag: 5,  transfer: 8,  wynajem_auta: 3, ubezpieczenie: 2 },
  102: { hotel: 25, lot: 80, pociag: 3,  transfer: 15, wynajem_auta: 5, ubezpieczenie: 8 },
  103: { hotel: 8,  lot: 120,pociag: 0,  transfer: 20, wynajem_auta: 10,ubezpieczenie: 15 },
  104: { hotel: 5,  lot: 18, pociag: 12, transfer: 6,  wynajem_auta: 2, ubezpieczenie: 1 },
  105: { hotel: 20, lot: 55, pociag: 2,  transfer: 10, wynajem_auta: 4, ubezpieczenie: 6 },
  106: { hotel: 12, lot: 45, pociag: 0,  transfer: 8,  wynajem_auta: 7, ubezpieczenie: 10 },
  107: { hotel: 18, lot: 35, pociag: 4,  transfer: 9,  wynajem_auta: 3, ubezpieczenie: 3 },
  108: { hotel: 6,  lot: 22, pociag: 8,  transfer: 12, wynajem_auta: 5, ubezpieczenie: 2 },
  109: { hotel: 3,  lot: 15, pociag: 1,  transfer: 4,  wynajem_auta: 2, ubezpieczenie: 1 },
};
// Seasonal multipliers (month 1–12)
const SEASON = [0.6, 0.65, 0.75, 0.9, 1.1, 1.3, 1.5, 1.4, 1.2, 0.95, 0.7, 0.65];
// Price per product per service
const GROSS_PRICE = { hotel: 1200, lot: 2800, pociag: 450, transfer: 380, wynajem_auta: 320, ubezpieczenie: 180 };
const MARGIN_PCT  = { hotel: 0.14, lot: 0.12, pociag: 0.18, transfer: 0.22, wynajem_auta: 0.20, ubezpieczenie: 0.30 };
const FEE_PCT     = { hotel: 0.10, lot: 0.09, pociag: 0.12, transfer: 0.15, wynajem_auta: 0.14, ubezpieczenie: 0.20 };

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. TENANT ─────────────────────────────────────────────────────────
    console.log("Creating tenant...");
    const { rows: existingTenants } = await client.query(
      `SELECT id FROM tenants WHERE slug = $1 OR name = $2 LIMIT 1`,
      [TENANT_SLUG, TENANT_NAME]
    );
    let tId;
    if (existingTenants.length) {
      tId = existingTenants[0].id;
      await client.query(
        `UPDATE tenants SET is_active = TRUE, dwh_schema_prefix = $2 WHERE id = $1`,
        [tId, DWH_PREFIX]
      );
    } else {
      const { rows: [tenant] } = await client.query(`
        INSERT INTO tenants (name, slug, dwh_schema_prefix, is_active)
        VALUES ($1, $2, $3, TRUE) RETURNING id
      `, [TENANT_NAME, TENANT_SLUG, DWH_PREFIX]);
      tId = tenant.id;
    }
    console.log("  tenant id:", tId);

    // Features
    const features = ["documents","leads","sales_reports","onboarding","partner_registry","dwh_integration","performance"];
    for (const f of features) {
      await client.query(`
        INSERT INTO tenant_features (tenant_id, feature, is_enabled)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE
      `, [tId, f]);
    }

    // Settings (copy from Gold)
    const { rows: goldSettings } = await client.query(`
      SELECT key, value, label, description, value_type, category FROM app_settings
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'crmtree-gold')
    `);
    for (const s of goldSettings) {
      await client.query(`
        INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3
      `, [tId, s.key, s.value, s.label, s.description, s.value_type, s.category]);
    }

    // ── 2. USERS ──────────────────────────────────────────────────────────
    console.log("Creating users...");
    // Clean up old (kolejność ważna — najpierw FK-zależne tabele)
    await client.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM refresh_tokens WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_sales_budgets WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM user_group_roles WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tId]);

    const usersToCreate = [
      { email: "admin@brmtree-test1.local",   first: "Adam",    last: "Administrator", is_admin: true,  crm_role: null },
      { email: "manager@brmtree-test1.local",  first: "Marta",   last: "Kierownik",     is_admin: false, crm_role: "sales_manager" },
      { email: "anna.k@brmtree-test1.local",   first: "Anna",    last: "Kowalska",      is_admin: false, crm_role: "salesperson" },
      { email: "piotr.n@brmtree-test1.local",  first: "Piotr",   last: "Nowak",         is_admin: false, crm_role: "salesperson" },
      { email: "ewa.w@brmtree-test1.local",    first: "Ewa",     last: "Wiśniewska",    is_admin: false, crm_role: "salesperson" },
    ];
    const userIds = {};
    for (const u of usersToCreate) {
      const { rows: [usr] } = await client.query(`
        INSERT INTO users (email, first_name, last_name, is_admin, is_active, crm_role, password_hash, tenant_id)
        VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7) RETURNING id
      `, [u.email, u.first, u.last, u.is_admin, u.crm_role, PASSWORD_HASH, tId]);
      userIds[u.email] = usr.id;
    }
    const adminId   = userIds["admin@brmtree-test1.local"];
    const managerId = userIds["manager@brmtree-test1.local"];
    const salesIds  = [
      userIds["anna.k@brmtree-test1.local"],
      userIds["piotr.n@brmtree-test1.local"],
      userIds["ewa.w@brmtree-test1.local"],
    ];
    console.log("  users:", Object.keys(userIds).length);

    // ── 3. DOCUMENT GROUPS ────────────────────────────────────────────────
    console.log("Creating document groups...");
    await client.query(`DELETE FROM documents WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM group_profiles WHERE tenant_id = $1`, [tId]);

    const docGroups = ["Sprzedaż", "Prawny", "IT", "Finanse"];
    const groupIds = [];
    for (const g of docGroups) {
      const { rows: [grp] } = await client.query(`
        INSERT INTO group_profiles (name, display_name, tenant_id, created_by, is_active)
        VALUES ($1,$1,$2,$3,TRUE) RETURNING id
      `, [g, tId, adminId]);
      groupIds.push(grp.id);
      // Add all users to each group with full access
      for (const uid of [managerId, ...salesIds]) {
        await client.query(`
          INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id)
          VALUES ($1,$2,'full',$3) ON CONFLICT DO NOTHING
        `, [uid, grp.id, tId]);
      }
    }
    console.log("  groups:", groupIds.length);

    // ── 4. DOCUMENTS ──────────────────────────────────────────────────────
    console.log("Creating documents...");
    const { rows: seqRow } = await client.query(`
      SELECT COALESCE(MAX(last_n), 0) AS n FROM doc_number_seq WHERE tenant_id = $1
    `, [tId]);
    let docNum = parseInt(seqRow[0].n);

    const docsData = [
      { name: "Umowa partnerska — Orbis Travel",     type: "partner_agreement",    status: "signed",        gdpr: "data_processing_entrustment", grp: 0, exp: daysFrom(365) },
      { name: "Umowa partnerska — Rainbow Tours",    type: "partner_agreement",    status: "signed",        gdpr: "data_processing_entrustment", grp: 0, exp: daysFrom(180) },
      { name: "Umowa partnerska — NetTours",         type: "partner_agreement",    status: "being_signed",  gdpr: "data_processing_entrustment", grp: 0, exp: null },
      { name: "NDA — Almatur 2026",                  type: "nda",                  status: "signed",        gdpr: "no_gdpr",                    grp: 1, exp: daysFrom(730) },
      { name: "NDA — Ecco Holiday",                  type: "nda",                  status: "signed",        gdpr: "no_gdpr",                    grp: 1, exp: daysFrom(365) },
      { name: "Umowa partnerska — Coral Travel",     type: "partner_agreement",    status: "completed",     gdpr: "data_processing_entrustment", grp: 0, exp: daysFrom(90) },
      { name: "Umowa IT — system rezerwacji",        type: "it_supplier_agreement",status: "signed",        gdpr: "no_gdpr",                    grp: 2, exp: daysFrom(500) },
      { name: "Umowa IT — hosting Azure",            type: "it_supplier_agreement",status: "signed",        gdpr: "data_processing_entrustment", grp: 2, exp: daysFrom(400) },
      { name: "Umowa — Wezyr Holidays (draft)",      type: "partner_agreement",    status: "new",           gdpr: "data_processing_entrustment", grp: 0, exp: null },
      { name: "NDA — Prima Holiday",                 type: "nda",                  status: "being_signed",  gdpr: "no_gdpr",                    grp: 1, exp: null },
      { name: "Umowa partnerska — GoGlobal Travel",  type: "partner_agreement",    status: "being_edited",  gdpr: "data_processing_entrustment", grp: 0, exp: null },
      { name: "Umowa partnerska — TravelMate Pro",   type: "partner_agreement",    status: "signed",        gdpr: "data_processing_entrustment", grp: 0, exp: daysFrom(270) },
      { name: "Umowa pracownicza — Anna Kowalska",   type: "employee_agreement",   status: "signed",        gdpr: "data_administration",        grp: 3, exp: null },
      { name: "Umowa pracownicza — Piotr Nowak",     type: "employee_agreement",   status: "signed",        gdpr: "data_administration",        grp: 3, exp: null },
      { name: "Umowa pracownicza — Ewa Wiśniewska",  type: "employee_agreement",   status: "signed",        gdpr: "data_administration",        grp: 3, exp: null },
      { name: "Aneks nr 1 — Orbis Travel",           type: "partner_agreement",    status: "signed",        gdpr: "data_processing_entrustment", grp: 0, exp: daysFrom(365) },
      { name: "NDA — SunCarrier Poland (prospekt)",  type: "nda",                  status: "new",           gdpr: "no_gdpr",                    grp: 1, exp: null },
      { name: "Umowa partnerska — Grecos Holiday",   type: "partner_agreement",    status: "completed",     gdpr: "data_processing_entrustment", grp: 0, exp: daysAgo(60) },
      { name: "Umowa — Enter Air Tours (archiwum)",  type: "partner_agreement",    status: "rejected",      gdpr: "data_processing_entrustment", grp: 0, exp: null },
      { name: "IT Security Policy 2026",             type: "it_supplier_agreement",status: "signed",        gdpr: "no_gdpr",                    grp: 2, exp: daysFrom(320) },
    ];

    const documentIds = [];
    for (const d of docsData) {
      docNum++;
      const docNumber = `DOC-2026-${String(docNum).padStart(4, "0")}`;
      const owner = rnd([...salesIds, managerId]);
      const { rows: [doc] } = await client.query(`
        INSERT INTO documents
          (doc_number, name, doc_type, status, gdpr_type, group_id, owner_id,
           creation_date, expiration_date, created_by, tenant_id)
        VALUES ($1,$2,$3::doc_type,$4::doc_status,$5::gdpr_type,$6,$7,$8,$9,$10,$11)
        RETURNING id
      `, [docNumber, d.name, d.type, d.status, d.gdpr, groupIds[d.grp],
          owner, daysAgo(rndInt(10, 180)), d.exp, adminId, tId]);
      documentIds.push(doc.id);
    }
    await client.query(`
      INSERT INTO doc_number_seq (tenant_id, year, last_n)
      VALUES ($1, 2026, $2)
      ON CONFLICT (tenant_id, year) DO UPDATE SET last_n = $2
    `, [tId, docNum]);
    console.log("  documents:", documentIds.length);

    // ── 5. CRM PARTNER GROUPS ─────────────────────────────────────────────
    console.log("Creating CRM partner groups...");
    await client.query(`DELETE FROM crm_onboarding_tasks WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_partner_activities WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_lead_activities WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_partners WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_leads WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_partner_groups WHERE tenant_id = $1`, [tId]);
    await client.query(`DELETE FROM crm_sales_budgets WHERE tenant_id = $1`, [tId]);

    const crmGroupIds = [];
    const crmGroupManagers = [managerId, managerId, salesIds[0], managerId];
    for (let i = 0; i < PARTNER_GROUPS_NAMES.length; i++) {
      const { rows: [g] } = await client.query(`
        INSERT INTO crm_partner_groups (name, industry, manager_id, created_by, tenant_id)
        VALUES ($1,'Tourism',$2,$3,$4) RETURNING id
      `, [PARTNER_GROUPS_NAMES[i], crmGroupManagers[i], adminId, tId]);
      crmGroupIds.push(g.id);
    }

    // ── 6. PARTNERS ───────────────────────────────────────────────────────
    console.log("Creating partners...");
    const partnerIds = [];
    const partnerDwhMap = {}; // dwh_id → partner CRM id
    const salesCycle = [salesIds[0], salesIds[1], salesIds[2], salesIds[0], salesIds[1], salesIds[2],
                        managerId, salesIds[0], salesIds[1], salesIds[2], managerId, salesIds[0]];

    for (let i = 0; i < PARTNERS_DATA.length; i++) {
      const p = PARTNERS_DATA[i];
      const mgr = salesCycle[i];
      const contractExpires = p.status === "active"
        ? daysFrom(rndInt(60, 540))
        : p.status === "onboarding" ? daysFrom(rndInt(200, 400)) : null;
      const { rows: [part] } = await client.query(`
        INSERT INTO crm_partners
          (company, nip, status, group_id, manager_id, contract_value, annual_turnover_currency,
           contract_expires, online_pct, onboarding_step, dwh_partner_id, created_by, tenant_id,
           contact_name, email, phone, industry, source, first_contact_date)
        VALUES ($1,$2,$3,$4,$5,$6,'PLN',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING id
      `, [p.company, p.nip, p.status, crmGroupIds[p.group], mgr,
          p.contract_value, contractExpires,
          rnd([10,20,30,40,50,60,70,80]), p.step,
          p.dwh_id, adminId, tId,
          `Kontakt ${p.company.split(" ")[0]}`,
          `kontakt@${p.company.toLowerCase().replace(/[^a-z]/g, "").slice(0, 10)}.pl`,
          `+48 ${rndInt(500, 799)} ${rndInt(100, 999)} ${rndInt(100, 999)}`,
          rnd(INDUSTRIES), rnd(LEAD_SOURCES),
          daysAgo(rndInt(90, 720))]);
      partnerIds.push(part.id);
      if (p.dwh_id) partnerDwhMap[p.dwh_id] = part.id;
    }
    console.log("  partners:", partnerIds.length);

    // ── 7. PARTNER ACTIVITIES ─────────────────────────────────────────────
    console.log("Creating partner activities...");
    const actTypes  = ["email", "call", "meeting", "note"];
    const actTitles = {
      email:   ["Follow-up po spotkaniu", "Oferta cenowa Q3", "Potwierdzenie warunków", "Newsletter partnerski"],
      call:    ["Rozmowa techniczna", "Omówienie wyników", "Aktualizacja umowy", "Problemy z integracją"],
      meeting: ["Spotkanie kwartalne QBR", "Prezentacja nowych funkcji", "Kickoff onboarding", "Przegląd SLA"],
      note:    ["Uwagi z rozmowy", "Decyzja odłożona", "Klient zainteresowany rozszerzeniem", "Ryzyko churnu"],
    };
    for (const pid of partnerIds) {
      const count = rndInt(3, 8);
      for (let k = 0; k < count; k++) {
        const type = rnd(actTypes);
        await client.query(`
          INSERT INTO crm_partner_activities
            (type, title, body, activity_at, assigned_to, created_by, partner_id, tenant_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed')
        `, [type, rnd(actTitles[type]),
            `Działanie ${type} zarejestrowane automatycznie.`,
            daysAgo(rndInt(1, 180)),
            rnd([managerId, ...salesIds]), adminId, pid, tId]);
      }
    }

    // ── 8. ONBOARDING TASKS ───────────────────────────────────────────────
    console.log("Creating onboarding tasks...");
    const onboardingTemplates = [
      { step: 0, title: "Podpisanie umowy partnerskiej", type: "task" },
      { step: 0, title: "Weryfikacja NIP i danych firmy",  type: "task" },
      { step: 1, title: "Konfiguracja konta w systemie",   type: "task" },
      { step: 1, title: "Szkolenie wstępne — telefon",     type: "call" },
      { step: 2, title: "Szkolenie z obsługi platformy",   type: "training" },
      { step: 2, title: "Wysłanie materiałów szkoleniowych", type: "email" },
      { step: 3, title: "Test transakcji pilotażowej",     type: "task" },
      { step: 3, title: "Spotkanie uruchomieniowe",        type: "meeting" },
    ];
    const onboardingPartners = PARTNERS_DATA
      .map((p, i) => ({ ...p, id: partnerIds[i] }))
      .filter(p => p.status === "onboarding");

    for (const p of onboardingPartners) {
      for (const tmpl of onboardingTemplates) {
        const isDone = tmpl.step < p.step;
        await client.query(`
          INSERT INTO crm_onboarding_tasks
            (step, title, type, assigned_to, due_date, done, done_at, created_by, partner_id, tenant_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [tmpl.step, tmpl.title, tmpl.type,
            rnd([managerId, ...salesIds]),
            daysFrom(tmpl.step * 7 + rndInt(0, 5)),
            isDone, isDone ? daysAgo(rndInt(1, 14)) : null,
            adminId, p.id, tId]);
      }
    }

    // ── 9. LEADS ──────────────────────────────────────────────────────────
    console.log("Creating leads...");
    const leadIds = [];
    for (let i = 0; i < LEADS_DATA.length; i++) {
      const l = LEADS_DATA[i];
      const assignee = salesCycle[i % salesIds.length];
      const { rows: [lead] } = await client.query(`
        INSERT INTO crm_leads
          (company, contact_name, email, source, stage, value_pln, probability,
           close_date, industry, assigned_to, hot, notes, created_by, tenant_id,
           annual_turnover_currency, first_contact_date, online_pct)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PLN',$15,$16)
        RETURNING id
      `, [l.company, l.contact, l.email, l.source, l.stage,
          l.value, l.prob,
          l.stage === "closed_won" || l.stage === "closed_lost"
            ? daysAgo(rndInt(5, 60))
            : daysFrom(rndInt(14, 120)),
          rnd(INDUSTRIES), assignee, l.hot,
          `Lead pozyskany przez ${l.source.replace(/_/g," ")}.`,
          adminId, tId,
          daysAgo(rndInt(7, 180)),
          rnd([10,20,30,40,50,60,70])]);
      leadIds.push(lead.id);
    }
    console.log("  leads:", leadIds.length);

    // Lead activities
    console.log("Creating lead activities...");
    for (const lid of leadIds) {
      const count = rndInt(2, 6);
      for (let k = 0; k < count; k++) {
        const type = rnd(actTypes);
        await client.query(`
          INSERT INTO crm_lead_activities
            (type, title, body, activity_at, assigned_to, created_by, lead_id, tenant_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed')
        `, [type,
            rnd({ email: ["Follow-up", "Wysłanie oferty", "Odpowiedź na pytania"],
                  call:  ["Rozmowa kwalifikacyjna", "Omówienie demo", "Decyzja zakupowa"],
                  meeting:["Prezentacja online", "Demo produktu", "Spotkanie negocjacyjne"],
                  note:  ["Klient potrzebuje czasu", "Zainteresowanie wysokie", "Konkurs cenowy"] }[type]),
            `Działanie ${type}.`,
            daysAgo(rndInt(1, 90)),
            rnd([managerId, ...salesIds]), adminId, lid, tId]);
      }
    }

    // ── 10. BUDGETS ───────────────────────────────────────────────────────
    console.log("Creating budgets...");
    const budgetAmounts = { [salesIds[0]]: 80000, [salesIds[1]]: 65000, [salesIds[2]]: 72000 };
    for (const uid of salesIds) {
      for (let q = 1; q <= 4; q++) {
        const base = budgetAmounts[uid] / 4;
        const variation = rndFloat(0.85, 1.15);
        await client.query(`
          INSERT INTO crm_sales_budgets (user_id, year, period_type, period_number, amount, currency, created_by, tenant_id)
          VALUES ($1, 2026, 'quarter', $2, $3, 'PLN', $4, $5)
          ON CONFLICT DO NOTHING
        `, [uid, q, Math.round(base * variation), adminId, tId]);
      }
    }

    // ── 11. DWH TABLES ────────────────────────────────────────────────────
    console.log("Creating DWH tables...");

    await client.query(`DROP TABLE IF EXISTS dwh.${DWH_PREFIX}_sales`);
    await client.query(`DROP TABLE IF EXISTS dwh.${DWH_PREFIX}_partner`);

    await client.query(`
      CREATE TABLE dwh.${DWH_PREFIX}_partner (
        LIKE dwh.crmtree_gold_partner INCLUDING ALL
      )
    `);
    await client.query(`
      CREATE TABLE dwh.${DWH_PREFIX}_sales (
        LIKE dwh.crmtree_gold_sales INCLUDING ALL
      )
    `);

    // Insert DWH partners
    for (const dp of DWH_PARTNERS) {
      await client.query(`
        INSERT INTO dwh.${DWH_PREFIX}_partner
          (partner_id, company_name, partner_group, country, currency, is_contract_signed,
           is_test_account, emails, created_at, updated_at)
        VALUES ($1,$2,$3,$4,'PLN',TRUE,FALSE,$5::jsonb,NOW(),NOW())
      `, [dp.id, dp.company, dp.group, dp.country,
          JSON.stringify([`faktury@${dp.name}.pl`])]);
    }

    // Insert DWH sales: 15 months × 9 partners × up to 6 services
    console.log("Generating DWH sales data...");
    let salesRowCount = 0;
    for (let monthOffset = 14; monthOffset >= 0; monthOffset--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - monthOffset);
      const saleDate = d.toISOString().slice(0, 10);
      const seasonIdx = d.getMonth(); // 0–11

      for (const dp of DWH_PARTNERS) {
        const base = PARTNER_SALES_BASE[dp.id];
        // Enter Air Tours (109): dead after 6 months ago
        if (dp.id === 109 && monthOffset < 6) continue;
        // ── Churn test scenarios ─────────────────────────────────────────────
        // Almatur (104): no May+April → last sale March → CRITICAL (50+50=100 pts)
        if (dp.id === 104 && monthOffset <= 1) continue;
        // TravelMate (108): no May → last sale April → HIGH (50+30=80 pts, ~46% drop)
        if (dp.id === 108 && monthOffset === 0) continue;
        // Coral (106): no May → last sale April → LOW (50+0=50 pts)
        if (dp.id === 106 && monthOffset === 0) continue;
        // ── Activity factor overrides ────────────────────────────────────────
        // Grecos (107): lower activity (inactive)
        let activityFactor = dp.id === 107 ? 0.4 : 1.0;
        // TravelMate April (108, monthOffset=1): reduced to ~45% → April≈46% drop vs March → HIGH
        if (dp.id === 108 && monthOffset === 1) activityFactor = 0.45;
        // Ecco Holiday April (105, monthOffset=1): very low → ~88% drop vs March → MEDIUM (10+50=60 pts)
        if (dp.id === 105 && monthOffset === 1) activityFactor = 0.10;

        for (const svc of SERVICES) {
          const products = base[svc];
          if (!products) continue;
          const actualProducts = Math.max(1, Math.round(
            products * SEASON[seasonIdx] * activityFactor * rndFloat(0.8, 1.2)
          ));
          const grossPrice  = GROSS_PRICE[svc] * rndFloat(0.9, 1.1);
          const gross       = parseFloat((actualProducts * grossPrice).toFixed(2));
          const net         = parseFloat((gross * 0.92).toFixed(2));
          const fee         = parseFloat((gross * FEE_PCT[svc]).toFixed(2));
          const margin      = parseFloat((gross * MARGIN_PCT[svc]).toFixed(2));

          await client.query(`
            INSERT INTO dwh.${DWH_PREFIX}_sales
              (sale_date, partner_id, service_category, currency,
               gross_sales_value_pln, net_sales_value_pln,
               gross_fee_value_pln, gross_margin_value_pln, number_of_products)
            VALUES ($1,$2,$3,'PLN',$4,$5,$6,$7,$8)
          `, [saleDate, dp.id, svc, gross, net, fee, margin, actualProducts]);
          salesRowCount++;
        }
      }
    }
    console.log(`  DWH sales rows: ${salesRowCount}`);

    await client.query("COMMIT");
    console.log("\n✅ Seed completed successfully!");
    console.log("─────────────────────────────────────────");
    console.log(`Tenant:    ${TENANT_NAME} (${TENANT_SLUG})`);
    console.log(`Tenant ID: ${tId}`);
    console.log(`Users:     ${Object.keys(userIds).length}`);
    console.log(`  admin@brmtree-test1.local       / Test1234!`);
    console.log(`  manager@brmtree-test1.local     / Test1234!`);
    console.log(`  anna.k@brmtree-test1.local      / Test1234!`);
    console.log(`  piotr.n@brmtree-test1.local     / Test1234!`);
    console.log(`  ewa.w@brmtree-test1.local       / Test1234!`);
    console.log(`Doc groups: ${docGroups.join(", ")}`);
    console.log(`Documents:  ${documentIds.length}`);
    console.log(`CRM groups: ${PARTNER_GROUPS_NAMES.join(", ")}`);
    console.log(`Partners:   ${partnerIds.length} (6 active, 3 onboarding, 1 inactive, 1 churned, 1 active)`);
    console.log(`Leads:      ${leadIds.length}`);
    console.log(`DWH:        dwh.${DWH_PREFIX}_partner (${DWH_PARTNERS.length} partners)`);
    console.log(`            dwh.${DWH_PREFIX}_sales (${salesRowCount} rows, 15 months)`);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
