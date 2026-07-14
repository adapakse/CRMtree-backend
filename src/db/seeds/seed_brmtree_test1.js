'use strict';

/**
 * Seed script: BRMtree_test1 tenant
 *
 * Usage:
 *   node src/db/seeds/seed_brmtree_test1.js
 *
 * Azure:
 *   DB_HOST=crmtree-db.postgres.database.azure.com DB_NAME=crmtreedb \
 *   DB_USER=crmtreeadmin DB_PASSWORD=... DB_SSL=true \
 *   node src/db/seeds/seed_brmtree_test1.js
 */

require('dotenv').config({ path: '.env.local', override: false });
require('dotenv').config({ override: false });

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const TENANT_ID = process.env.TENANT_ID || '3b99d775-b6e3-41a8-828d-c9877a7b6ea4';
const PASSWORD  = 'CRMtest123!';

// Domain used by existing user1-5 / manager1-5 accounts on Azure
const DOMAIN_AZURE  = 'crmtree.pl';
// Domain used by the previous (bad) seed — will be cleaned up
const DOMAIN_OLD    = 'brmtree-test1.local';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'crmtree',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ─── Reference data ───────────────────────────────────────────────────────────

const COMPANIES = [
  'Alfa Travels Sp. z o.o.', 'Beta Tour S.A.', 'Gamma Business Travel',
  'Delta Corporate', 'Epsilon Logistics', 'Zeta Consulting', 'Eta Solutions',
  'Theta Group', 'Iota Services', 'Kappa Ventures', 'Lambda Partners',
  'Mu Dynamics', 'Nu Capital', 'Xi Technologies', 'Omicron Travel',
  'Pi Management', 'Rho Innovations', 'Sigma Enterprises', 'Tau Systems',
  'Upsilon Holdings', 'Phi Network', 'Chi Global', 'Psi Corporation',
  'Omega Express', 'Alpha Prime', 'Beta Plus', 'Gamma Pro',
  'Delta Solutions', 'Epsilon Travel', 'Zeta Business',
  'Meridian Sp. z o.o.', 'Polaris Tour', 'Nexus Corporate Travel',
  'Vega Business Group', 'Orion Consulting', 'Sirius Partners',
  'Antares Systems', 'Rigel Ventures', 'Capella Holdings', 'Deneb Travel',
  'Aquila Corporate', 'Lynx Solutions', 'Cygnus Management', 'Leo Services',
  'Virgo Group', 'Libra Dynamics', 'Scorpio Technologies', 'Sagittarius Corp',
  'Aquarius Travel', 'Pisces Holdings', 'Centaurus Partners', 'Perseus Group',
  'Andromeda Sp. z o.o.', 'Cassiopeia Tours', 'Orion Business', 'Cepheus Corp',
  'Draco Logistics', 'Hydra Solutions', 'Serpens Consulting', 'Corona Travel',
];

const INDUSTRIES = [
  'IT', 'Finance', 'Manufacturing', 'Retail', 'Healthcare',
  'Logistics', 'Consulting', 'Energy', 'Education', 'Real Estate',
];

const SOURCES = ['cold_call', 'referral', 'website', 'linkedin', 'conference', 'partner'];

const CONTACT_FIRST = ['Anna', 'Piotr', 'Marek', 'Katarzyna', 'Tomasz', 'Agnieszka', 'Michał', 'Joanna'];
const CONTACT_LAST  = ['Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamińska', 'Lewandowski', 'Zielińska'];

const ACTIVITY_TYPES  = ['call', 'meeting', 'email', 'note', 'task'];
const LEAD_ACT_TITLES = [
  'Initial contact call', 'Qualification call', 'Product demo',
  'Sent proposal', 'Follow-up after demo', 'Contract negotiation',
  'Decision maker meeting', 'Requirements review', 'Pricing discussion',
  'Reference check', 'Legal review', 'Closed deal handover',
];
const PART_ACT_TITLES = [
  'Quarterly business review', 'Health check call', 'Upsell discussion',
  'Contract renewal', 'Training session', 'New feature presentation',
  'Integration support', 'Churn prevention call', 'Annual review',
  'Escalation handling', 'License expansion', 'Support call',
];

const DOC_TYPES = ['Umowa', 'Oferta', 'NDA', 'Aneks', 'Zamówienie'];

// ─── Lead stage templates — all with past close_date ─────────────────────────
// 8 leads per user: spread across stages, all with value + past close_date
const LEAD_TEMPLATES = [
  { stage: 'closed_won',    daysAgoMin: 5,  daysAgoMax: 55,  valueMin: 40000,  valueMax: 220000 },
  { stage: 'closed_won',    daysAgoMin: 15, daysAgoMax: 80,  valueMin: 25000,  valueMax: 180000 },
  { stage: 'negotiation',   daysAgoMin: 2,  daysAgoMax: 20,  valueMin: 60000,  valueMax: 250000 },
  { stage: 'offer',         daysAgoMin: 1,  daysAgoMax: 14,  valueMin: 30000,  valueMax: 150000 },
  { stage: 'presentation',  daysAgoMin: 3,  daysAgoMax: 30,  valueMin: 20000,  valueMax: 100000 },
  { stage: 'qualification', daysAgoMin: 5,  daysAgoMax: 40,  valueMin: 10000,  valueMax: 80000  },
  { stage: 'new',           daysAgoMin: 1,  daysAgoMax: 15,  valueMin: 15000,  valueMax: 90000  },
  { stage: 'closed_lost',   daysAgoMin: 10, daysAgoMax: 70,  valueMin: 20000,  valueMax: 120000 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

let companyIdx = 0;
const nextCompany = () => COMPANIES[companyIdx++ % COMPANIES.length];
const rand        = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick        = (arr) => arr[rand(0, arr.length - 1)];
const dateAgo     = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };
const tsAgo       = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
const contactName = () => `${pick(CONTACT_FIRST)} ${pick(CONTACT_LAST)}`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 0. Clean up old seed data ─────────────────────────────────────────────
    console.log('🧹 Cleaning up old seed data...');

    // Delete old @brmtree-test1.local users and their data
    const { rows: oldUsers } = await client.query(
      `SELECT id FROM users WHERE email LIKE $1 AND tenant_id = $2`,
      [`%@${DOMAIN_OLD}`, TENANT_ID]
    );
    if (oldUsers.length > 0) {
      const oldIds = oldUsers.map(u => u.id);
      await client.query(`DELETE FROM crm_lead_activities WHERE assigned_to = ANY($1) AND tenant_id = $2`, [oldIds, TENANT_ID]);
      await client.query(`DELETE FROM crm_partner_activities WHERE assigned_to = ANY($1) AND tenant_id = $2`, [oldIds, TENANT_ID]);

      const { rows: oldLeads } = await client.query(`SELECT id FROM crm_leads WHERE assigned_to = ANY($1) AND tenant_id = $2`, [oldIds, TENANT_ID]);
      if (oldLeads.length > 0) {
        const oldLeadIds = oldLeads.map(l => l.id);
        await client.query(`DELETE FROM crm_lead_documents WHERE lead_id = ANY($1) AND tenant_id = $2`, [oldLeadIds, TENANT_ID]);
        await client.query(`DELETE FROM crm_leads WHERE id = ANY($1) AND tenant_id = $2`, [oldLeadIds, TENANT_ID]);
      }

      const { rows: oldPartners } = await client.query(`SELECT id FROM crm_partners WHERE manager_id = ANY($1) AND tenant_id = $2`, [oldIds, TENANT_ID]);
      if (oldPartners.length > 0) {
        const oldPartnerIds = oldPartners.map(p => p.id);
        await client.query(`DELETE FROM crm_partner_scores WHERE partner_id = ANY($1) AND tenant_id = $2`, [oldPartnerIds, TENANT_ID]);
        await client.query(`DELETE FROM crm_partner_documents WHERE partner_id = ANY($1) AND tenant_id = $2`, [oldPartnerIds, TENANT_ID]);
        await client.query(`DELETE FROM crm_partners WHERE id = ANY($1) AND tenant_id = $2`, [oldPartnerIds, TENANT_ID]);
      }
      // Clear any other FK references before deleting users
      await client.query(`DELETE FROM crm_sales_budgets WHERE created_by = ANY($1)`, [oldIds]);
      await client.query(`UPDATE crm_sales_budgets SET user_id = NULL WHERE user_id = ANY($1)`, [oldIds]).catch(() => {});
      await client.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [oldIds]);
      await client.query(`DELETE FROM users WHERE id = ANY($1)`, [oldIds]);
      console.log(`  ✓ Removed ${oldIds.length} old @${DOMAIN_OLD} users and their data`);
    } else {
      console.log(`  ✓ No old @${DOMAIN_OLD} users found`);
    }

    // ── 1. Upsert users ───────────────────────────────────────────────────────
    console.log('🔑 Hashing password...');
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    console.log('👤 Upserting users...');
    const salespersons = [];
    const managers     = [];

    for (let i = 1; i <= 5; i++) {
      const email = `user${i}@${DOMAIN_AZURE}`;
      // Delete existing leads for this user so we can reseed clean
      const { rows: existing } = await client.query(
        `SELECT id FROM users WHERE email = $1 AND tenant_id = $2`, [email, TENANT_ID]
      );
      if (existing.length > 0) {
        const uid = existing[0].id;
        const { rows: uLeads } = await client.query(`SELECT id FROM crm_leads WHERE assigned_to = $1 AND tenant_id = $2`, [uid, TENANT_ID]);
        if (uLeads.length > 0) {
          const lIds = uLeads.map(l => l.id);
          await client.query(`DELETE FROM crm_lead_documents WHERE lead_id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_lead_activities WHERE lead_id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_leads WHERE id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
        }
        const { rows: uPartners } = await client.query(`SELECT id FROM crm_partners WHERE manager_id = $1 AND tenant_id = $2`, [uid, TENANT_ID]);
        if (uPartners.length > 0) {
          const pIds = uPartners.map(p => p.id);
          await client.query(`DELETE FROM crm_partner_scores WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partner_documents WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partner_activities WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partners WHERE id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
        }
      }

      const { rows } = await client.query(`
        INSERT INTO users (tenant_id, email, first_name, last_name, password_hash, crm_role, is_active)
        VALUES ($1, $2, $3, $4, $5, 'salesperson', true)
        ON CONFLICT (tenant_id, email) WHERE tenant_id IS NOT NULL DO UPDATE SET
          first_name = EXCLUDED.first_name,
          crm_role   = EXCLUDED.crm_role,
          is_active  = true
        RETURNING id
      `, [TENANT_ID, email, `User${i}`, `Testowy`, passwordHash]);
      salespersons.push({ id: rows[0].id, email });
      console.log(`  ✓ ${email}`);
    }

    for (let i = 1; i <= 5; i++) {
      const email = `manager${i}@${DOMAIN_AZURE}`;
      const { rows: existing } = await client.query(
        `SELECT id FROM users WHERE email = $1 AND tenant_id = $2`, [email, TENANT_ID]
      );
      if (existing.length > 0) {
        const uid = existing[0].id;
        const { rows: uLeads } = await client.query(`SELECT id FROM crm_leads WHERE assigned_to = $1 AND tenant_id = $2`, [uid, TENANT_ID]);
        if (uLeads.length > 0) {
          const lIds = uLeads.map(l => l.id);
          await client.query(`DELETE FROM crm_lead_documents WHERE lead_id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_lead_activities WHERE lead_id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_leads WHERE id = ANY($1) AND tenant_id = $2`, [lIds, TENANT_ID]);
        }
        const { rows: uPartners } = await client.query(`SELECT id FROM crm_partners WHERE manager_id = $1 AND tenant_id = $2`, [uid, TENANT_ID]);
        if (uPartners.length > 0) {
          const pIds = uPartners.map(p => p.id);
          await client.query(`DELETE FROM crm_partner_scores WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partner_documents WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partner_activities WHERE partner_id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
          await client.query(`DELETE FROM crm_partners WHERE id = ANY($1) AND tenant_id = $2`, [pIds, TENANT_ID]);
        }
      }

      const { rows } = await client.query(`
        INSERT INTO users (tenant_id, email, first_name, last_name, password_hash, crm_role, is_active)
        VALUES ($1, $2, $3, $4, $5, 'sales_manager', true)
        ON CONFLICT (tenant_id, email) WHERE tenant_id IS NOT NULL DO UPDATE SET
          first_name = EXCLUDED.first_name,
          crm_role   = EXCLUDED.crm_role,
          is_active  = true
        RETURNING id
      `, [TENANT_ID, email, `Manager${i}`, `Testowy`, passwordHash]);
      managers.push({ id: rows[0].id, email });
      console.log(`  ✓ ${email}`);
    }

    const allUsers = [...salespersons, ...managers];

    // ── 2. Leads — all with value_pln + past close_date ───────────────────────
    console.log('📋 Creating leads...');
    const allLeadIds = [];

    for (const user of allUsers) {
      for (const tpl of LEAD_TEMPLATES) {
        const value     = rand(tpl.valueMin, tpl.valueMax);
        const closeDate = dateAgo(rand(tpl.daysAgoMin, tpl.daysAgoMax));
        const prob      = tpl.stage === 'closed_won' ? 100
          : tpl.stage === 'closed_lost' ? 0
          : tpl.stage === 'negotiation' ? 85
          : tpl.stage === 'offer' ? 70
          : tpl.stage === 'presentation' ? 50
          : tpl.stage === 'qualification' ? 25 : 10;

        const { rows } = await client.query(`
          INSERT INTO crm_leads
            (tenant_id, company, contact_name, source, stage, value_pln,
             probability, close_date, industry, assigned_to, created_by,
             hot, first_contact_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)
          RETURNING id
        `, [
          TENANT_ID, nextCompany(), contactName(),
          pick(SOURCES), tpl.stage, value, prob, closeDate,
          pick(INDUSTRIES), user.id,
          prob >= 85 || rand(0, 4) === 0,
          dateAgo(rand(tpl.daysAgoMax + 5, tpl.daysAgoMax + 60)),
        ]);
        allLeadIds.push({ id: rows[0].id, userId: user.id });
      }
    }
    console.log(`  ✓ ${allLeadIds.length} leads created`);

    // ── 3. Lead activities ─────────────────────────────────────────────────────
    console.log('📌 Creating lead activities...');
    let actCount = 0;
    for (const { id: leadId, userId } of allLeadIds) {
      const count = rand(2, 4);
      for (let i = 0; i < count; i++) {
        const daysBack = rand(1, 45);
        await client.query(`
          INSERT INTO crm_lead_activities
            (tenant_id, lead_id, type, title, activity_at, status, assigned_to, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
        `, [
          TENANT_ID, leadId, pick(ACTIVITY_TYPES), pick(LEAD_ACT_TITLES),
          tsAgo(daysBack), rand(0, 2) === 0 ? 'open' : 'closed', userId,
        ]);
        actCount++;
      }
    }
    console.log(`  ✓ ${actCount} lead activities`);

    // ── 4. Lead documents ──────────────────────────────────────────────────────
    console.log('📄 Creating lead documents...');
    let docCount = 0;
    for (const { id: leadId, userId } of allLeadIds) {
      const docType = pick(DOC_TYPES);
      const createdDate = dateAgo(rand(3, 60));
      const { rows } = await client.query(`
        INSERT INTO documents
          (tenant_id, doc_number, name, doc_type, status, owner_id, created_by, creation_date)
        VALUES ($1,$2,$3,$4,'signed',$5,$5,$6)
        RETURNING id
      `, [TENANT_ID, `L-SEED-${1000 + docCount}`, `${docType} — ${createdDate}`, docType, userId, createdDate]);
      await client.query(`
        INSERT INTO crm_lead_documents (tenant_id, lead_id, document_id, linked_by, doc_role)
        VALUES ($1,$2,$3,$4,$5)
      `, [TENANT_ID, leadId, rows[0].id, userId, docType]);
      docCount++;
    }
    console.log(`  ✓ ${docCount} lead documents`);

    // ── 5. Partners ────────────────────────────────────────────────────────────
    console.log('🏢 Creating partners...');
    const allPartnerIds = [];
    for (const user of allUsers) {
      for (let i = 0; i < 4; i++) {
        const contractValue = rand(15000, 180000);
        const { rows } = await client.query(`
          INSERT INTO crm_partners
            (tenant_id, company, contact_name, industry, source, status,
             manager_id, created_by, contract_value, contract_signed,
             contract_expires, license_count, active_users, first_contact_date)
          VALUES ($1,$2,$3,$4,$5,'active',$6,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id
        `, [
          TENANT_ID, nextCompany(), contactName(), pick(INDUSTRIES), pick(SOURCES),
          user.id, contractValue,
          dateAgo(rand(30, 400)),
          dateAgo(-rand(30, 365)),  // future expiry = negative daysAgo
          rand(5, 50), rand(3, 45),
          dateAgo(rand(60, 420)),
        ]);
        allPartnerIds.push({ id: rows[0].id, userId: user.id });
      }
    }
    console.log(`  ✓ ${allPartnerIds.length} partners`);

    // ── 6. Partner activities ──────────────────────────────────────────────────
    console.log('📌 Creating partner activities...');
    let partActCount = 0;
    for (const { id: partnerId, userId } of allPartnerIds) {
      const count = rand(2, 3);
      for (let i = 0; i < count; i++) {
        await client.query(`
          INSERT INTO crm_partner_activities
            (tenant_id, partner_id, type, title, activity_at, status, assigned_to, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
        `, [
          TENANT_ID, partnerId, pick(ACTIVITY_TYPES), pick(PART_ACT_TITLES),
          tsAgo(rand(1, 90)), rand(0, 2) === 0 ? 'open' : 'closed', userId,
        ]);
        partActCount++;
      }
    }
    console.log(`  ✓ ${partActCount} partner activities`);

    // ── 7. Partner documents ───────────────────────────────────────────────────
    console.log('📄 Creating partner documents...');
    let partDocCount = 0;
    for (const { id: partnerId, userId } of allPartnerIds) {
      const docType = pick(DOC_TYPES);
      const createdDate = dateAgo(rand(5, 180));
      const { rows } = await client.query(`
        INSERT INTO documents
          (tenant_id, doc_number, name, doc_type, status, owner_id, created_by, creation_date)
        VALUES ($1,$2,$3,'Umowa','signed',$4,$4,$5)
        RETURNING id
      `, [TENANT_ID, `P-SEED-${2000 + partDocCount}`, `Umowa — ${createdDate}`, userId, createdDate]);
      await client.query(`
        INSERT INTO crm_partner_documents (tenant_id, partner_id, document_id, linked_by, doc_role)
        VALUES ($1,$2,$3,$4,$5)
      `, [TENANT_ID, partnerId, rows[0].id, userId, docType]);
      partDocCount++;
    }
    console.log(`  ✓ ${partDocCount} partner documents`);

    // ── 8. Churn + dormant scores ──────────────────────────────────────────────
    console.log('⚠️  Creating churn/dormant scores...');
    const churnDefs = [
      { level: 'critical', scoreMin: 82, scoreMax: 99, daysMin: 130, daysMax: 210 },
      { level: 'high',     scoreMin: 62, scoreMax: 81, daysMin: 91,  daysMax: 129 },
      { level: 'medium',   scoreMin: 42, scoreMax: 61, daysMin: 60,  daysMax: 90  },
      { level: 'low',      scoreMin: 22, scoreMax: 41, daysMin: 30,  daysMax: 59  },
    ];
    let churnCount = 0;
    for (const user of allUsers) {
      const userPartners = allPartnerIds.filter(p => p.userId === user.id);
      for (let i = 0; i < Math.min(churnDefs.length, userPartners.length); i++) {
        const { level, scoreMin, scoreMax, daysMin, daysMax } = churnDefs[i];
        const score     = rand(scoreMin, scoreMax);
        const daysSince = rand(daysMin, daysMax);
        const salesM2   = rand(5000, 50000);
        const salesM1   = Math.round(salesM2 * rand(10, 60) / 100);
        const dropPct   = Math.round((salesM2 - salesM1) / salesM2 * 100);
        await client.query(`
          INSERT INTO crm_partner_scores
            (tenant_id, partner_id, churn_score, churn_level, days_since_order,
             sales_m1, sales_m2, sales_drop_pct, activity_score, growth_score,
             health_score, health_level)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (tenant_id, partner_id) DO UPDATE SET
            churn_score      = EXCLUDED.churn_score,
            churn_level      = EXCLUDED.churn_level,
            days_since_order = EXCLUDED.days_since_order,
            sales_m1         = EXCLUDED.sales_m1,
            sales_m2         = EXCLUDED.sales_m2,
            sales_drop_pct   = EXCLUDED.sales_drop_pct
        `, [
          TENANT_ID, userPartners[i].id, score, level, daysSince,
          salesM1, salesM2, dropPct,
          Math.max(0, 50 - score),
          Math.max(0, Math.round(40 - score / 2)),
          Math.max(0, 60 - score),
          score >= 80 ? 'risk' : score >= 50 ? 'warning' : 'healthy',
        ]);
        churnCount++;
      }
    }
    console.log(`  ✓ ${churnCount} churn/dormant scores (critical/high/medium/low per user)`);

    await client.query('COMMIT');

    const totalLeadValue = allLeadIds.length * (LEAD_TEMPLATES.reduce((s, t) => s + (t.valueMin + t.valueMax) / 2, 0) / LEAD_TEMPLATES.length);

    console.log('\n✅ Seed complete!');
    console.log(`   Tenant:   BRMtree_test1 (${TENANT_ID})`);
    console.log(`   Users:    user1-5 + manager1-5 @ ${DOMAIN_AZURE}   pw: ${PASSWORD}`);
    console.log(`   Leads:    ${allLeadIds.length} (all with value_pln + past close_date)`);
    console.log(`   Partners: ${allPartnerIds.length} + ${churnCount} churn scores`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
