'use strict';
/**
 * Demo data refresh — seed script for CRM presentation.
 *
 * Creates an additive batch each run:
 *   - 7 new leads  (June 2026, mixed stages)
 *   - 4 new partners (3 onboarding, 1 active)
 *   - 5 new documents (linked to new leads/partners)
 *   - 2–3 activities per existing lead (last 15) + new leads
 *   - 2–3 activities per existing partner (last 15) + new partners
 *   - Onboarding tasks for new partners + existing onboarding partners
 *   - Workflow tasks for all touched documents
 *
 * Run: node src/db/seed_demo_refresh.js [--tenant crmtree-gold]
 * Safe to run multiple times.
 */

require('dotenv').config();
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env.local'),
  override: true,
});

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'crmtree',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const pick    = arr => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const futureDate = days => {
  const d = new Date('2026-06-17');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
};

// ── Demo content ──────────────────────────────────────────────────────────────

const LEAD_COMPANIES = [
  'Eurosport Travel Group Sp. z o.o.',
  'TechCorp Solutions S.A.',
  'BlueSky Consulting Sp. z o.o.',
  'Meridian Business Travel S.A.',
  'Nexus Corporate Services Sp. z o.o.',
  'Orbit Finance Group S.A.',
  'PKP Korporacyjne Sp. z o.o.',
];

const PARTNER_COMPANIES = [
  'VentureWorks Polska Sp. z o.o.',
  'AlphaRoute Business Travel S.A.',
  'Sigma Logistics Partners Sp. z o.o.',
  'Prime Mobility Solutions S.A.',
];

const PARTNER_SETUP = [
  { status: 'onboarding', step: 0 },
  { status: 'onboarding', step: 0 },
  { status: 'onboarding', step: 1 },
  { status: 'active',     step: 3 },
];

const INDUSTRIES = [
  'IT / Software', 'Finanse i bankowość', 'Produkcja przemysłowa',
  'Usługi profesjonalne', 'Transport i logistyka', 'Turystyka korporacyjna',
];

const CONTACT_NAMES = [
  'Anna Kowalska', 'Piotr Wiśniewski', 'Katarzyna Wójcik', 'Marek Kowalczyk',
  'Joanna Kamińska', 'Tomasz Lewandowski', 'Agnieszka Zielińska', 'Michał Szymański',
];

const TITLES = [
  'Dyrektor ds. Zakupów', 'CFO', 'CEO', 'Kierownik ds. Podróży',
  'Office Manager', 'Travel Manager', 'Dyrektor Operacyjny',
];

const SOURCES = ['direct', 'recommendation', 'website', 'partner', 'conference'];

const LEAD_STAGES_SEQ  = ['new', 'new', 'qualification', 'qualification', 'presentation', 'offer', 'negotiation'];
const STAGE_PROB       = { new: 10, qualification: 25, presentation: 40, offer: 60, negotiation: 75 };

const LEAD_ACTIVITIES = [
  { type: 'call',     title: 'Rozmowa telefoniczna — wstępna kwalifikacja',  body: 'Omówiono potrzeby klienta w zakresie zarządzania podróżami. Klient zainteresowany ofertą premium. Umówiono następną rozmowę.' },
  { type: 'email',    title: 'Wysłanie materiałów ofertowych',               body: 'Przesłano prezentację produktu oraz cennik. Klient potwierdził otrzymanie i poinformował o analizie w ciągu 5 dni roboczych.' },
  { type: 'meeting',  title: 'Demo platformy — prezentacja możliwości',      body: 'Zaprezentowano system. Pytania o integrację z SAP i raportowanie. Umówiono pilotaż na 30 dni.' },
  { type: 'note',     title: 'Informacja z LinkedIn — aktywność klienta',    body: 'Klient aktywnie szuka rozwiązań TMC. Ogłoszenie o przetargu na LinkedIn.' },
  { type: 'email',    title: 'Follow-up po spotkaniu',                       body: 'Wysłano podsumowanie spotkania oraz propozycję pilotażu. Case study z branży finansowej.' },
  { type: 'call',     title: 'Rozmowa z dyrektorem finansowym',              body: 'Rozmowa CFO o budżecie 2026/2027. Decyzja zakupowa planowana na Q3.' },
  { type: 'meeting',  title: 'Prezentacja oferty finałowej',                 body: 'Spotkanie z zarządem. Omówiono warunki SLA i harmonogram wdrożenia. Klient prosi o czas.' },
  { type: 'doc_sent', title: 'Wysłanie projektu umowy',                      body: 'Przesłano projekt umowy głównej i SLA. Uwagi prawne — termin 5 dni roboczych.' },
];

const PARTNER_ACTIVITIES = [
  { type: 'call',     title: 'Monthly check-in z opiekunem klienta',         body: 'Wyniki za ostatni miesiąc. Wolumen transakcji wzrósł o 12%. Brak zgłoszeń technicznych.' },
  { type: 'email',    title: 'Newsletter — nowości platformy czerwiec 2026', body: 'Nowe funkcje: integracja Google Calendar, eksport PDF raportów, moduł onboardingu v2.' },
  { type: 'meeting',  title: 'QBR — kwartalny przegląd biznesowy Q2 2026',  body: 'Wyniki Q2, plany Q3. Partner zainteresowany modułem onboardingu dla nowych użytkowników.' },
  { type: 'training', title: 'Szkolenie nowych pracowników partnera',        body: 'Szkolenie 8 pracowników: moduły rezerwacji, raportów, faktur. Ocena szkolenia: 4.7/5.' },
  { type: 'qbr',     title: 'Strategic Business Review — czerwiec 2026',     body: 'Przegląd strategiczny. Partner planuje rozszerzenie o 50 licencji od Q4 2026.' },
  { type: 'note',    title: 'Informacja rynkowa od partnera',                body: 'Partner poinformował o przetargu TMC u konkurencji. Ryzyko churn niskie — długoterminowa współpraca.' },
  { type: 'call',    title: 'Wsparcie techniczne — konfiguracja polityk',    body: 'Konfiguracja polityk podróżniczych: limity klasy lotniczej, preferowani dostawcy hotelowi.' },
];

const ONBOARDING_TEMPLATES = {
  0: [
    { title: 'Podpisanie umowy głównej',         type: 'task' },
    { title: 'Weryfikacja NIP i dokumentów KRS', type: 'task' },
    { title: 'Kick-off call z Account Manager',  type: 'call' },
  ],
  1: [
    { title: 'Konfiguracja kont użytkowników',    type: 'task' },
    { title: 'Ustawienie polityk podróżniczych',  type: 'task' },
    { title: 'Szkolenie administratora systemu',  type: 'training' },
  ],
  2: [
    { title: 'Szkolenie użytkowników końcowych',  type: 'training' },
    { title: 'Test integracji z systemem HR',     type: 'task' },
    { title: 'Pierwsze rezerwacje pilotażowe',    type: 'task' },
  ],
  3: [
    { title: 'Potwierdzenie zakończenia wdrożenia', type: 'task' },
    { title: 'Przekazanie do działu obsługi klienta', type: 'email' },
  ],
};

const DOCS = [
  { name: 'Umowa partnerska — VentureWorks Polska',       doc_type: 'partner_agreement',     status: 'being_edited' },
  { name: 'NDA — AlphaRoute Business Travel',             doc_type: 'nda',                   status: 'new' },
  { name: 'Umowa IT — Sigma Logistics Partners',          doc_type: 'it_supplier_agreement', status: 'new' },
  { name: 'Umowa partnerska — Prime Mobility Solutions',  doc_type: 'partner_agreement',     status: 'signed' },
  { name: 'Umowa operatorska — Meridian Business Travel', doc_type: 'operator_agreement',    status: 'being_edited' },
];

const WF_TASK_TYPES = ['read', 'approve', 'sign', 'edit'];
const WF_MESSAGES = {
  read:    'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.',
  approve: 'Dokument wymaga zatwierdzenia przed wysłaniem do klienta.',
  sign:    'Dokument gotowy do podpisu — proszę o finalizację.',
  edit:    'Wymagana aktualizacja w sekcji warunków płatności.',
};

const MEETING_TYPES = new Set(['meeting', 'qbr', 'training']);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const tenantSlug = (() => {
    const idx = process.argv.indexOf('--tenant');
    return idx !== -1 ? process.argv[idx + 1] : 'crmtree-gold';
  })();

  const client = await pool.connect();
  try {
    // ── Lookup context ────────────────────────────────────────────────────────
    const { rows: [tenant] } = await client.query(
      'SELECT id FROM tenants WHERE slug = $1', [tenantSlug]
    );
    if (!tenant) throw new Error(`Tenant '${tenantSlug}' not found`);
    const tid = tenant.id;

    const { rows: users } = await client.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND is_active = true ORDER BY created_at LIMIT 20',
      [tid]
    );
    if (!users.length) throw new Error('No active users found');
    const uids = users.map(u => u.id);

    const { rows: groups } = await client.query(
      'SELECT id FROM group_profiles WHERE tenant_id = $1 AND is_active = true', [tid]
    );
    const gids = groups.map(g => g.id);

    const { rows: existLeads } = await client.query(
      'SELECT id FROM crm_leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15', [tid]
    );
    const { rows: existPartners } = await client.query(
      "SELECT id, onboarding_step, status FROM crm_partners WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 15",
      [tid]
    );
    const { rows: existDocs } = await client.query(
      'SELECT id FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10',
      [tid]
    );

    const runTag   = `DEMO-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const docNumPfx = `DOC-DEMO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const counts = { leads: 0, partners: 0, docs: 0, leadActs: 0, partnerActs: 0, onboardTasks: 0, wfTasks: 0 };

    console.log(`Tenant: ${tenantSlug}  Users: ${uids.length}  Run: ${runTag}`);
    console.log(`Existing — leads: ${existLeads.length}  partners: ${existPartners.length}  docs: ${existDocs.length}`);

    await client.query('BEGIN');

    // ── 1. New leads ──────────────────────────────────────────────────────────
    const newLeadIds = [];
    for (let i = 0; i < LEAD_COMPANIES.length; i++) {
      const stage   = LEAD_STAGES_SEQ[i];
      const company = LEAD_COMPANIES[i];
      const uid     = pick(uids);
      const { rows: [row] } = await client.query(
        `INSERT INTO crm_leads
           (company, contact_name, contact_title, email, phone, source, stage,
            value_pln, probability, close_date, industry, assigned_to, hot,
            notes, created_by, created_at, updated_at, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 NOW() - ($16 || ' days')::interval, NOW(), $17)
         RETURNING id`,
        [
          company,
          pick(CONTACT_NAMES),
          pick(TITLES),
          `kontakt@${company.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 14)}.pl`,
          `+48 ${randInt(500, 799)} ${randInt(100, 999)} ${randInt(100, 999)}`,
          pick(SOURCES),
          stage,
          randInt(8, 50) * 10000,
          STAGE_PROB[stage],
          futureDate(randInt(30, 120)),
          pick(INDUSTRIES),
          uid,
          i < 2,
          `[${runTag}] Lead demo.`,
          uid,
          randInt(1, 16),
          tid,
        ]
      );
      newLeadIds.push(row.id);
      counts.leads++;
    }
    console.log(`  ✓ Created ${counts.leads} new leads`);

    // ── 2. New partners ───────────────────────────────────────────────────────
    const newPartnerIds = [];
    for (let i = 0; i < PARTNER_COMPANIES.length; i++) {
      const { status, step } = PARTNER_SETUP[i];
      const company = PARTNER_COMPANIES[i];
      const uid     = pick(uids);
      const { rows: [row] } = await client.query(
        `INSERT INTO crm_partners
           (company, nip, address, contact_name, contact_title, email, phone,
            industry, manager_id, status, onboarding_step, notes,
            created_by, created_at, updated_at, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 NOW() - ($14 || ' days')::interval, NOW(), $15)
         RETURNING id`,
        [
          company,
          String(randInt(1000000000, 9999999999)),
          `ul. ${pick(['Marszałkowska', 'Nowy Świat', 'Puławska', 'Mokotowska', 'Sienna'])} ${randInt(1, 99)}, Warszawa`,
          pick(CONTACT_NAMES),
          pick(['Dyrektor Operacyjny', 'Office Manager', 'Travel Manager', 'Koordynator ds. Podróży']),
          `biuro@${company.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 14)}.pl`,
          `+48 ${randInt(200, 299)} ${randInt(100, 999)} ${randInt(100, 999)}`,
          pick(INDUSTRIES),
          uid,
          status,
          step,
          `[${runTag}] Partner demo.`,
          uid,
          randInt(1, 20),
          tid,
        ]
      );
      newPartnerIds.push(row.id);
      counts.partners++;
    }
    console.log(`  ✓ Created ${counts.partners} new partners`);

    // ── 3. New documents ──────────────────────────────────────────────────────
    const newDocIds = [];
    for (let i = 0; i < DOCS.length; i++) {
      const { name, doc_type, status } = DOCS[i];
      const docId  = uuidv4();
      const docNum = `${docNumPfx}-${String(i + 1).padStart(2, '0')}`;
      const uid    = pick(uids);
      const gid    = gids.length ? pick(gids) : null;

      await client.query(
        `INSERT INTO documents
           (id, doc_number, name, doc_type, entities, owner_id,
            group_id, gdpr_type, status, creation_date,
            blob_path, blob_name, blob_size_bytes, mime_type,
            country, created_by, created_at, updated_at, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'no_gdpr',$8,
                 CURRENT_DATE - ($9 || ' days')::interval,
                 $10,$11,0,'application/pdf','Polska',
                 $12, NOW() - ($9 || ' days')::interval, NOW(), $13)`,
        [
          docId, docNum, name, doc_type,
          [name.split('—')[0].trim()],
          uid, gid, status, randInt(1, 14),
          `demo/${docId}/placeholder.pdf`,
          `${docNum.toLowerCase().replace(/-/g, '_')}.pdf`,
          uid, tid,
        ]
      );
      newDocIds.push(docId);
      counts.docs++;

      if (newPartnerIds[i]) {
        await client.query(
          `INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by, tenant_id)
           VALUES ($1,$2,'main_contract',$3,$4)
           ON CONFLICT (partner_id, document_id) DO NOTHING`,
          [newPartnerIds[i], docId, uid, tid]
        );
      }
      if (newLeadIds[i]) {
        await client.query(
          `INSERT INTO crm_lead_documents (lead_id, document_id, doc_role, linked_by, tenant_id)
           VALUES ($1,$2,'offer_document',$3,$4)
           ON CONFLICT (lead_id, document_id) DO NOTHING`,
          [newLeadIds[i], docId, uid, tid]
        );
      }
    }
    console.log(`  ✓ Created ${counts.docs} new documents`);

    // ── 4. Lead activities ────────────────────────────────────────────────────
    const allLeads = [...existLeads, ...newLeadIds.map(id => ({ id }))];
    for (const lead of allLeads) {
      const n = randInt(2, 3);
      for (let a = 0; a < n; a++) {
        const act = pick(LEAD_ACTIVITIES);
        const uid = pick(uids);
        await client.query(
          `INSERT INTO crm_lead_activities
             (lead_id, type, title, body, activity_at, status, assigned_to,
              created_by, created_at, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`,
          [
            lead.id, act.type, act.title, act.body,
            act.type === 'meeting'
              ? `2026-06-${String(randInt(1, 28)).padStart(2, '0')} ${String(randInt(9, 17)).padStart(2, '0')}:00:00`
              : null,
            pick(['new', 'open', 'closed']),
            uid, uid, tid,
          ]
        );
        counts.leadActs++;
      }
    }
    console.log(`  ✓ Added ${counts.leadActs} lead activities (${allLeads.length} leads)`);

    // ── 5. Partner activities ─────────────────────────────────────────────────
    const allPartners = [...existPartners, ...newPartnerIds.map(id => ({ id }))];
    for (const partner of allPartners) {
      const n = randInt(2, 3);
      for (let a = 0; a < n; a++) {
        const act = pick(PARTNER_ACTIVITIES);
        const uid = pick(uids);
        await client.query(
          `INSERT INTO crm_partner_activities
             (partner_id, type, title, body, activity_at, status, assigned_to,
              created_by, created_at, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)`,
          [
            partner.id, act.type, act.title, act.body,
            MEETING_TYPES.has(act.type)
              ? `2026-06-${String(randInt(1, 28)).padStart(2, '0')} ${String(randInt(9, 17)).padStart(2, '0')}:00:00`
              : null,
            pick(['new', 'open', 'closed']),
            uid, uid, tid,
          ]
        );
        counts.partnerActs++;
      }
    }
    console.log(`  ✓ Added ${counts.partnerActs} partner activities (${allPartners.length} partners)`);

    // ── 6. Onboarding tasks ───────────────────────────────────────────────────
    async function addOnboardTasks(partnerId, step, addCompletedPrev) {
      // Current step: pending tasks
      for (const task of ONBOARDING_TEMPLATES[step] || []) {
        const uid = pick(uids);
        await client.query(
          `INSERT INTO crm_onboarding_tasks
             (partner_id, step, title, type, assigned_to, due_date, done,
              created_by, created_at, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7,NOW(),$8)`,
          [partnerId, step, task.title, task.type, uid, futureDate(randInt(5, 21)), uid, tid]
        );
        counts.onboardTasks++;
      }
      // Previous steps: completed
      if (addCompletedPrev && step > 0) {
        for (let s = 0; s < step; s++) {
          for (const task of ONBOARDING_TEMPLATES[s] || []) {
            const uid = pick(uids);
            await client.query(
              `INSERT INTO crm_onboarding_tasks
                 (partner_id, step, title, type, assigned_to, due_date, done, done_at,
                  created_by, created_at, tenant_id)
               VALUES ($1,$2,$3,$4,$5,$6,true,NOW()-'3 days'::interval,$7,NOW(),$8)`,
              [partnerId, s, task.title, task.type, uid, futureDate(-7), uid, tid]
            );
            counts.onboardTasks++;
          }
        }
      }
    }

    for (let i = 0; i < newPartnerIds.length; i++) {
      await addOnboardTasks(newPartnerIds[i], PARTNER_SETUP[i].step, true);
    }
    for (const p of existPartners.filter(p => p.status === 'onboarding').slice(0, 5)) {
      const tasks = ONBOARDING_TEMPLATES[p.onboarding_step] || [];
      if (!tasks.length) continue;
      const task = pick(tasks);
      const uid  = pick(uids);
      await client.query(
        `INSERT INTO crm_onboarding_tasks
           (partner_id, step, title, type, assigned_to, due_date, done,
            created_by, created_at, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,NOW(),$8)`,
        [p.id, p.onboarding_step, `[Czerwiec 2026] ${task.title}`, task.type, uid, futureDate(randInt(5, 14)), uid, tid]
      );
      counts.onboardTasks++;
    }
    console.log(`  ✓ Created ${counts.onboardTasks} onboarding tasks`);

    // ── 7. Workflow tasks ─────────────────────────────────────────────────────
    const allDocs = [...newDocIds, ...existDocs.map(d => d.id)];
    for (const docId of allDocs) {
      const taskType  = pick(WF_TASK_TYPES);
      const assignedTo = pick(uids);
      const assignedBy = pick(uids);
      await client.query(
        `INSERT INTO workflow_tasks
           (id, document_id, assigned_by, assigned_to,
            task_type, task_status, message, due_date,
            created_at, updated_at, tenant_id)
         VALUES (gen_random_uuid(),$1,$2,$3,$4::workflow_task_type,'pending',$5,$6,NOW(),NOW(),$7)`,
        [docId, assignedBy, assignedTo, taskType, WF_MESSAGES[taskType], futureDate(randInt(3, 14)), tid]
      );
      counts.wfTasks++;
    }
    console.log(`  ✓ Created ${counts.wfTasks} workflow tasks`);

    await client.query('COMMIT');

    console.log('\n✓ Demo refresh complete:');
    console.log(`  New leads:           ${counts.leads}`);
    console.log(`  New partners:        ${counts.partners}`);
    console.log(`  New documents:       ${counts.docs}`);
    console.log(`  Lead activities:     ${counts.leadActs}`);
    console.log(`  Partner activities:  ${counts.partnerActs}`);
    console.log(`  Onboarding tasks:    ${counts.onboardTasks}`);
    console.log(`  Workflow tasks:      ${counts.wfTasks}`);
    console.log(`  Run tag:             ${runTag}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Demo refresh failed:', err.message);
  process.exit(1);
});
