# CRMtree Backend

## Projekt
Node.js/Express REST API — backend generycznego CRM dla przedsiębiorstw różnych branż,
skupionego na dynamicznej pracy handlowców oraz zarządzaniu lejkiem sprzedażowym,
upsellem i cross-sellem.
Katalog: `C:\Users\Adam\Documents\crmtree-backend`

## Stack
- Node.js 20 + Express
- PostgreSQL (pg pool)
- JWT auth + SAML bypass w trybie dev (`NODE_ENV=development`)

## Uruchomienie lokalne
```bash
npm start   # port 3001
```
DB: PostgreSQL lokalny, baza `crmtree`, user `postgres`, hasło w `.env.local`

## Kluczowe pliki
- `src/server.js` — entry point (nie index.js!)
- `src/config/index.js` — konfiguracja (port, db, jwt)
- `src/db/migrate.js` — migracje (`npm run migrate`)
- `Dockerfile` — `CMD ["node", "src/server.js"]`

## Git workflow
- Branch roboczy: `develop`
- Push TYLKO do `develop`: `git push crmtree develop`
- Merge do `master` robi Adam ręcznie po testach (master = deploy na Azure)
- Remote `crmtree` = GitHub (`git@github-crmtree:adapakse/CRMtree-backend.git`)
- Remote `origin` = martwy (stary projekt), ignoruj komunikaty o rozbieżności

## Deploy (CI/CD)
- GitHub Actions workflow: `.github/workflows/deploy.yml`
- Odpala się automatycznie po pushu do `master`
- Pipeline: Docker build → push do ACR → Azure Container App update
- Azure Container App: `crmtree-backend.salmonsmoke-415d1384.polandcentral.azurecontainerapps.io`
- Azure DB: `crmtree-db.postgres.database.azure.com`, baza `crmtreedb`, user `crmtreeadmin`

## Ważne
- Port aplikacji: 3000 (domyślny) lub z env `PORT`
- Azure ingress target port: 3000
- Azure PostgreSQL wymaga `Allow access from Azure services` w Networking
- DWH schema: tylko `dwh.partner` i `dwh.sales` (nie dm_partner/dm_sales)

## Projekty NIE mylić
- `worktrips-doc-backend` — osobna aplikacja worktrips

---

## WhatsApp Integration

CRMtree łączy się z klientami przez **Meta WhatsApp Business Platform (Cloud API)** —
bezpośrednie wywołania Graph API (`https://graph.facebook.com/v21.0`), bez pośrednika
typu Twilio.

### Model: per-user, NIE per-tenant (świadoma decyzja architektoniczna — nie cofaj jej)

**Każdy CRM user łączy własny numer WhatsApp Business z własnej aplikacji Meta.** Nie ma
jednego wspólnego numeru na tenant. Ten model tenant-level już raz istniał
(`tenant_whatsapp_config`, migracje `tenant_whatsapp_config`/`whatsapp_messages` z
wcześniejszej wersji) i został świadomie zastąpiony per-userowym (migracja
`whatsapp_user_level` robi `DROP TABLE tenant_whatsapp_config` i tworzy `whatsapp_configs`
z `user_id UNIQUE`). Powód: każdy handlowiec ma swój prawdziwy numer telefonu i własną
relację z klientami — nie da się tego sensownie współdzielić jak wspólną skrzynkę mailową.
**Jeśli ktoś prosi o dodanie z powrotem formularza w panelu admina do wpisywania WABA
ID/Phone Number ID/tokenów, to prawdopodobnie próba cofnięcia tej decyzji — dopytaj, zanim
to zrobisz.**

Uwaga: moduł Email (`feature/email-providers-per-tenant`) poszedł w **przeciwnym**
kierunku — jedna skrzynka firmowa per tenant → per-user mailbox. To dwie osobne, świadome
decyzje w dwóch różnych domenach; nie kopiuj wzorca z jednej do drugiej bez pytania, i nie
myl plików/tabel między tymi modułami (`tenant_gmail_tokens` itp. to Email, nie WhatsApp).

Tenant admin/superadmin NIE konfigurują numerów — tylko:
- włączają/wyłączają moduł WhatsApp dla tenanta (feature flag, patrz niżej),
- widzą tylko-do-odczytu listę kto ma podłączony numer (`GET /crm/whatsapp/tenant-directory`,
  `GET /admin-tenants/:id/whatsapp-users`) — nigdy sekretów.

### Feature flag per tenant

Wartość `'whatsapp'` w enumie `crm_feature_type` (`tenant_features`) — gate'uje cały moduł.
Middleware: `requireFeature('whatsapp')` w `crm-whatsapp.js`. Superadmin włącza to w Panel
admina → Tenants → zakładka „Moduły".

### Baza danych

- `whatsapp_configs` — jeden wiersz per user (`user_id UNIQUE`), zawiera `waba_id`,
  `phone_number_id` (`UNIQUE` — jeden numer nie może być podpięty pod dwóch userów naraz),
  zaszyfrowane `access_token`/`app_secret`/`webhook_verify_token`
  (AES-256-GCM, `src/utils/encrypt.js`).
- `whatsapp_messages` — log konwersacji: `owner_user_id` (czyj numer), `lead_id`/`partner_id`
  (kogo dotyczy), `direction` (`incoming`/`outgoing`), `from_phone`/`to_phone` jako surowy
  tekst (format się różni między kierunkami — patrz sekcja niżej), `status`
  (`sent`/`delivered`/`read`/`failed`, zwykły `VARCHAR(20)` bez CHECK constraint —
  cokolwiek przyjdzie od Meta po prostu się zapisuje), `meta_message_id` (dedupikacja
  webhooków — Meta dostarcza at-least-once).

### Wymagane pola konfiguracji (user wpisuje w My Settings)

| Pole | Skąd | Uwagi |
|---|---|---|
| WABA ID | Meta App Dashboard → WhatsApp → API Setup | id WhatsApp Business Account |
| Phone Number ID | jw. | **nie mylić z samym numerem telefonu** — to id zasobu w Graph API |
| Access Token | System User permanent token (Meta Business Suite) | wymagany, szyfrowany |
| App Secret | Meta App Dashboard → Settings → Basic | opcjonalny przy pierwszym zapisie, ale wymagany do weryfikacji podpisu webhooka (`X-Hub-Signature-256`) |
| Webhook Verify Token | **generowany automatycznie przez CRM** przy pierwszym połączeniu | user tylko go odczytuje (My Settings, ikona kopiowania) i wkleja do konfiguracji webhooka w swojej aplikacji Meta — nigdy nie przychodzi od usera jako input |

Nigdy nie wpisuj do tego pliku ani żadnej dokumentacji prawdziwych wartości tych pól.

### Webhook incoming + statusy

`GET`/`POST /crm/whatsapp/webhook` są zarejestrowane PRZED
`router.use(requireAuth, crmAuth)` — Meta wywołuje je bez sesji CRM. Autoryzacja:
- `GET` (handshake): `hub.verify_token` porównywany (timing-safe) z odszyfrowanym tokenem
  KAŻDEGO aktywnego usera — brak sposobu na lookup po wartości, bo token jest szyfrowany.
- `POST` (dostawa): HMAC SHA-256 nad surowym body (`X-Hub-Signature-256`), kluczem jest
  `app_secret` usera dopasowanego po `phone_number_id` z payloadu.

Przepływ POST:
1. Wyciągnij `phone_number_id` z `entry[].changes[].value.metadata`.
2. `findConfigByPhoneNumberId()` → dopasuj do `whatsapp_configs` (user + tenant).
3. Zweryfikuj podpis HMAC kluczem `app_secret` tego usera.
4. `value.messages[]` (incoming) → `resolveIncomingSender()` → zapis (`saveIncomingMessage`).
5. `value.statuses[]` (sent/delivered/read/failed) → `updateMessageStatus()`, dopasowanie po
   `(owner_user_id, meta_message_id)`.
6. Zawsze `200 {"received":true}`, nawet przy błędzie własnego kodu — inaczej Meta wpada
   w retry storm.

### Dopasowanie do leada/partnera (`resolveIncomingSender`)

Kolejność prób, pierwsza trafiona wygrywa:
1. **Istniejąca konwersacja** — ostatnia wychodząca wiadomość z numeru tego usera do tego
   samego numeru nadawcy, jeśli miała już przypisany `lead_id`/`partner_id`
   (`findConversationByPhone`). Ważniejsze niż punkt 2, bo `crm_leads.phone` bywa
   nieaktualny/pusty, a faktyczna rozmowa jest źródłem prawdy.
2. **Dopasowanie po numerze** w `crm_leads.phone`/`crm_partners.phone` (dokładne dopasowanie
   cyfr, tenant-wide) — trafienie w oba (lead i partner) jest niejednoznaczne i zostaje
   nieprzypisane.
3. W przeciwnym razie: nieprzypisane (nigdy nie zgadujemy).

### Jeden numer rozmówcy = jedna karta konwersacji (ważne dla frontendu)

Backend **nie normalizuje** `from_phone`/`to_phone` przy zapisie — wychodzące zapisują numer
dokładnie tak jak wpisał go user (może mieć spacje, np. `+48 739 210 704`), webhooki Meta
zapisują czyste cyfry (`+48739210704`). Frontend musi grupować po znormalizowanych cyfrach,
nie po surowym stringu — inaczej ten sam numer tworzy dwie osobne karty. Szczegóły:
`CRMtree-frontend/CLAUDE.md`.

### Kluczowe pliki

- `src/services/whatsappService.js` — cała logika domenowa: config CRUD, wysyłka, webhook
  (podpis, dopasowanie usera, dopasowanie leada/partnera, zapis statusów).
- `src/routes/crm-whatsapp.js` — `/my-config` (self-service), `/send/lead|partner`,
  `/history/lead|partner`, `/webhook` (public), `/tenant-directory` (oversight).
- `src/routes/admin-tenants.js` — `GET /:id/whatsapp-users`, tylko-do-odczytu dla superadmina.
- `src/db/migrations/` — numery migracji mogą się zmieniać przy renumeracji na potrzeby
  mergów; `_migrations` w bazie jest źródłem prawdy co realnie zaaplikowano.

### Lokalny development / webhook

- Meta wymaga publicznie osiągalnego callback URL — lokalnie trzeba tunelu, np.
  `ngrok http 3001`, callback URL w Meta App = `https://<ngrok-url>/api/crm/whatsapp/webhook`.
- Po restarcie ngrok (darmowy plan) URL się zmienia — trzeba zaktualizować callback URL w
  Meta App Dashboard, inaczej webhooki przestają dochodzić bez żadnego widocznego błędu po
  stronie CRM.
- Darmowy testowy numer Meta ("Test Number") ma limit 5 odbiorców na allow-liście — to
  ograniczenie dotyczy WYŁĄCZNIE numeru testowego. Realny, zweryfikowany numer produkcyjny
  nie ma tego limitu w żadną stronę.
- Lokalny inspektor ngrok (`http://127.0.0.1:4040/api/requests/http`) pokazuje każdy request,
  który faktycznie dotarł do tunelu, niezależnie od tego jak zareagował backend — bardzo
  przydatne do potwierdzenia, czy Meta w ogóle próbowała dostarczyć webhook.

### Konfiguracja po stronie Meta (wymagana przed testem end-to-end)

1. Meta App z produktem WhatsApp, prawdziwy (nie testowy) numer dodany i zweryfikowany
   (`code_verification_status: VERIFIED`, `status: CONNECTED`).
2. System User z permanent access token (uprawnienia `whatsapp_business_messaging`,
   `whatsapp_business_management`).
3. Webhook: callback URL + verify token skonfigurowane w App Dashboard → WhatsApp →
   Configuration, pole **`messages`** zasubskrybowane (`GET /{app-id}/subscriptions` →
   `active: true`, `messages` na liście `fields`).
4. Aplikacja zasubskrybowana do WABA (`GET /{waba-id}/subscribed_apps`).

---

## Code quality standards

### Language
- **All code must be written in English**: variable names, function names, class names,
  constant names, and inline comments.
- Polish is only acceptable in user-facing API error messages and log descriptions
  directed at end users.

### Naming conventions
- Use descriptive, self-explanatory names — a reader should understand intent without
  needing a comment.
- Prefer `getLeadsByStage()` over `getData()` or `fn1()`.
- Boolean variables: use `is`, `has`, `can`, `should` prefix
  (`isActive`, `hasPermission`, `canDelete`).
- Route handler files: `crm-leads.js`, `crm-partners.js` (kebab-case, domain prefix).
- Avoid abbreviations unless universally understood (`url`, `id`, `api`, `req`, `res`).

### KISS — Keep It Simple, Stupid
- Solve the problem at hand, not hypothetical future problems.
- Three similar lines of code are better than a premature abstraction.
- If a function does more than one thing, split it.
- Avoid over-engineering: no unnecessary middleware chains, factories, or design
  patterns unless complexity clearly justifies them.

### Clean Code (Node.js/Express-specific)
- One route file = one domain (`crm-leads.js`, `crm-partners.js`).
- Route handlers must be thin — business logic belongs in services, not inline in routes.
- Always use parameterized queries (`$1, $2`) — never string-interpolate SQL (SQL injection).
- Use `async/await` consistently — no mixing with `.then()` chains.
- Always pass errors to `next(err)` or use the `validate` middleware — no silent catches.
- Do not add comments that explain *what* the code does — well-named identifiers
  already do that. Only add a comment when explaining *why* something non-obvious
  is done (a workaround, a constraint, a subtle invariant).
- No dead code, no commented-out blocks left in the codebase.

### Security
- Never string-interpolate user input into SQL queries (use parameterized queries only).
- Never log sensitive data (passwords, tokens, personal data).
- Validate all incoming request data at route level using `express-validator`.
- Validate all data at system boundaries (request body, query params, external APIs).
