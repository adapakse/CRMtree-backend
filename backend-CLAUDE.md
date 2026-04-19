# WorkTripsDoc CRM — Backend

## Stack
- **Runtime:** Node.js + Express.js (CommonJS, `'use strict'`)
- **Baza danych:** PostgreSQL — driver `pg`, pool przez `require('../config/database')`
- **Auth:** JWT (develop: stub) + SAML 2.0 Google Workspace (produkcja)
- **Storage:** Azure Blob Storage (`../services/storageService`)
- **Deploy:** Kubernetes — `htcd` = develop, `htpre` = production
- **Logger:** `require('../utils/logger')` (winston)
- **Migracje:** pliki SQL w `/migrations`, runner automatyczny przy starcie

## Struktura katalogów
```
src/
  app.js                   ← główny plik, rejestracja routerów
  config/
    database.js            ← pool PostgreSQL (używaj: const db = require('../config/database'))
    index.js               ← konfiguracja (env vars)
  routes/
    crm-leads.js           ← leady CRM
    crm-partners.js        ← partnerzy CRM
    crm-import.js          ← import CSV
    crm-gmail.js           ← Gmail OAuth2 integration
    documents.js           ← dokumenty
    settings.js            ← AppSettings (admin)
    admin-data.js          ← export/import danych
    attachments.js         ← załączniki (Azure Blob)
    users.js               ← zarządzanie userami
    groups.js              ← grupy użytkowników
    logs.js                ← audit log
    workflow.js            ← workflow/zadania
  services/
    storageService.js      ← Azure Blob
    gmailService.js        ← Gmail OAuth2
    calendarService.js     ← Google Calendar
    testAccountService.js  ← CreateTestAccount API (stub: USE_STUB=true)
    signusService.js       ← podpisywanie dokumentów
  middleware/
    requireAuth.js         ← JWT auth middleware
    crmAuth.js             ← CRM role check (crm_role != null)
  utils/
    logger.js              ← winston logger
    audit.js               ← audit.log() helper
migrations/
  0001_*.sql ... 0136_*.sql
```

## Konwencje kodu

### Router pattern
```js
'use strict';
const router  = require('express').Router();
const db      = require('../config/database');
const { requireAuth } = require('../middleware/requireAuth');
const { crmAuth, assertManager } = require('../middleware/crmAuth');
const { param, body, query, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.get('/...', requireAuth, crmAuth, async (req, res, next) => {
  try {
    // ...
  } catch (err) { next(err); }
});

module.exports = router;
```

### Middleware
- `requireAuth` — sprawdza JWT, ustawia `req.user` (`{ id, email, display_name, is_admin, crm_role }`)
- `crmAuth` — sprawdza czy user ma `crm_role` (nie-null), ustawia `req.isCrmManager` (is_admin || crm_role === 'sales_manager')
- `assertManager(req, res)` — zwraca 403 jeśli nie manager
- `assertOwnership(lead, req, field)` — sprawdza czy user jest właścicielem

### Audit log
```js
const audit = require('../utils/audit');
await audit.log({
  user: req.user,
  action: 'crm_lead_created',       // enum z tabeli audit_actions
  afterState: { ... },
  ipAddress: req.auditContext?.ipAddress,
});
```

### Parametryzowane zapytania
```js
const params = [];
let where = 'WHERE 1=1';
if (req.query.stage) {
  params.push(req.query.stage);
  where += ` AND l.stage = $${params.length}`;
}
const { rows } = await db.query(`SELECT ... ${where}`, params);
```

## Baza danych — kluczowe tabele

### Users
```
users(id UUID PK, email, display_name, is_admin, is_active, crm_role)
crm_role: 'salesperson' | 'sales_manager' | null
```

### CRM Leads
```
crm_leads(id, company, nip VARCHAR(14), contact_name, contact_title, email, phone,
  source, stage, value_pln, probability, close_date, first_contact_date DATE,
  industry, assigned_to UUID→users, tags TEXT[], notes, hot BOOL,
  lost_reason, annual_turnover_currency, online_pct, website, logo_url,
  agent_name, agent_email, agent_phone, converted_at, converted_partner_id,
  created_by UUID→users, created_at, updated_at)

stage: 'new'|'qualification'|'presentation'|'offer'|'negotiation'|'closed_won'|'closed_lost'

crm_lead_contacts(id, lead_id→crm_leads, contact_name, contact_title, email, phone, created_at)
crm_lead_activities(id, lead_id, type, title, body, activity_at, duration_min, meeting_location, ...)
crm_lead_test_accounts(id, lead_id, status, subdomain, language, partner_currency, country,
  billing_*, admin_*, test_account_number, last_error)
```

### CRM Partners
```
crm_partners(id, company, nip VARCHAR(14), partner_number, status, onboarding_step SMALLINT,
  contact_name, contact_title, email, phone, industry, lead_id,
  manager_id UUID→users, group_id→partner_groups,
  contract_signed DATE, contract_expires DATE, contract_value,
  annual_turnover_currency, online_pct, tags TEXT[],
  subdomain, language, partner_currency, country,
  billing_address, billing_zip, billing_city, billing_country, billing_email_address,
  admin_first_name, admin_last_name, admin_email,
  commission_value, commission_basis, credit_limit_value, deposit_value,
  agent_name, agent_email, agent_phone,
  created_by, created_at, updated_at)

status: 'onboarding'|'active'|'inactive'|'churned'
onboarding_step: 0=Podpisanie umowy, 1=Konfiguracja, 2=Szkolenie, 3=Uruchomienie

crm_onboarding_tasks(id, partner_id, step 0-3, title, body, type, assigned_to UUID,
  due_date DATE, due_time TIME, done BOOL, done_at, done_by, created_by, created_at)

type: 'task'|'call'|'email'|'meeting'|'note'|'doc_sent'|'training'
```

### Documents
```
documents(id UUID, name, doc_number, doc_type VARCHAR, gdpr_type VARCHAR, status,
  entity1, entity2, entity2_nip, entity2_country,
  signing_date DATE, expiration_date DATE (NULL = czas nieokreślony),
  contract_subject, contact_name, contact_email, contact_phone,
  created_by, updated_by, created_at, updated_at)
```

### AppSettings
```
app_settings(key VARCHAR PK, value TEXT, value_type, label, description, category,
  updated_at, updated_by)

Ważne klucze:
  crm_lead_sources     → JSON: [{value, label, group}]  (group=null lub "Marketing")
  crm_partner_statuses → JSON: ["onboarding","active","inactive","churned"]
  crm_industries       → JSON: [...]
  doc_types            → JSON: [...]
  onboarding_task_templates → JSON: [{id, title, type, step, standard, assignee, days}]
```

### Grupy partnerów
```
partner_groups(id, name, display_name, description, has_owner_restriction BOOL)
```

### Audit
```
audit_log(id, user_id, action, before_state JSONB, after_state JSONB, ip_address, created_at)
audit_actions — enum: crm_lead_created, crm_lead_updated, crm_lead_migrated,
  crm_partner_created, crm_partner_updated, attachment_uploaded, attachment_deleted,
  signing_completed, signing_failed, ...
```

## Ważne reguły biznesowe

1. **NIP** — format CC+cyfry (np. PL1234567890). Dla PL: dokładnie 10 cyfr po kodzie. Unikalny cross-table (crm_leads + crm_partners).
2. **Partnerzy w onboarding** — wykluczeni z GET /partners (Rejestr). Widoczni tylko przez GET /partners/onboarding.
3. **Blokada statusu onboarding** — zmiana statusu z 'onboarding' blokowana gdy są nieukończone zadania (`done=false`).
4. **Migracja leada** — jednorazowa (blokada przez `converted_at`). Tworzy partnera w statusie 'onboarding' + automatyczne zadania standardowe z AppSettings.
5. **Filtr source** — obsługuje listę wartości oddzieloną przecinkiem: `source=val1,val2` → `source = ANY($n::text[])`.
6. **CRM role** — handlowiec widzi tylko swoje leady/zadania, manager widzi wszystko.
7. **Wymagalność pól leada** — etapy new/closed_lost: tylko firma+NIP. Pozostałe: pełna walidacja (strona, kontakt, email, telefon, obrót, źródło, branża, handlowiec, daty, szansa).

## Zmienne środowiskowe (kluczowe)
```
DATABASE_URL
JWT_SECRET
AZURE_STORAGE_CONNECTION_STRING
AZURE_CONTAINER_NAME
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
SAML_ENTRY_POINT, SAML_ISSUER, SAML_CERT
TEST_ACCOUNT_API_URL, TEST_ACCOUNT_API_KEY
NODE_ENV (development|production)
```

## Ostatnia migracja
**0136** — `crm_lead_contacts` (dodatkowe kontakty leada)

Poprzednie ważne:
- 0135 — remap źródeł leadów + nowy format słownika
- 0134 — szablony onboarding v2 (standard/assignee/days)
- 0133 — `crm_onboarding_tasks.due_time` + seed szablonów
- 0132 — migracja tagów → first_contact_date
- 0131 — kolumna `first_contact_date` w crm_leads
- 0130 — VARCHAR limits dla nip/phone
- 0129 — audit_action enum uzupełnienie CRM
- 0128 — doc_type/gdpr_type VARCHAR (usunięto enum)
- 0127 — seed group_profiles
- 0126 — partner_groups tabela
- 0125 — crm_partner_documents
- 0124 — crm_lead_test_accounts
