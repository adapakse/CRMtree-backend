'use strict';
/**
 * seed_crmtest1.js
 * Zasila tenanta crmtest1 kopiując dane z CRMtree Gold.
 *
 * Uruchomienie:
 *   node seed_crmtest1.js
 *   DB_PASSWORD=haslo node seed_crmtest1.js
 */

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'crmtree',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'Syrena1@',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const TENANT_NAME  = 'CRMtree Test1';
const TENANT_SLUG  = 'crmtest1';
const DWH_PREFIX   = 'crmtest1';
const GOLD_SLUG    = 'crmtree-gold';
const PASSWORD     = 'Test1234!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

// ── helpers ──────────────────────────────────────────────────────────────────
const mapId = (oldId, map, fallback = null) => {
  if (oldId == null) return fallback;
  return map[oldId] ?? fallback;
};

/**
 * Pobiera listę kolumn tabeli (public schema).
 */
async function getColumns(client, tableName) {
  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return rows.map(r => r.column_name);
}

/**
 * Kopiuje wiersze tabeli według transformacji.
 * transformRow(srcRow) → obiekt kolumn do wstawienia (null = pomiń wiersz)
 * Zwraca tablicę { src, dst } par dla remapowania ID.
 */
async function copyRows(client, tableName, srcRows, transformRow, returning = 'id') {
  const cols = await getColumns(client, tableName);
  const results = [];

  for (const src of srcRows) {
    const data = transformRow(src);
    if (!data) continue;

    // Filtruj tylko istniejące kolumny (guard na różne migracje)
    const keys = Object.keys(data).filter(k => cols.includes(k) && data[k] !== undefined);
    if (!keys.length) continue;

    const vals        = keys.map(k => data[k]);
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

    try {
      const { rows: [dst] } = await client.query(
        `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING ${returning}`,
        vals
      );
      results.push({ src, dst });
    } catch (e) {
      // Pomiń duplikaty i nienaruszalne unikalne constrainty
      if (e.code === '23505') {
        console.warn(`  CONFLICT ${tableName}: ${e.detail?.slice(0, 80)}`);
      } else {
        throw e;
      }
    }
  }
  return results;
}

// ── główna logika ─────────────────────────────────────────────────────────────
async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Gold tenant ──────────────────────────────────────────────────────
    console.log('Szukam Gold tenant...');
    const { rows: [gold] } = await client.query(
      `SELECT id, dwh_schema_prefix FROM tenants WHERE slug = $1`, [GOLD_SLUG]
    );
    if (!gold) throw new Error(`Nie znaleziono tenanta '${GOLD_SLUG}'`);
    const gId         = gold.id;
    const goldPrefix  = gold.dwh_schema_prefix || 'crmtree_gold';
    console.log(`  Gold id=${gId}  dwh_prefix=${goldPrefix}`);

    // ── 2. Tenant crmtest1 ──────────────────────────────────────────────────
    const { rows: existing } = await client.query(
      `SELECT id FROM tenants WHERE slug = $1`, [TENANT_SLUG]
    );
    let tId;
    if (existing.length) {
      tId = existing[0].id;
      await client.query(
        `UPDATE tenants SET name=$2, dwh_schema_prefix=$3, is_active=TRUE WHERE id=$1`,
        [tId, TENANT_NAME, DWH_PREFIX]
      );
      console.log(`Tenant już istnieje: ${tId}`);
    } else {
      const { rows: [t] } = await client.query(`
        INSERT INTO tenants (name, slug, dwh_schema_prefix, is_active)
        VALUES ($1,$2,$3,TRUE) RETURNING id
      `, [TENANT_NAME, TENANT_SLUG, DWH_PREFIX]);
      tId = t.id;
      console.log(`Tenant utworzony: ${tId}`);
    }

    // ── 3. Featury (kopiuj z Gold) ──────────────────────────────────────────
    const { rows: features } = await client.query(
      `SELECT feature, is_enabled FROM tenant_features WHERE tenant_id=$1`, [gId]
    );
    for (const f of features) {
      await client.query(`
        INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled=EXCLUDED.is_enabled
      `, [tId, f.feature, f.is_enabled]);
    }
    console.log(`Features: ${features.length}`);

    // ── 4. AppSettings (kopiuj z Gold) ─────────────────────────────────────
    const { rows: settings } = await client.query(`
      SELECT key, value, label, description, value_type, category
      FROM app_settings WHERE tenant_id=$1
    `, [gId]);
    for (const s of settings) {
      await client.query(`
        INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value
      `, [tId, s.key, s.value, s.label, s.description, s.value_type, s.category]);
    }
    console.log(`Settings: ${settings.length}`);

    // ── 5. Czyszczenie istniejących danych crmtest1 (kolejność FK) ──────────
    console.log('Czyszczenie...');
    const CLEAN_ORDER = [
      'crm_partner_consents', 'crm_lead_consents',
      'crm_partner_scores',
      'crm_sales_budgets',
      'crm_partner_contacts', 'crm_lead_contacts',
      'crm_partner_activities', 'crm_lead_activities',
      'crm_onboarding_tasks',
      'crm_partner_documents', 'crm_lead_documents',
      'crm_leads', 'crm_partners', 'crm_partner_groups',
      'documents',
      'user_group_roles', 'group_profiles',
      'refresh_tokens', 'audit_logs',
      'users',
    ];
    for (const tbl of CLEAN_ORDER) {
      try {
        const { rowCount } = await client.query(`DELETE FROM ${tbl} WHERE tenant_id=$1`, [tId]);
        if (rowCount) console.log(`  ${tbl}: usunięto ${rowCount}`);
      } catch (e) {
        if (!e.message.includes('does not exist') && !e.message.includes('relation')) {
          console.warn(`  ${tbl} WARN: ${e.message}`);
        }
      }
    }

    // ── 6. Użytkownicy ─────────────────────────────────────────────────────
    console.log('Kopiuję użytkowników...');
    const { rows: gUsers } = await client.query(`
      SELECT id, email, first_name, last_name, is_admin, is_active, crm_role
      FROM users
      WHERE tenant_id=$1 AND (is_super_admin IS NULL OR is_super_admin=FALSE)
      ORDER BY is_admin DESC NULLS LAST, crm_role NULLS LAST, first_name
    `, [gId]);

    const userMap = {}; // goldUserId(UUID) → test1UserId(UUID)
    let adminUserId;
    const userEmails = [];

    for (const u of gUsers) {
      const safe  = `${u.first_name||'user'}.${u.last_name||'x'}`
                      .toLowerCase().normalize('NFD')
                      .replace(/[̀-ͯ]/g, '')
                      .replace(/[^a-z0-9.]/g, '');
      const email = `${safe}@crmtest1.local`;
      const { rows: [nu] } = await client.query(`
        INSERT INTO users
          (email, first_name, last_name, is_admin, is_active, crm_role, password_hash, tenant_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
      `, [email, u.first_name, u.last_name, u.is_admin, u.is_active, u.crm_role, PASSWORD_HASH, tId]);
      userMap[u.id] = nu.id;
      if (u.is_admin && !adminUserId) adminUserId = nu.id;
      userEmails.push({ email, role: u.crm_role || (u.is_admin ? 'admin' : 'user') });
    }
    if (!adminUserId) adminUserId = Object.values(userMap)[0];
    console.log(`  Użytkownicy: ${gUsers.length}`);

    // ── 7. Grupy dokumentów ─────────────────────────────────────────────────
    console.log('Kopiuję grupy dokumentów...');
    const { rows: gGrps } = await client.query(
      `SELECT id, name, display_name, is_active FROM group_profiles WHERE tenant_id=$1`, [gId]
    );
    const docGroupMap = {};
    for (const g of gGrps) {
      const { rows: [ng] } = await client.query(`
        INSERT INTO group_profiles (name, display_name, tenant_id, created_by, is_active)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [g.name, g.display_name, tId, adminUserId, g.is_active]);
      docGroupMap[g.id] = ng.id;
    }
    // user_group_roles
    const { rows: ugrs } = await client.query(
      `SELECT user_id, group_id, access_level FROM user_group_roles WHERE tenant_id=$1`, [gId]
    );
    for (const r of ugrs) {
      const nu = mapId(r.user_id, userMap, adminUserId);
      const ng = mapId(r.group_id, docGroupMap);
      if (!nu || !ng) continue;
      await client.query(`
        INSERT INTO user_group_roles (user_id, group_id, access_level, tenant_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
      `, [nu, ng, r.access_level, tId]);
    }
    console.log(`  Grupy doc: ${gGrps.length}`);

    // ── 8. Dokumenty ───────────────────────────────────────────────────────
    console.log('Kopiuję dokumenty...');
    const { rows: gDocs } = await client.query(
      `SELECT * FROM documents WHERE tenant_id=$1`, [gId]
    );
    const docMap = {}; // goldDocUUID → test1DocUUID
    let docNum = 0;
    let seqRow;
    try {
      const { rows: [r] } = await client.query(
        `SELECT COALESCE(MAX(last_n),0) AS n FROM doc_number_seq WHERE tenant_id=$1`, [tId]
      );
      seqRow = r;
    } catch (_) { /* tabela może nie istnieć */ }
    docNum = parseInt(seqRow?.n) || 0;

    const docCols = await getColumns(client, 'documents');
    for (const d of gDocs) {
      docNum++;
      const data = {
        doc_number:       `T1-${String(docNum).padStart(4,'0')}`,
        name:             d.name,
        doc_type:         d.doc_type,
        status:           d.status,
        gdpr_type:        d.gdpr_type,
        group_id:         mapId(d.group_id, docGroupMap),
        owner_id:         mapId(d.owner_id, userMap, adminUserId),
        creation_date:    d.creation_date,
        expiration_date:  d.expiration_date,
        signing_date:     d.signing_date,
        contract_subject: d.contract_subject,
        entity1:          d.entity1,
        entity2:          d.entity2,
        entity2_nip:      d.entity2_nip,
        entity2_country:  d.entity2_country,
        contact_name:     d.contact_name,
        contact_email:    d.contact_email,
        contact_phone:    d.contact_phone,
        created_by:       mapId(d.created_by, userMap, adminUserId),
        updated_by:       mapId(d.updated_by, userMap, null),
        tenant_id:        tId,
      };
      // Dynamicznie dodaj kolumny których nie znam (poza id i tenant_id)
      for (const col of docCols) {
        if (col !== 'id' && col !== 'tenant_id' && !(col in data) && d[col] !== undefined) {
          data[col] = d[col];
        }
      }
      const keys = Object.keys(data).filter(k => docCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      const { rows: [nd] } = await client.query(
        `INSERT INTO documents (${keys.join(', ')}) VALUES (${ph}) RETURNING id`, vals
      );
      docMap[d.id] = nd.id;
    }
    try {
      await client.query(`
        INSERT INTO doc_number_seq (tenant_id, year, last_n) VALUES ($1,2026,$2)
        ON CONFLICT (tenant_id, year) DO UPDATE SET last_n=$2
      `, [tId, docNum]);
    } catch (_) { /* tabela może nie istnieć */ }
    console.log(`  Dokumenty: ${gDocs.length}`);

    // ── 9. Grupy partnerów CRM ─────────────────────────────────────────────
    console.log('Kopiuję grupy partnerów...');
    const { rows: gCrmGrps } = await client.query(
      `SELECT id, name, industry, description, manager_id FROM crm_partner_groups WHERE tenant_id=$1`, [gId]
    );
    const crmGroupMap = {}; // goldIntId → test1IntId
    for (const g of gCrmGrps) {
      const { rows: [ng] } = await client.query(`
        INSERT INTO crm_partner_groups (name, industry, description, manager_id, created_by, tenant_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [g.name, g.industry, g.description,
          mapId(g.manager_id, userMap, adminUserId), adminUserId, tId]);
      crmGroupMap[g.id] = ng.id;
    }
    console.log(`  Grupy CRM: ${gCrmGrps.length}`);

    // ── 10. Leady (najpierw, żeby mieć leadMap dla partnerów) ──────────────
    console.log('Kopiuję leady...');
    const { rows: gLeads } = await client.query(
      `SELECT * FROM crm_leads WHERE tenant_id=$1`, [gId]
    );
    const leadMap = {}; // goldLeadId(int) → test1LeadId(int)
    const leadCols = await getColumns(client, 'crm_leads');

    for (const l of gLeads) {
      const data = {
        company:               l.company,
        nip:                   l.nip,
        contact_name:          l.contact_name,
        contact_title:         l.contact_title,
        email:                 l.email,
        phone:                 l.phone,
        source:                l.source,
        stage:                 l.stage,
        value_pln:             l.value_pln,
        probability:           l.probability,
        close_date:            l.close_date,
        industry:              l.industry,
        assigned_to:           mapId(l.assigned_to, userMap),
        tags:                  l.tags,
        notes:                 l.notes,
        hot:                   l.hot,
        lost_reason:           l.lost_reason,
        annual_turnover_currency: l.annual_turnover_currency,
        online_pct:            l.online_pct,
        website:               l.website,
        logo_url:              l.logo_url,
        agent_name:            l.agent_name,
        agent_email:           l.agent_email,
        agent_phone:           l.agent_phone,
        first_contact_date:    l.first_contact_date,
        converted_at:          l.converted_at,
        converted_partner_id:  null, // uzupełnimy po skopiowaniu partnerów
        created_by:            mapId(l.created_by, userMap, adminUserId),
        tenant_id:             tId,
      };
      // Pozostałe kolumny (dynamicznie)
      for (const col of leadCols) {
        if (!['id','tenant_id','converted_partner_id'].includes(col) && !(col in data) && l[col] !== undefined) {
          data[col] = l[col];
        }
      }
      const keys = Object.keys(data).filter(k => leadCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      const { rows: [nl] } = await client.query(
        `INSERT INTO crm_leads (${keys.join(', ')}) VALUES (${ph}) RETURNING id`, vals
      );
      leadMap[l.id] = nl.id;
    }
    console.log(`  Leady: ${gLeads.length}`);

    // ── 11. Partnerzy ───────────────────────────────────────────────────────
    console.log('Kopiuję partnerów...');
    const { rows: gPartners } = await client.query(
      `SELECT * FROM crm_partners WHERE tenant_id=$1`, [gId]
    );
    const partnerMap = {}; // goldUUID → test1UUID
    const partnerCols = await getColumns(client, 'crm_partners');

    for (const p of gPartners) {
      const data = {
        company:               p.company,
        nip:                   p.nip,
        status:                p.status,
        group_id:              mapId(p.group_id, crmGroupMap),
        lead_id:               mapId(p.lead_id, leadMap),
        manager_id:            mapId(p.manager_id, userMap, adminUserId),
        contract_signed:       p.contract_signed,
        contract_expires:      p.contract_expires,
        contract_value:        p.contract_value,
        annual_turnover_currency: p.annual_turnover_currency,
        online_pct:            p.online_pct,
        onboarding_step:       p.onboarding_step,
        dwh_partner_id:        null, // globalny UNIQUE constraint — nie kopiuj z Gold
        tags:                  p.tags,
        notes:                 p.notes,
        industry:              p.industry,
        source:                p.source,
        first_contact_date:    p.first_contact_date,
        website:               p.website,
        logo_url:              p.logo_url,
        contact_name:          p.contact_name,
        contact_title:         p.contact_title,
        email:                 p.email,
        phone:                 p.phone,
        billing_contact_name:  p.billing_contact_name,
        billing_contact_title: p.billing_contact_title,
        billing_email:         p.billing_email,
        billing_phone:         p.billing_phone,
        credit_limit_value:    p.credit_limit_value,
        credit_limit_currency: p.credit_limit_currency,
        deposit_value:         p.deposit_value,
        deposit_currency:      p.deposit_currency,
        deposit_date_in:       p.deposit_date_in,
        deposit_date_out:      p.deposit_date_out,
        commission_value:      p.commission_value,
        commission_basis:      p.commission_basis,
        subdomain:             p.subdomain,
        language:              p.language,
        partner_currency:      p.partner_currency,
        country:               p.country,
        billing_address:       p.billing_address,
        billing_zip:           p.billing_zip,
        billing_city:          p.billing_city,
        billing_country:       p.billing_country,
        billing_email_address: p.billing_email_address,
        admin_first_name:      p.admin_first_name,
        admin_last_name:       p.admin_last_name,
        admin_email:           p.admin_email,
        agent_name:            p.agent_name,
        agent_email:           p.agent_email,
        agent_phone:           p.agent_phone,
        created_by:            adminUserId,
        tenant_id:             tId,
      };
      // Dynamicznie dodaj nieznane kolumny (np. crm_id jeśli istnieje)
      for (const col of partnerCols) {
        if (!['id','tenant_id'].includes(col) && !(col in data) && p[col] !== undefined) {
          data[col] = p[col];
        }
      }
      const keys = Object.keys(data).filter(k => partnerCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      const { rows: [np] } = await client.query(
        `INSERT INTO crm_partners (${keys.join(', ')}) VALUES (${ph}) RETURNING id`, vals
      );
      partnerMap[p.id] = np.id;
    }
    console.log(`  Partnerzy: ${gPartners.length}`);

    // ── 11b. Zaktualizuj converted_partner_id w leadach ────────────────────
    for (const l of gLeads) {
      if (!l.converted_partner_id) continue;
      const newPid = mapId(l.converted_partner_id, partnerMap);
      const newLid = leadMap[l.id];
      if (!newPid || !newLid) continue;
      await client.query(
        `UPDATE crm_leads SET converted_partner_id=$1 WHERE id=$2 AND tenant_id=$3`,
        [newPid, newLid, tId]
      );
    }

    // ── 12. Aktywności partnerów ────────────────────────────────────────────
    console.log('Kopiuję aktywności partnerów...');
    const { rows: gPActs } = await client.query(
      `SELECT * FROM crm_partner_activities WHERE tenant_id=$1`, [gId]
    );
    const pActCols = await getColumns(client, 'crm_partner_activities');
    let pActCount = 0;
    for (const a of gPActs) {
      const newPid = mapId(a.partner_id, partnerMap);
      if (!newPid) continue;
      const data = {
        partner_id:    newPid,
        type:          a.type,
        title:         a.title,
        body:          a.body,
        activity_at:   a.activity_at,
        duration_min:  a.duration_min,
        participants:  a.participants,
        status:        a.status,
        close_comment: a.close_comment,
        assigned_to:   mapId(a.assigned_to, userMap),
        created_by:    mapId(a.created_by, userMap, adminUserId),
        tenant_id:     tId,
      };
      for (const col of pActCols) {
        if (!['id','tenant_id','partner_id'].includes(col) && !(col in data) && a[col] !== undefined) {
          data[col] = a[col];
        }
      }
      const keys = Object.keys(data).filter(k => pActCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      await client.query(`INSERT INTO crm_partner_activities (${keys.join(', ')}) VALUES (${ph})`, vals);
      pActCount++;
    }
    console.log(`  Aktywności partnerów: ${pActCount}`);

    // ── 13. Zadania onboarding ──────────────────────────────────────────────
    console.log('Kopiuję zadania onboarding...');
    const { rows: gTasks } = await client.query(
      `SELECT * FROM crm_onboarding_tasks WHERE tenant_id=$1`, [gId]
    );
    const taskCols = await getColumns(client, 'crm_onboarding_tasks');
    let taskCount = 0;
    for (const t of gTasks) {
      const newPid = mapId(t.partner_id, partnerMap);
      if (!newPid) continue;
      const data = {
        partner_id: newPid,
        step:       t.step,
        title:      t.title,
        body:       t.body,
        type:       t.type,
        assigned_to: mapId(t.assigned_to, userMap),
        due_date:   t.due_date,
        due_time:   t.due_time,
        done:       t.done,
        done_at:    t.done_at,
        done_by:    mapId(t.done_by, userMap),
        created_by: mapId(t.created_by, userMap, adminUserId),
        tenant_id:  tId,
      };
      for (const col of taskCols) {
        if (!['id','tenant_id','partner_id'].includes(col) && !(col in data) && t[col] !== undefined) {
          data[col] = t[col];
        }
      }
      const keys = Object.keys(data).filter(k => taskCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      await client.query(`INSERT INTO crm_onboarding_tasks (${keys.join(', ')}) VALUES (${ph})`, vals);
      taskCount++;
    }
    console.log(`  Zadania onboarding: ${taskCount}`);

    // ── 14. Powiązania partner ↔ dokument ───────────────────────────────────
    const { rows: gPDocs } = await client.query(
      `SELECT * FROM crm_partner_documents WHERE tenant_id=$1`, [gId]
    );
    let pdCount = 0;
    for (const pd of gPDocs) {
      const np = mapId(pd.partner_id, partnerMap);
      const nd = mapId(pd.document_id, docMap);
      if (!np || !nd) continue;
      try {
        await client.query(`
          INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by, tenant_id)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
        `, [np, nd, pd.doc_role, mapId(pd.linked_by, userMap, adminUserId), tId]);
        pdCount++;
      } catch (_) {}
    }
    console.log(`  Linki partner↔dok: ${pdCount}`);

    // ── 15. Aktywności leadów ───────────────────────────────────────────────
    console.log('Kopiuję aktywności leadów...');
    const { rows: gLActs } = await client.query(
      `SELECT * FROM crm_lead_activities WHERE tenant_id=$1`, [gId]
    );
    const lActCols = await getColumns(client, 'crm_lead_activities');
    let lActCount = 0;
    for (const a of gLActs) {
      const newLid = mapId(a.lead_id, leadMap);
      if (!newLid) continue;
      const data = {
        lead_id:       newLid,
        type:          a.type,
        title:         a.title,
        body:          a.body,
        activity_at:   a.activity_at,
        duration_min:  a.duration_min,
        status:        a.status,
        close_comment: a.close_comment,
        assigned_to:   mapId(a.assigned_to, userMap),
        created_by:    mapId(a.created_by, userMap, adminUserId),
        tenant_id:     tId,
      };
      for (const col of lActCols) {
        if (!['id','tenant_id','lead_id'].includes(col) && !(col in data) && a[col] !== undefined) {
          data[col] = a[col];
        }
      }
      const keys = Object.keys(data).filter(k => lActCols.includes(k) && data[k] !== undefined);
      const vals = keys.map(k => data[k]);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      await client.query(`INSERT INTO crm_lead_activities (${keys.join(', ')}) VALUES (${ph})`, vals);
      lActCount++;
    }
    console.log(`  Aktywności leadów: ${lActCount}`);

    // ── 16. Dodatkowe kontakty leadów (tabela może nie istnieć) ────────────
    try {
      const { rows: gLC } = await client.query(
        `SELECT * FROM crm_lead_contacts WHERE tenant_id=$1`, [gId]
      );
      const lcCols = await getColumns(client, 'crm_lead_contacts');
      let lcCount = 0;
      for (const c of gLC) {
        const nl = mapId(c.lead_id, leadMap);
        if (!nl) continue;
        const data = {
          lead_id:       nl,
          contact_name:  c.contact_name,
          contact_title: c.contact_title,
          email:         c.email,
          phone:         c.phone,
          created_by:    mapId(c.created_by, userMap, adminUserId),
          tenant_id:     tId,
        };
        const keys = Object.keys(data).filter(k => lcCols.includes(k) && data[k] !== undefined);
        const vals = keys.map(k => data[k]);
        const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
        await client.query(`INSERT INTO crm_lead_contacts (${keys.join(', ')}) VALUES (${ph})`, vals);
        lcCount++;
      }
      if (lcCount) console.log(`  Kontakty leadów: ${lcCount}`);
    } catch (e) {
      if (!e.message.includes('does not exist') && !e.message.includes('relation')) throw e;
    }

    // ── 17. Zgody leadów ────────────────────────────────────────────────────
    const { rows: gLC2 } = await client.query(
      `SELECT * FROM crm_lead_consents WHERE tenant_id=$1`, [gId]
    );
    let lconsCount = 0;
    for (const c of gLC2) {
      const nl = mapId(c.lead_id, leadMap);
      if (!nl) continue;
      await client.query(`
        INSERT INTO crm_lead_consents (tenant_id, lead_id, consent_key, value, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (lead_id, consent_key) DO UPDATE SET value=EXCLUDED.value
      `, [tId, nl, c.consent_key, c.value, mapId(c.updated_by, userMap), c.updated_at]);
      lconsCount++;
    }
    console.log(`  Zgody leadów: ${lconsCount}`);

    // ── 18. Zgody partnerów ─────────────────────────────────────────────────
    const { rows: gPC } = await client.query(
      `SELECT * FROM crm_partner_consents WHERE tenant_id=$1`, [gId]
    );
    let pconsCount = 0;
    for (const c of gPC) {
      const np = mapId(c.partner_id, partnerMap);
      if (!np) continue;
      await client.query(`
        INSERT INTO crm_partner_consents (tenant_id, partner_id, consent_key, value, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (partner_id, consent_key) DO UPDATE SET value=EXCLUDED.value
      `, [tId, np, c.consent_key, c.value, mapId(c.updated_by, userMap), c.updated_at]);
      pconsCount++;
    }
    console.log(`  Zgody partnerów: ${pconsCount}`);

    // ── 19. Budżety sprzedażowe ─────────────────────────────────────────────
    const { rows: gBudgets } = await client.query(
      `SELECT * FROM crm_sales_budgets WHERE tenant_id=$1`, [gId]
    );
    let budgetCount = 0;
    for (const b of gBudgets) {
      const nu = mapId(b.user_id, userMap, adminUserId);
      await client.query(`
        INSERT INTO crm_sales_budgets
          (user_id, year, period_type, period_number, amount, currency, created_by, tenant_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING
      `, [nu, b.year, b.period_type, b.period_number, b.amount, b.currency,
          mapId(b.created_by, userMap, adminUserId), tId]);
      budgetCount++;
    }
    console.log(`  Budżety: ${budgetCount}`);

    // ── 20. DWH tables ─────────────────────────────────────────────────────
    console.log('Tworzę tabele DWH...');
    await client.query(`DROP TABLE IF EXISTS dwh.${DWH_PREFIX}_sales`);
    await client.query(`DROP TABLE IF EXISTS dwh.${DWH_PREFIX}_partner`);
    await client.query(`
      CREATE TABLE dwh.${DWH_PREFIX}_partner (LIKE dwh.${goldPrefix}_partner INCLUDING ALL)
    `);
    await client.query(`
      CREATE TABLE dwh.${DWH_PREFIX}_sales (LIKE dwh.${goldPrefix}_sales INCLUDING ALL)
    `);

    const serializeVal = v =>
      v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)
        ? JSON.stringify(v)
        : v;

    // Kopiuj DWH partnerów (zachowaj partner_id)
    const { rows: gdwh } = await client.query(`SELECT * FROM dwh.${goldPrefix}_partner`);
    let dwhPCount = 0;
    for (const p of gdwh) {
      const cols = Object.keys(p);
      const vals = Object.values(p).map(serializeVal);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      await client.query(
        `INSERT INTO dwh.${DWH_PREFIX}_partner (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
        vals
      );
      dwhPCount++;
    }

    // Kopiuj DWH sprzedaż (pomiń id — BIGSERIAL)
    const { rows: gdwhs } = await client.query(`SELECT * FROM dwh.${goldPrefix}_sales`);
    let dwhSCount = 0;
    for (const s of gdwhs) {
      const { id, ...rest } = s;
      const cols = Object.keys(rest);
      const vals = Object.values(rest).map(serializeVal);
      const ph   = vals.map((_,i) => `$${i+1}`).join(', ');
      await client.query(
        `INSERT INTO dwh.${DWH_PREFIX}_sales (${cols.join(', ')}) VALUES (${ph})`,
        vals
      );
      dwhSCount++;
    }
    console.log(`  DWH partnerzy: ${dwhPCount}, DWH sprzedaż: ${dwhSCount} wierszy`);

    // ── COMMIT ──────────────────────────────────────────────────────────────
    await client.query('COMMIT');

    console.log('\n✅ Seed crmtest1 zakończony pomyślnie!');
    console.log('─'.repeat(60));
    console.log(`Tenant:    ${TENANT_NAME} (${TENANT_SLUG})`);
    console.log(`Tenant ID: ${tId}`);
    console.log(`\nUżytkownicy (hasło: ${PASSWORD}):`);
    userEmails.forEach(u => console.log(`  ${u.email}  [${u.role}]`));
    console.log(`\nDane:  ${gPartners.length} partnerów, ${gLeads.length} leadów`);
    console.log(`DWH:   ${dwhPCount} partnerów, ${dwhSCount} wierszy sprzedaży`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
