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
- Remote `origin` = GitHub (`git@github-crmtree:adapakse/CRMtree-backend.git`) — jedyny i
  właściwy remote; osobnego remote `crmtree` nie ma.
- Branch roboczy: `develop`. Push na `develop` uruchamia `deploy-int.yml`: migracje na bazie
  INT, potem wdrożenie `crmtree-backend-int`. Większą zmianę rób na gałęzi
  `feature/<opisowa-nazwa>` i scalaj do `develop` po przejściu testów.
- **W tym repozytorium pracuje równolegle kilka sesji.** Przed pushem zawsze `git fetch` i
  scal `origin/develop`, potem `npm run migrate` i pełne testy. Commituj tylko swoje pliki.
  Do większej zmiany użyj osobnego worktree (`git worktree add ../crmtree-backend-<temat>`),
  żeby nie przełączać gałęzi w katalogu, w którym pracuje inna sesja.
- Numer migracji bierz po `git fetch` z `origin/develop`, nie z lokalnego katalogu.
- Merge do `master` robi Adam ręcznie po testach (master = deploy produkcyjny na Azure).

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
- DWH schema: per-tenant, patrz sekcja „Infrastruktura Azure i sekrety” niżej — poprzednia
  wersja tej notatki (tylko `dwh.partner`/`dwh.sales`) była nieaktualna.

## Projekty NIE mylić
- `worktrips-doc-backend` — osobna aplikacja worktrips

---

## Infrastruktura Azure i sekrety

### Środowiska
- **PROD**: Container Apps `crmtree-backend` / `crmtree-frontend` (resource group
  `rg-crmtree-prod`), DB `crmtreedb` na `crmtree-db.postgres.database.azure.com`. Deploy
  automatyczny z brancha `master` (GitHub Actions).
- **INT**: `crmtree-backend-int` / `crmtree-frontend-int` (ten sam resource group, ten sam
  serwer Postgres, osobna baza `crmtreedb_int`). Deploy z brancha `develop`. Ma
  `NODE_ENV=development` — aktywuje `POST /api/auth/dev-login` i `GET /api/auth/saml` (dev
  SSO bypass: lista userów tenanta, logowanie bez hasła). **Te trasy NIE istnieją na PROD**
  (`NODE_ENV=production` → 404).
- Subdomeny tenantów: `app.crmtree.pl` (uniwersalny login) / `{slug}.crmtree.pl`
  (per-tenant), analogicznie `app.int.crmtree.pl` / `{slug}.int.crmtree.pl` na INT —
  wildcard DNS + cert na obu, nowy tenant nie wymaga żadnej dodatkowej konfiguracji DNS.

### Sekrety — wszystko w Azure Key Vault (`crmtree-vault`), nigdy w plikach ani w kodzie
Container Apps (PROD i INT) referencują sekrety przez `secretRef` → Key Vault, przez
system-assigned managed identity
(`keyvaultref:https://crmtree-vault.vault.azure.net/secrets/<nazwa>,identityref:system`).
**Nigdy nie wklejaj realnych wartości sekretów do repo, do tego pliku ani do commit
message** — poniżej tylko nazwy, nie wartości.

Aktualna lista (nazwa sekretu w Key Vault → zmienna env):
- `db-password` → `DB_PASSWORD`
- `jwt-secret` → `JWT_SECRET`
- `google-client-secret` → `GOOGLE_CLIENT_SECRET`
- `anthropic-api-key` → `ANTHROPIC_API_KEY`
- `pexels-api-key` → `PEXELS_API_KEY`
- `deepseek-api-key` → `DEEPSEEK_API_KEY` (zmienna gotowa, kod jeszcze z niej nie korzysta)
- `serper-api-key` → `SERPER_API_KEY` (zmienna gotowa, kod jeszcze z niej nie korzysta)
- `facebook-access-token` → `FACEBOOK_ACCESS_TOKEN` (zmienna gotowa, kod jeszcze z niej nie korzysta)
- `gus-regon-key` → `GUS_REGON_KEY` (zmienna gotowa, kod jeszcze z niej nie korzysta)

Celowy wyjątek: hasło do ACR (`crmtreeregistryazurecrio-crmtreeregistry`) zostaje jako
zwykły sekret Container Appa, nie w Key Vault — to auto-zarządzane przez Azure poświadczenie
do pullowania obrazów Dockera, nie sekret aplikacji.

Lokalnie: prawdziwe wartości w `.env.local` (gitignored — `.env.*` w `.gitignore`). Do repo
trafia tylko `.env.example` z placeholderami.

### Dostęp do bazy Azure Postgres z lokalnego komputera
Serwer ma firewall — trzeba dodać regułę dla swojego IP, potem posprzątać:
```bash
MYIP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create --name crmtree-db --resource-group rg-crmtree-prod --rule-name <twoja-nazwa> --start-ip-address "$MYIP" --end-ip-address "$MYIP"
# ... praca ...
az postgres flexible-server firewall-rule delete --name crmtree-db --resource-group rg-crmtree-prod --rule-name <twoja-nazwa> --yes
```
Connection string: `host=crmtree-db.postgres.database.azure.com port=5432 dbname=<crmtreedb|crmtreedb_int> user=crmtreeadmin sslmode=require` (hasło: sekret `db-password` w Key Vault).

### Pułapki poznane w praktyce (nieoczywiste z samego kodu)

**Soft-delete tenanta nie zwalnia `name`/`slug`.** Unikalny constraint na `tenants.name`/
`tenants.slug` NIE jest filtrowany po `deleted_at IS NULL` — próba odtworzenia tenanta pod
tą samą nazwą zaraz po skasowaniu zawsze rzuca `23505`. `POST /admin/tenants` łapie ten
wyjątek i zwraca czytelne 409 zamiast 500 (patrz `admin-tenants.js`). Jeśli będzie potrzeba
realnego odtwarzania nazwy po skasowaniu, trzeba by zrobić partial unique index
(`WHERE deleted_at IS NULL`) — świadomie jeszcze tego nie zrobiono.

**Login musi być scopowany po hoście, nie tylko po e-mailu.** Ten sam e-mail może istnieć na
wielu tenantach jednocześnie (realny przypadek w danych testowych). Każde miejsce, które
robi `SELECT ... FROM users WHERE lower(email)=$1` (login, dev-login, `GET /saml` picker)
MUSI dodatkowo filtrować po `tenant_id` rozpoznanym z subdomeny hosta — patrz
`resolveHostTenantId()` w `routes/auth.js`, korzysta z `matchTenantSlug`/
`resolveRequestHost` z `config/tenantHost.js`. Bez tego `LIMIT 1` bez `ORDER BY` zwraca
nondeterministycznie losowy wiersz — realnie spowodowało to blokadę logowania („Tenant nie
jest już dostępny”) dla części userów, dopóki nie zostało naprawione.

**DWH: tabele są per-tenant, nazwa zależy od `dwh_schema_prefix`.** Kod (`crm-partners.js`,
`crm-sales-data.js`) buduje nazwę tabeli dynamicznie: `dwh.${req.dwhPrefix}_partner` /
`dwh.${req.dwhPrefix}_sales`, gdzie `req.dwhPrefix` = `tenants.dwh_schema_prefix` (ustawiane
w `middleware/auth.js`, fallback `crmtree_gold`). **Każdy nowy tenant potrzebuje własnej
pary tabel** (`dwh.<prefix>_partner`, `dwh.<prefix>_sales`, ta sama struktura co
`dwh.crmtree_gold_partner`/`_sales`) — bez nich `GET /crm/partners` i cały moduł
`/crm/sales-data` rzucają 500 (`relation "dwh.<prefix>_partner" does not exist`).
`crm_partners.dwh_partner_id` (globalnie unikalny w całej tabeli, nie per tenant) łączy
partnera CRM z jego wierszem w DWH — bez tego linku dane sprzedażowe w raportach nie
przypiszą się do właściwego opiekuna.

**`git remote origin` bywa martwy po forku z Worktrips.** Jeśli klonujesz to repo i widzisz
w `git remote -v` adres `bastion.org.hotailors.com`, to relikt po forku — upewnij się, że
`origin` faktycznie wskazuje na `github.com/adapakse/CRMtree-backend` (użyj
`git remote set-url origin ...` jeśli nie).

---

## WhatsApp Integration

CRMtree łączy się z klientami przez **Meta WhatsApp Business Platform (Cloud API)** —
bezpośrednie wywołania Graph API (`https://graph.facebook.com/v21.0`), bez pośrednika
typu Twilio.

### Model: per-tenant, NIE per-user (decyzja biznesowa 2026-08-03 — nie cofaj jej bez pytania)

**Jeden wspólny firmowy numer WhatsApp Business per tenant, konfigurowany przez super
admina** w Panel admina → Tenants → zakładka „WhatsApp” (`tenant_whatsapp_config`).
Wcześniej (do 2026-08-03) istniał model per-user — każdy CRM user łączył własny numer w
My Settings (`whatsapp_configs` z `user_id UNIQUE`) — świadomie z niego zrezygnowano.
Powód: WhatsApp Business blokuje jednoczesne używanie prywatnego i firmowego konta na tym
samym numerze telefonu — user podłączający własny numer tracił dostęp do swojej prywatnej
historii i musiał się z niej wylogować, co czyniło model per-user niepraktycznym w terenie.
CRM Tree kupuje/zarządza realnym numerem firmowym; klient płaci za korzystanie z WhatsApp
(pozycja w cenniku, poza zakresem tego pliku). Migracja `0231_whatsapp_tenant_level.sql`
przywraca `tenant_whatsapp_config` i usuwa `owner_user_id` z `whatsapp_messages`
(data-preserving — historia wiadomości zostaje, ginie tylko atrybucja "czyj numer").
Stare `whatsapp_configs` (per-user) zostaje jako nieużywane dane historyczne, nic go już
nie czyta. **Jeśli ktoś prosi o dodanie z powrotem self-service podłączania numeru w My
Settings, to prawdopodobnie próba cofnięcia tej decyzji — dopytaj, zanim to zrobisz.**

Uwaga: moduł Email (`feature/email-providers-per-tenant`) poszedł w **przeciwnym**
kierunku — jedna skrzynka firmowa per tenant → per-user mailbox. To dwie osobne, świadome
decyzje w dwóch różnych domenach; nie kopiuj wzorca z jednej do drugiej bez pytania, i nie
myl plików/tabel między tymi modułami (`tenant_gmail_tokens` itp. to Email, nie WhatsApp).

Tenant admin NIE konfiguruje numeru (widzi tylko włącznik feature flagi, patrz niżej) —
tylko super admin ma dostęp do `PUT /admin/tenants/:id/whatsapp-config`.

### Feature flag per tenant

Wartość `'whatsapp'` w enumie `crm_feature_type` (`tenant_features`) — gate'uje cały moduł.
Middleware: `requireFeature('whatsapp')` w `crm-whatsapp.js`. Superadmin włącza to w Panel
admina → Tenants → zakładka „Moduły".

### Baza danych

- `tenant_whatsapp_config` — jeden wiersz per tenant (`tenant_id UNIQUE`), zawiera `waba_id`,
  `phone_number_id`, zaszyfrowane `access_token`/`app_secret`/`webhook_verify_token`
  (AES-256-GCM, `src/utils/encrypt.js`).
- `whatsapp_messages` — log konwersacji: `tenant_id` (czyj numer — zawsze ten sam per
  tenant), `lead_id`/`partner_id` (kogo dotyczy), `direction` (`incoming`/`outgoing`),
  `from_phone`/`to_phone` jako surowy tekst (format się różni między kierunkami — patrz
  sekcja niżej), `status` (`sent`/`delivered`/`read`/`failed`, zwykły `VARCHAR(20)` bez
  CHECK constraint — cokolwiek przyjdzie od Meta po prostu się zapisuje), `meta_message_id`
  (dedupikacja webhooków — Meta dostarcza at-least-once).
- `whatsapp_configs` (per-user, z poprzedniego modelu) — **nieużywane, nic go już nie
  czyta**. Zostawione jako historyczne dane, nie migrowane do `tenant_whatsapp_config`.

### Wymagane pola konfiguracji (super admin wpisuje w Panel admina → Tenants → WhatsApp)

| Pole | Skąd | Uwagi |
|---|---|---|
| WABA ID | Meta App Dashboard → WhatsApp → API Setup | id WhatsApp Business Account |
| Phone Number ID | jw. | **nie mylić z samym numerem telefonu** — to id zasobu w Graph API |
| Access Token | System User permanent token (Meta Business Suite) | wymagany, szyfrowany |
| App Secret | Meta App Dashboard → Settings → Basic | opcjonalny przy pierwszym zapisie, ale wymagany do weryfikacji podpisu webhooka (`X-Hub-Signature-256`) |
| Webhook Verify Token | **generowany automatycznie przez CRM** przy pierwszym zapisie | super admin tylko go odczytuje (przycisk „Pokaż”/„Kopiuj”) i wkleja do konfiguracji webhooka w Meta App — nigdy nie przychodzi jako input |

Nigdy nie wpisuj do tego pliku ani żadnej dokumentacji prawdziwych wartości tych pól.

### Webhook incoming + statusy

`GET`/`POST /crm/whatsapp/webhook` są zarejestrowane PRZED
`router.use(requireAuth, crmAuth)` — Meta wywołuje je bez sesji CRM. Autoryzacja:
- `GET` (handshake): `hub.verify_token` porównywany (timing-safe) z odszyfrowanym tokenem
  KAŻDEGO aktywnego tenanta — brak sposobu na lookup po wartości, bo token jest szyfrowany.
- `POST` (dostawa): HMAC SHA-256 nad surowym body (`X-Hub-Signature-256`), kluczem jest
  `app_secret` tenanta dopasowanego po `phone_number_id` z payloadu.

Przepływ POST:
1. Wyciągnij `phone_number_id` z `entry[].changes[].value.metadata`.
2. `findTenantConfigByPhoneNumberId()` → dopasuj do `tenant_whatsapp_config`.
3. Zweryfikuj podpis HMAC kluczem `app_secret` tego tenanta.
4. `value.messages[]` (incoming) → `resolveIncomingSender()` → zapis (`saveIncomingMessage`).
5. `value.statuses[]` (sent/delivered/read/failed) → `updateMessageStatus()`, dopasowanie po
   `(tenant_id, meta_message_id)`.
6. Zawsze `200 {"received":true}`, nawet przy błędzie własnego kodu — inaczej Meta wpada
   w retry storm.

### Dopasowanie do leada/partnera (`resolveIncomingSender`)

Kolejność prób, pierwsza trafiona wygrywa:
1. **Istniejąca konwersacja** — ostatnia wychodząca wiadomość tego tenanta do tego samego
   numeru nadawcy, jeśli miała już przypisany `lead_id`/`partner_id`
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
  (podpis, dopasowanie tenanta, dopasowanie leada/partnera, zapis statusów).
- `src/routes/crm-whatsapp.js` — `/status`, `/send/lead|partner`, `/history/lead|partner`,
  `/webhook` (public). Config CRUD NIE tutaj — patrz admin-tenants.js.
- `src/routes/admin-tenants.js` — `GET/PUT/DELETE /:id/whatsapp-config`, tylko dla
  super admina (`requireSuperAdmin`).
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

## Moduł Dokumenty — typ „Faktura”

Dokumenty (`src/routes/documents.js`) mają typ (`doc_type`, zwykły tekst od migracji 0128),
status (enum `doc_status`), typ GDPR i grupę dostępu (`group_id` → `group_profiles`; kto ma
rolę w grupie, widzi dokument — `permissionService`). Słowniki leżą w `app_settings` tenanta
jako tablice JSON **kodów** (etykiety tłumaczy frontend): `doc_types`, `doc_statuses`,
`doc_gdpr_types`, `doc_contract_subjects`, `doc_entity1_options`, `doc_payment_statuses`.
Admin tenanta edytuje je przez `PUT /api/admin/settings`; nowy tenant kopiuje je z
`crmtree-gold`, więc migracja dodająca słownik musi objąć także ten tenant.

**Faktura to dokument z `doc_type = 'invoice'`** (decyzje biznesowe, 2026-10-05 — nie cofaj
bez pytania). Reguły i mapowanie są w nagłówku `src/services/invoiceDocumentService.js`:

- **Istniejące kolumny w nowym znaczeniu:** `signing_date` = data wystawienia,
  `expiration_date` = termin płatności (najwcześniejszy) — celowo ta sama kolumna, żeby
  kolorowanie „wygasa wkrótce” i filtry po dacie działały dla terminu płatności; `entities` =
  [nabywca, sprzedawca] (własna firma pierwsza, kontrahent drugi — jak w każdym dokumencie);
  `nip` = NIP sprzedawcy; `contract_subject` nie jest używany (zawsze `NULL`, wartość z
  żądania jest pomijana).
- **Kolumny tylko dla faktury** (migracja 0320): `invoice_number`, `net_amount`,
  `vat_amount`, `gross_amount`, `currency`, `bank_account`, `payment_status`,
  `ksef_invoice_id` (NULL = faktura wpisana ręcznie). Dla innych typów są puste, a próba ich
  ustawienia daje 400; zmiana typu z faktury na inny je czyści. Umowy i pozostałe typy
  działają jak dotąd.
- **Status płatności** to wartość słownika `doc_payment_statuses` (domyślnie `unpaid`,
  `partially_paid`, `paid`, `overdue`), ustawiana ręcznie; nowa faktura dostaje `unpaid`.
  „Po terminie” jest dodatkowo **wyliczane przy odczycie**: `is_payment_overdue` = termin
  płatności minął i status ≠ `paid`. Zapisanego statusu nic samo nie zmienia. Kod `paid` jest
  przez to znaczący — usunięcie go ze słownika wyłącza „opłacone” dla flagi.
- **Faktura wpisana ręcznie** (zagraniczna, sprzed KSeF) powstaje zwykłym
  `POST /api/documents` z plikiem PDF i polami faktury; dostaje status `new` jak każdy
  dokument i może przejść zwykły obieg.
- **Odpowiedź szczegółów faktury ma `project_links`** — pozycje kosztów projektów powiązane
  z dokumentem (projekt, zadanie, kwota, status, kto i kiedy powiązał). Widzi je każdy, kto
  widzi dokument, także bez dostępu do projektu; `can_open` mówi tylko, czy może do projektu
  wejść (członek albo admin). Przy wyłączonych finansach projektów lista jest pusta.
- Faktura zarejestrowana z KSeF albo powiązana z kosztami nie może zmienić typu (409).
  Usunięcie dokumentu odpina go od pozycji kosztów (powiązanie z fakturą KSeF zostaje).
- `POST /api/documents` odpowiada **po** zatwierdzeniu transakcji — wcześniej odpowiedź
  wychodziła przed `COMMIT` i natychmiastowy odczyt nowego dokumentu potrafił dać 404.

**Co reaguje na daty dokumentu:** tylko frontend (progi `expiration_red_days` /
`expiration_soon_days`) i filtry listy (`expiry_before` / `expiry_after`). Backend nie ma
żadnego joba ani maila o wygasaniu — `emailService.sendExpiryWarning` istnieje, ale nikt go
nie wywołuje (a jego treść mówi o „wygasającym dokumencie”, więc przed podpięciem trzeba by ją
rozróżnić dla faktur). `signing_date` nadpisuje podpis elektroniczny (`signing.js`,
`signusService.js`) — faktur się nie podpisuje, więc nie koliduje to z datą wystawienia.

Testy: `src/__tests__/invoice-documents.test.js`, `documents.test.js`.

---

## Moduł Projekty

Projekty z zespołem, zadaniami, osią czasu i czatem. Osobny moduł poza CRM — dostępny dla
każdego usera tenanta, niezależnie od roli handlowej. Zobacz też `CRMtree-frontend/CLAUDE.md`.

### Decyzje biznesowe (Adam, 2026-10-03/04) — nie cofaj bez pytania

- **Flaga modułu `projects`** w `tenant_features`, włączana ręcznie przez superadmina, bez
  związku z planem billingowym. Migracja 0309 wstawia wiersz „wyłączone” każdemu tenantowi.
- **Role w projekcie:** `pm`, `internal_participant`, `external_participant`, `controller`
  + poziom `full` / `read`. PM zawsze `full`, kontroler zawsze `read` (nie edytuje treści,
  ale zmienia status na dowolnym zadaniu wg macierzy przejść). Uczestnik z `full` edytuje
  tylko zadania, do których jest przypisany. Osoby i zadanie nadrzędne ustawia tylko PM.
  Admin tenanta zarządza każdym projektem jak PM.
- **Zakładanie projektów:** `users.can_create_projects` (nadaje admin) albo admin; twórca
  zostaje PM-em. Projekt musi mieć co najmniej jednego PM-a.
- **Konto zewnętrzne (`users.is_external`):** zwykłe, płatne konto, które ma dostęp wyłącznie
  do Projektów. `requireAuth` odrzuca jego żądania poza `/api/projects`, `/api/auth`,
  `/api/profile`, `/api/admin/settings` (lista `EXTERNAL_USER_API_PREFIXES` w
  `middleware/auth.js`). W projekcie widzi tylko zadania przypisane do siebie.
- **Projektów i zadań się nie usuwa.** Projekt można zamknąć (tylko do odczytu, znika z
  domyślnej listy) i otworzyć ponownie. Pozycje słowników się dezaktywuje.
- **Słowniki per tenant** (statusy z kategorią `todo`/`in_progress`/`done`, typy, priorytety),
  macierz przejść statusów per rola, definicje pól dodatkowych. Domyślne wartości powstają
  leniwie przy pierwszym użyciu (`projectConfigService.ensureDefaults`), nie w migracji.
- **Pola dodatkowe** definiuje admin tenanta, PM dołącza je do projektu (nie do pojedynczego
  zadania) z flagą wymagalności. Wartości leżą w `project_tasks.custom_values` (JSONB,
  klucz = id definicji). Typy: `text`, `number`, `list`, `date`, `money` (kwota + waluta).
- **Zadania projektowe NIE są w tabelach aktywności CRM.** Mają własną tabelę i są podpięte
  jako kolejne źródło do tych samych list i joba przypomnień. Nie przenoś ich do
  `crm_lead_activities` / `crm_partner_activities` — te tabele wymagają leada/partnera i
  zasilają raporty.
- **Powiązanie z CRM:** projekt ma najwyżej jedno powiązanie — `lead_id` albo `partner_id`
  (CHECK w bazie). Jeden lead/partner może mieć wiele projektów. Wiąże tylko osoba z dostępem
  do CRM i tylko z rekordem w swoim zakresie. Przy konwersji leada projekty przechodzą na
  partnera (`moveLeadProjectsToPartner` w trasie migracji leada).
- **Widoczność na karcie leada/partnera:** projekty i ich zadania widzi każdy, kto widzi
  kartę, także bez członkostwa w projekcie (`can_open` mówi, czy może wejść do projektu).
- **Godzina 09:00:** zadanie ma datę zakończenia bez godziny. Przypomnienia wychodzą o 09:00
  `Europe/Warsaw` (`REMINDER_LOCAL_TIME` w `projectTaskService.js`), frontend stawia zadanie
  w kalendarzu o tej samej godzinie.

### Kontrola terminów (decyzje biznesowe, 2026-10-06) — nie cofaj bez pytania

Wszystko poniżej jest **liczone przy odczycie, nigdy zapisywane jako status**. „Dziś” to data
w strefie `Europe/Warsaw` (ta sama co przypomnienia). Reguły: nagłówek
`projectDeadlineService.js`.

- **Terminowość zadania** (`timeliness`): `overdue` — termin (`end_date`) przed dziś i kategoria
  statusu inna niż `done`; `at_risk` — nie po terminie, kategoria `todo` i termin w oknie
  dziś … dziś+N (włącznie); `on_time` — każde inne niezakończone zadanie z terminem. Zadanie
  bez terminu i zadanie zakończone mają `null`. `days_overdue` tylko dla `overdue`.
- **Próg N** ustawia admin tenanta (`PUT /api/admin/project-config/deadlines`,
  `at_risk_threshold_days` 0–30, domyślnie 3). Leży w `app_settings` pod kluczem
  `projects_at_risk_threshold_days`, tak jak przełącznik finansów; `GET /api/projects/config`
  go zwraca.
- **Zakończone po terminie** (`is_completed_late`): zadanie jest w statusie `done` i weszło do
  niego po swoim terminie. Do tego służy `project_tasks.completed_at` — ustawiane przy wejściu
  w status kategorii `done`, czyszczone przy wyjściu (także gdy admin zmieni kategorię statusu).
  Brak `completed_at` na zakończonym zadaniu (nie dało się odtworzyć z historii) = nie „po
  terminie”.
- **`has_overdue_subtasks`**: któreś podzadanie (dowolnie głęboko) jest po terminie. To słabszy
  znacznik — zadanie nadrzędne nie staje się przez to opóźnione. Uczestnik zewnętrzny widzi go
  tylko dla podzadań przypisanych do siebie.
- **Daty projektu:** opcjonalne `projects.start_date` / `end_date` (koniec ≥ początek), edytuje
  PM i admin tenanta w otwartym projekcie (`PATCH /api/projects/:id`, audyt `project_updated`).
  **Nigdy nie blokują dat zadań** — zadanie może kończyć się po końcu projektu.
- **Opóźnienie projektu** (`is_delayed`, `delay_reasons`, `delay_details`): `task_after_end` —
  niezakończone zadanie ma termin po końcu projektu; `end_passed` — koniec projektu minął,
  a zostały niezakończone zadania. Bez daty końca projekt nigdy nie jest opóźniony; zamknięty
  też nie. Zwracane na karcie projektu, liście projektów i listach projektów na karcie
  leada/partnera.
- **Termin pierwotny:** `project_tasks.original_end_date` = pierwszy termin, jaki zadanie
  kiedykolwiek dostało. **Nigdy nie jest nadpisywany** — także po wyczyszczeniu terminu; zadanie
  założone bez terminu dostaje go przy pierwszym ustawieniu. `slip_days` = termin − termin
  pierwotny (`null`, gdy równe albo czegoś brak; ujemne przy przyspieszeniu). Śledzimy tylko
  koniec, nie początek. Kto może zmieniać daty — bez zmian, bez akceptacji.
- **Powód zmiany terminu:** `PATCH` zadania przyjmuje opcjonalne `end_date_change_reason`
  (≤ 500 znaków); trafia do `audit_logs.metadata` i wraca w historii zadania jako
  `end_date_change_reason`. Podany bez faktycznej zmiany terminu jest ignorowany.
- **Widok międzyprojektowy** (`/api/projects/portfolio`): admin tenanta — wszystkie otwarte
  projekty; każdy inny — otwarte projekty, w których jest PM-em albo kontrolerem; pozostali 403.
  `GET /api/projects/config` zwraca `has_cross_project_view`. Zamknięte projekty nigdy tu nie
  wchodzą. Filtry widoku zasilają dwa słowniki zakresu, bez stron (limit 500 + `truncated`):
  `GET /portfolio/people` → `{ people: [{ user_id, display_name }] }` — każdy, kto jest członkiem
  projektu z zakresu albo jest przypisany do zadania w takim projekcie (także konto
  nieaktywne), po nazwie; `GET /portfolio/project-options` →
  `{ projects: [{ id, key, name, start_date, end_date }] }` — wszystkie projekty zakresu, po
  prefiksie (wybór projektów i linie końca projektu na osi czasu).
- **Maile** (`projectDeadlineNotificationService.js`), w języku **odbiorcy** jak każdy inny
  mail:
  - *zmiana terminu zadania* — od razu, do PM-ów projektu poza tym, który sam zmienił
    (także pierwsze ustawienie i wyczyszczenie terminu);
  - *projekt stał się opóźniony* — od razu, do wszystkich PM-ów, tylko gdy zmiana (termin
    zadania, ponowne otwarcie zadania, nowe zadanie, data końca projektu) przełącza projekt
    z „nieopóźniony” na opóźniony przez `task_after_end`; dopóki zostaje opóźniony, nic więcej
    nie wychodzi. Sam `end_passed` trafia do podsumowania dziennego — **tylko raz**, w dniu po
    dacie końca projektu (decyzja Adama z 2026-10-08: opóźniony projekt zgłaszamy raz, nie
    codziennie);
  - *podsumowanie dzienne* — z joba przypomnień, od 09:00 `Europe/Warsaw`, **jeden mail na
    osobę dziennie**: przypisany (także konto zewnętrzne) dostaje swoje zadania po terminie,
    PM — zadania po terminie i opóźnione projekty swoich projektów; kto jest jednym i drugim,
    dostaje obie części w jednym mailu. Zadania, które stały się opóźnione dziś (termin
    wczoraj), idą pierwsze z oznaczeniem „nowe”. Admin tenanta nie jest dopisywany. Idempotencja:
    wiersz w `project_deadline_digests` (osoba + dzień).
  - **Wyłącznik jest per użytkownik, nie per projekt:** `users.project_deadline_notifications_enabled`
    (domyślnie włączone), zmieniany w „Moje ustawienia” przez
    `PUT /api/profile/project-deadline-notifications`, zwracany przez `/api/auth/me`. Wyłącza
    wszystkie trzy maile we wszystkich projektach.
  - Zamknięty projekt nie wysyła nic. Błąd wysyłki nigdy nie psuje żądania ani joba.

### Listy modułu Projekty — stronicowanie, sortowanie, filtry (decyzja z 2026-10-06)

**Każda lista jest stronicowana i filtrowana po stronie serwera.** Jedna konwencja
(`middleware/project-list-query.js`): `page` (≥ 1), `page_size` (1–50, domyślnie 50),
`sort` + `order` (`asc` | `desc`), odpowiedź `{ items, total, page, page_size }`. Błędna
wartość = 400, pusta = filtr nieużyty.

- **Zgodność z aplikacją mobilną:** `GET /api/projects` zwraca tę samą stronę także pod starą
  nazwą `projects` (alias `items`), bo wydana aplikacja mobilna czyta listę z tego pola.
  Usuń alias dopiero, gdy aplikacja przejdzie na `items` i stronicowanie. Specyfikacja
  `mobile-v1.yaml` nie opisuje tras Projektów, a aplikacja z nich korzysta — przed zmianą
  kształtu którejkolwiek odpowiedzi `/api/projects*` sprawdź `crmtree-mobile`
  (`lib/features/projects/data/projects_repository.dart`), nie samą specyfikację.
- **Listy zadań** — jedno zapytanie (`projectTaskListService.js`), trzy zakresy:
  `GET /api/projects/:id/tasks/search` (zadania projektu), `GET /api/projects/my-tasks`
  (moje zadania), `GET /api/projects/portfolio/tasks` (widok międzyprojektowy). Wiersze są
  **płaskie** — przefiltrowana strona nie może być drzewem, więc zadanie niesie
  `parent_task_id` / `parent_task_number` / `parent_task_name`.
- **Oś czasu** potrzebuje całego przefiltrowanego zbioru: `GET /api/projects/:id/tasks/gantt`
  i `GET /api/projects/portfolio/gantt` — bez stron, limit 500 zadań i flaga `truncated`,
  te same filtry.
- **Sortowanie zadań:** `number`, `name`, `parent` (podzadania pogrupowane po zadaniu
  nadrzędnym, zadania bez nadrzędnego na końcu w obu kierunkach), `project`, `status`,
  `priority`, `type`, `assignee`, `start_date`, `end_date`, `original_end_date`, `slip_days`,
  `days_overdue`, `timeliness`, `cost`.
- **Filtry zadań** (`projectTaskFilters.js`, te same nazwy wszędzie): `name`, `number`,
  `project_ids`, `status_ids`, `status_category`, `priority_ids`, `type_ids`, `assignee`
  (id albo `unassigned`; w „moich zadaniach” ignorowany), `start_from`/`start_to`,
  `end_from`/`end_to`, `original_end_from`/`original_end_to`, `slip_min`/`slip_max`,
  `cost_min`/`cost_max`, `timeliness`.
- **Koszt zadania** w listach (`cost_total`, `cost_currency`) = suma WŁASNYCH pozycji kosztów
  zadania (planowane + poniesione, bez podzadań), w walucie projektu — **bez przeliczania
  między projektami**. Istnieje tylko dla osób, które czytają finanse danego projektu (admin,
  PM, kontroler) i przy włączonych finansach; dla pozostałych pole jest `null`, a filtr kosztu
  przepuszcza zadanie.
- **Lista projektów** (`GET /api/projects`, `projectService.searchProjects`) — filtry:
  `status`, `name` (nazwa albo prefiks), `start_from`/`start_to`, `end_from`/`end_to`,
  `delayed`, `delay_reason` (`task_after_end` | `end_passed`, lista — dowolny z podanych),
  `lead_id`, `partner_id`, `my_role` (`pm` | `controller` | `participant`), `pm` (id usera —
  projekty, w których jest PM-em), `overdue_min`/`overdue_max` i `at_risk_min`/`at_risk_max`
  (liczba zadań, liczby całkowite ≥ 0), `progress_min`/`progress_max` (całkowite 0–100),
  `cost_min`/`cost_max` i `revenue_min`/`revenue_max` (kwoty rzeczywiste, te same co
  w `finance`; ta sama reguła widoczności co koszt zadania); sortowanie: `name`, `key`,
  `status`, `start_date`, `end_date`, `delay`, `pm` (alfabetycznie pierwszy PM), `progress`,
  `overdue`, `at_risk`, `cost`, `revenue` (surowe kwoty w walucie projektu, bez przeliczania;
  projekty, których finansów pytający nie czyta, idą na koniec w obu kierunkach).
  `GET /api/projects/portfolio/projects` to to samo zapytanie zawężone do zakresu widoku
  (zawsze tylko otwarte).
  - **Zasada właściciela produktu: każda kolumna tabeli ma filtr i sortowanie.** Dodając
    kolumnę do przeglądu projektów albo listy zadań, dodaj od razu jej filtr i klucz sortowania.
  - **`progress_percent`** w wierszu projektu = udział zakończonych zadań zaokrąglony do
    całego procenta, 0 dla projektu bez zadań. Filtr i sortowanie postępu działają na tej
    samej liczbie — frontend ma ją pokazywać, a nie liczyć własną.
  - **`can_filter_finance`** w odpowiedzi obu list projektów: finanse włączone i pytający
    czyta finanse co najmniej jednego projektu (admin tenanta albo PM/kontroler dowolnego
    projektu, otwartego lub zamkniętego). Frontend pokazuje filtry kosztu i przychodu tylko
    wtedy.
- **Zostały bez stron, celowo:** `GET /api/projects/:id/tasks` (całe drzewo dla niefiltrowanego
  widoku projektu) i `GET /api/projects/assigned-tasks` (zasilanie kalendarza i dashboardu CRM
  — potrzebują całego zbioru). Nie dodawaj do nich filtrów — do tego są listy stronicowane.

### Finanse projektu — etap 1 (decyzje Adama, 2026-10-05) — nie cofaj bez pytania

Controlling projektu, nie księgowość: **kwoty netto, bez VAT, jedna waluta na projekt**.
Faktury kosztowe z KSeF i ich rejestrację w Dokumentach opisują osobne sekcje niżej; typ
dokumentu „Faktura” — sekcja „Moduł Dokumenty” wyżej.

- **Przełącznik per tenant:** admin tenanta włącza finanse w ustawieniach Projektów
  (`PUT /api/admin/project-config/finance`). Leży w `app_settings` pod kluczem
  `projects_finance_enabled`; brak wiersza = wyłączone. Przy wyłączonym każda trasa finansów
  (i słownik kategorii kosztów) odpowiada 403, a pozostałe odpowiedzi mają `finance: null`.
  Wyłączenie ukrywa dane, nie usuwa ich.
- **Kategorie kosztów:** słownik admina tenanta (nazwa, kolejność, aktywność), jeden poziom,
  bez usuwania — tylko dezaktywacja. Nieaktywna kategoria zostaje na istniejących pozycjach
  i w budżecie, który już ją ma; nie da się jej wybrać na nowo. Domyślne (Praca własna,
  Podwykonawcy, Materiały, Licencje, Podróże, Inne) powstają leniwie
  (`projectConfigService.listCostCategories`).
- **Budżet (plan):** waluta projektu (ISO, domyślnie PLN — zmienna tylko, dopóki projekt nie
  ma żadnej pozycji kosztu ani przychodu), planowany przychód, planowany koszt per kategoria.
  Zadanie może mieć własny planowany koszt (`project_tasks.planned_cost`) — raportowany
  **obok** budżetu kategorii, nigdy do niego nie dodawany i nie zwracany w odpowiedziach
  zadań.
- **Pozycje kosztów** (`planned` | `incurred`): data, kwota > 0 w walucie projektu,
  kategoria (wymagana), opis, opcjonalne zadanie tego samego projektu, dostawca, numer
  dokumentu. **Pozycje przychodów** (`planned` | `invoiced` | `paid`) są tylko na projekcie,
  nigdy na zadaniu. Jedne i drugie usuwa się naprawdę (hard delete); edycja tylko w otwartym
  projekcie.
- **Koszt w innej walucie:** `original_amount` + `original_currency` bez `amount` → kwota
  liczona kursem NBP wg reguły poniżej, kurs i jego data zapisane na pozycji. **Jawne
  `amount` zawsze wygrywa** (wtedy kursu nie zapisujemy). Przy edycji przeliczamy tylko, gdy
  żądanie dotyka kwot — sama zmiana daty nie zmienia kwoty.
- **Definicje liczb:** przychód rzeczywisty = pozycje `invoiced` + `paid`; koszt rzeczywisty
  = pozycje `incurred`; koszt planowany = suma budżetów kategorii; marża % = marża /
  przychód (`null` bez przychodu); pozostały budżet i odchylenie kategorii = budżet −
  poniesione (pozycje `planned` nie robią przekroczenia). Suma zadania = własne pozycje +
  wszystkich podzadań. Arytmetyka jest w `projectFinanceCalculations.js` (bez bazy).
- **Uprawnienia:** PM i admin tenanta — wszystko. Kontroler — czyta wszystko, nic nie
  zapisuje. Uczestnik wewnętrzny — nic, chyba że PM włączy na projekcie
  `participants_can_add_costs`: wtedy dodaje koszty do zadań, do których jest przypisany,
  i widzi/edytuje/usuwa wyłącznie pozycje, które sam utworzył (budżetu, przychodów
  i podsumowania dalej nie widzi). Uczestnik zewnętrzny — nigdy nic. Zamknięty projekt —
  tylko odczyt.
- **Strona CRM:** kto widzi kartę leada/partnera, widzi tam sumy finansowe powiązanego
  projektu (plan/wykonanie przychodu i kosztu, marża) także bez członkostwa — same sumy,
  bez pozycji. Lista projektów pokazuje sumy tylko PM-owi, adminowi i kontrolerowi.
- **Podpowiedź planowanego przychodu:** gdy projekt jest powiązany z leadem mającym wartość,
  a planowany przychód jest pusty, podsumowanie zwraca `suggested_planned_revenue` (wartość
  leada po najnowszym kursie). Nic nie zapisuje się samo. Przychody projektu nie mają
  związku z transakcjami partnera ani danymi sprzedażowymi.
- Pole dodatkowe typu `money` nie wchodzi do żadnej liczby finansowej.
- **Historia:** zmiany pozycji idą do `audit_logs` (`project_cost_*`, `project_revenue_*`,
  plan jako `project_updated`). Metadane celowo **nie mają `task_id`** — historię zadania
  czyta każdy, kto widzi zadanie, także uczestnik zewnętrzny.
- Ustawienia finansowe projektu są w osobnej tabeli `project_finance`, a nie w `projects`,
  bo `projects` jest czytane przez `SELECT *` w odpowiedziach dla wszystkich członków.

### Faktury kosztowe z KSeF — etap 3 (decyzje biznesowe, 2026-10-05) — nie cofaj bez pytania

Faktury zakupu pobierane z KSeF (Krajowy System e-Faktur, API 2.0) do lokalnej kopii i
wiązane z pozycjami kosztów projektu. Istnieją tylko u tenantów z włączonymi finansami
projektów — przy wyłączonych każda trasa KSeF odpowiada 403, a job pomija tenanta.

- **Konfiguracja należy do admina tenanta** (nie superadmina): lista firm, każda = własny
  NIP tenanta (nabywca na fakturach) + token KSeF wklejony przez admina. Wiele NIP-ów na
  tenanta jest dozwolone, każdy raz. Token jest sprawdzany przez **uwierzytelnienie w KSeF
  przed zapisem**, leży zaszyfrowany (`src/utils/encrypt.js` — ten sam mechanizm co sekrety
  WhatsApp i skrzynek) i **nigdy nie wraca w API** — tylko `token_hint` (4 ostatnie znaki).
  Nie loguj tokenu ani tokenów dostępowych. Usunięcie firmy zostawia jej faktury
  (`company_id` → NULL).
- **Zakres pierwszej synchronizacji:** ustawienie tenanta `ksef_initial_sync_days` w
  `app_settings` (domyślnie 30, 1–365). Liczy się wg daty trwałego zapisu w KSeF, nie daty
  wystawienia; obowiązuje dla firm dodanych po zmianie.
- **Synchronizacja:** job co 30 minut + „synchronizuj teraz” (`POST /api/ksef/sync`, 202,
  działa w tle). Tylko faktury zakupu (`Subject2`), **korekty są pomijane** (typ zaczynający
  się od `KOR`). Zapisujemy surowy XML i pola sparsowane. Filtr eksportu to data trwałego
  zapisu (`PermanentStorage`), kursor `ksef_companies.sync_from` idzie tylko do przodu i jest
  zapisywany po każdym oknie (okno ≤ 90 dni, ostatnie otwarte — do znacznika HWM). Maks. 6
  eksportów na przebieg (limit KSeF: 20 eksportów/h na NIP). HWM spóźnia się ok. 2 minuty —
  pusty wynik tuż po wystawieniu faktury jest normalny. Wstawianie przez
  `ON CONFLICT (tenant_id, ksef_number) DO NOTHING`.
- **Jedna synchronizacja firmy naraz, także między instancjami:** sesyjna blokada doradcza
  Postgresa (`pg_try_advisory_lock`) trzymana na osobnym połączeniu przez cały przebieg.
- **Status firmy:** `active`; `invalid` — KSeF odrzucił token, firma wypada z synchronizacji
  do czasu podmiany tokenu; `error` — inny błąd (sieć, 5xx, limit, zepsuta paczka), ponawiany
  w następnym przebiegu, opis w `last_error`. Jedna firma z błędem nie zatrzymuje pozostałych.
- **HTTP 429:** czekamy tyle, ile każe `Retry-After` (do 60 s, do 3 razy); dłuższe czekanie
  kończy przebieg błędem. Token dostępowy (ok. 15 min) jest odświeżany przed oknem, gdy
  zostało mu mniej niż 5 minut; odmowa odświeżenia → ponowne uwierzytelnienie.
- **VAT faktury walutowej:** metadane KSeF podają VAT w PLN, a netto/brutto w walucie
  faktury — zapisujemy VAT jako brutto − netto.
- **Pola z XML są opcjonalne** (data sprzedaży, termin i forma płatności, rachunek, znacznik
  i data zapłaty, kwota do zapłaty, adresy, pozycje): brak elementu = `null`, nigdy błąd.
  Parser to `fast-xml-parser` z wartościami jako tekst (NIP i rachunek zachowują zera).
- **Kto widzi faktury:** osobne uprawnienie `users.can_view_ksef_invoices` nadawane przez
  admina tenanta w panelu użytkowników (`/api/auth/me` je zwraca); admin ma je zawsze. Konto
  zewnętrzne nie może go dostać. Bez niego każda trasa `/api/ksef` odpowiada 403.
- **Wiązanie z kosztami:** pozycja kosztu MOŻE wskazywać fakturę
  (`project_cost_items.ksef_invoice_id`), nie musi. `POST …/finance/costs` z
  `ksef_invoice_id`: kwota domyślna = całe netto faktury (edytowalna), data = data
  wystawienia, dostawca i numer dokumentu z faktury. Przy innej walucie niż projekt kwota
  domyślna liczy się kursem NBP z dnia roboczego przed datą **wystawienia** faktury (nie datą
  kosztu); jawne `amount` wygrywa. Istniejącą pozycję podpina i odpina
  `PATCH` z `ksef_invoice_id` / `null`; usunięcie pozycji usuwa powiązanie.
- **Wiązanie nigdy nie jest blokowane.** Ta sama faktura może być powiązana wiele razy — z
  wieloma zadaniami i projektami, nawet dwa razy z tym samym. Zamiast blokady każda
  odpowiedź z powiązaną pozycją niesie `ksef_invoice` (z `links_count`, `linked_total`,
  `is_over_allocated`) i `other_links` (pozostałe pozycje tej samej faktury).
  `linked_total` jest w walucie faktury: powiązanie w tej samej walucie liczy się kwotą;
  w innej — `original_amount`, jeśli wpisano go w walucie faktury, inaczej kwotą przeliczoną
  kursem NBP dla daty wystawienia; brak kursu → `null` (nie zgadujemy).
  `is_over_allocated` = `linked_total` > netto faktury; liczą się pozycje `planned`
  i `incurred`.
- **Kto wiąże:** kto może zapisywać finanse projektu (PM, admin tenanta) **i** ma uprawnienie
  KSeF. Uczestnik z opcją „dodaje koszty do własnych zadań” nigdy nie użyje faktury KSeF.
  Podsumowanie faktury i `other_links` widzi każdy, kto czyta finanse projektu — także bez
  uprawnienia KSeF (uczestnik widzący tylko własne pozycje ich nie dostaje). Zamknięty
  projekt — tylko odczyt. Podpięcie i odpięcie idą do `audit_logs` jak inne zmiany kosztu
  (`ksef_invoice_id` w `before_state` / `after_state`).

### Faktury KSeF w Dokumentach — etap 4 (decyzje biznesowe, 2026-10-05) — nie cofaj bez pytania

Fakturę z KSeF rejestruje się jako dokument typu „Faktura” (mapowanie pól — sekcja „Moduł
Dokumenty”). Kod: `invoiceDocumentService.js`, PDF: `invoiceVisualisationPdfService.js`.

- **Kiedy:** automatycznie przy pierwszym powiązaniu faktury z pozycją kosztu (utworzenie
  pozycji z `ksef_invoice_id` albo podpięcie przez `PATCH`) oraz jawnie:
  `POST /api/ksef/invoices/:id/document` (uprawnienie KSeF; 201 nowy dokument, 200 gdy już
  był). **Jeden żywy dokument na fakturę KSeF** (częściowy indeks unikalny po
  `tenant_id, ksef_invoice_id`); usunięty dokument zwalnia fakturę do ponownej rejestracji.
- **Grupa dostępu:** admin tenanta wybiera JEDNĄ grupę dla dokumentów faktur w ustawieniach
  KSeF (`PUT /api/admin/ksef/settings` z `invoice_documents_group_id`, `null` czyści;
  `GET /api/admin/ksef` zwraca `invoice_documents_group`). Leży w `app_settings` pod kluczem
  `ksef_invoice_documents_group_id`. Bez wybranej (albo po dezaktywacji) grupy rejestracja
  automatyczna jest pomijana — **wiązanie z kosztem i tak się udaje** — a jawna odpowiada 409.
  Listy i szczegóły faktur niosą `document_id` i `is_document_group_configured`.
- **Bez obiegu:** dokument dostaje status `completed` („zarejestrowany, nic do zrobienia”),
  żadnych zadań akceptacji ani podpisu. Właściciel = użytkownik, którego akcja go
  zarejestrowała (może nie należeć do grupy — wtedy sam dokumentu nie otworzy).
- **Dane** z wiersza `ksef_invoices`: numer, sprzedawca, nabywca, daty, kwoty, waluta,
  rachunek; status płatności: `is_paid` → `paid`, zapłata częściowa → `partially_paid`,
  inaczej `unpaid`. Późniejsze zmiany w dokumencie są ręczne — synchronizacja go nie nadpisuje.
- **Wizualizacja PDF jest głównym plikiem dokumentu** (wersja 1), więc istniejący podgląd
  pokazuje ją bez zmian we frontendzie. Zawiera wyraźną informację, że to wizualizacja danych
  z KSeF, a nie oryginał. Etykiety idą przez i18n (zakres `invoicePdf`), język = domyślny
  język tenanta. Ta sama biblioteka i czcionka co faktura rozliczeniowa
  (`src/utils/pdfDocument.js`: PDFKit + DejaVu, wyłączone ligatury) — nie dodawaj drugiej
  biblioteki PDF. Treść powstaje w `buildVisualisationContent` (testowalna bez renderowania).
- **Pozycja kosztu ↔ dokument faktury** (`project_cost_items.document_id`): pozycja powiązana
  z fakturą KSeF zawsze wskazuje dokument zarejestrowany z tej faktury (albo żaden) — pole
  `document_id` w żądaniu jest wtedy ignorowane, a rejestracja dokumentu uzupełnia je także
  na wcześniejszych pozycjach. Dokument wpisany ręcznie podpina i odpina (`POST` / `PATCH`
  z `document_id`) osoba z prawem zapisu finansów projektu, która widzi dokument; uprawnienie
  KSeF nie jest potrzebne. Podanie dokumentu zarejestrowanego z KSeF jest wiązaniem tej
  faktury KSeF (z jej regułą uprawnień). Dokumentu ręcznego i faktury KSeF nie łączy się na
  jednej pozycji (400).
- **`other_links` jest wspólne:** wszystkie pozostałe pozycje dzielące fakturę KSeF **albo**
  dokument, każda raz. Wiązanie nadal nigdy nie jest blokowane. Pozycja niesie też
  `document` (id, numer, nazwa, `can_open` dla oglądającego).
- Poza zakresem: korekty, faktury sprzedaży, integracja z płatnościami/bankiem, odświeżanie
  dokumentu po zmianie faktury.

**Zmienna środowiskowa:** `KSEF_ENVIRONMENT` = `test` | `production` (to nie sekret —
zwykła zmienna Container Appa). Pusta = integracja wyłączona: job nie startuje (ostrzeżenie
w logu), zapis tokenu i „synchronizuj teraz” odpowiadają 400, ekran konfiguracji dostaje
`is_configured: false`. Adresy API są w `ksefApiClient.js`. Klucz szyfrowania tokenów to
istniejące `EMAIL_ENCRYPTION_KEY` (z fallbackiem na `JWT_SECRET`) — zmiana klucza unieważnia
zapisane tokeny.

**Token testowy:** środowisko testowe MF (`api-test.ksef.mf.gov.pl`) przyjmuje dowolny NIP
z poprawną sumą kontrolną i certyfikat samopodpisany (tylko z
`?verifyCertificateChain=false`). Token powstaje tak: uwierzytelnienie XAdES pieczęcią
samopodpisaną dla NIP-u nabywcy → `POST /tokens` z `permissions: ["InvoiceRead"]` (wartość
tokenu wraca tylko raz) → faktury testowe wysyła się sesją online jako inny NIP
(sprzedawca). Backend nie zawiera kodu XAdES — to narzędzie deweloperskie, nie funkcja
aplikacji. Lokalnie ustaw `KSEF_ENVIRONMENT=test` w `.env.local`. Testy Jest nie wołają
prawdziwego KSeF (`src/__tests__/helpers/ksefMock.js` udaje API z prawdziwym RSA/AES).

### Baza danych (migracje 0307–0311, finanse 0316–0317, KSeF 0319, faktury w Dokumentach 0320, terminy 0326)

Numer 0326 noszą dwa pliki (`0326_project_deadlines.sql` i `0326_tenant_lead_stages.sql` z
innej, równoległej zmiany). To nieszkodliwe — migracje są śledzone po nazwie pliku i nie zależą
od siebie — ale przed dodaniem migracji zawsze zrób `git fetch` i sprawdź numery na
`origin/develop`: przy kilku sesjach pracujących naraz numer „następny wolny” szybko się
dezaktualizuje.

`project_task_statuses`, `project_task_types`, `project_task_priorities`,
`project_status_transitions`, `project_field_definitions`, `projects`, `project_members`,
`project_fields`, `project_tasks`, `project_task_assignees`, `project_messages`. Kolumny na
`users`: `phone`, `company`, `department`, `is_external`, `can_create_projects`.
Numer zadania = `projects.key` (prefiks generowany z nazwy przy zakładaniu, niezmienny) +
licznik `projects.next_task_number`.

Finanse: `project_cost_categories`, `project_finance` (0–1 wiersz na projekt: waluta,
planowany przychód, `participants_can_add_costs`), `project_category_budgets`,
`project_cost_items` (z kolumnami `original_amount`, `original_currency`, `exchange_rate`,
`exchange_rate_date`), `project_revenue_items`, kolumna `project_tasks.planned_cost` oraz
globalna tabela kursów `nbp_exchange_rates`.

KSeF: `ksef_companies` (NIP, zaszyfrowany token, `token_hint`, `status`, `last_error`,
kursor `sync_from`, `last_attempt_at`, `last_synced_at`; `UNIQUE (tenant_id, nip)`),
`ksef_invoices` (pola z metadanych i XML, `payment` i `lines` jako JSONB, `metadata`,
`raw_xml`; `UNIQUE (tenant_id, ksef_number)`), kolumny
`project_cost_items.ksef_invoice_id` / `ksef_linked_by` / `ksef_linked_at` oraz
`users.can_view_ksef_invoices`.

Faktury w Dokumentach (0320): kolumny faktury na `documents` (lista w sekcji „Moduł
Dokumenty”), `project_cost_items.document_id` / `document_linked_by` / `document_linked_at`,
słownik `doc_payment_statuses` dla każdego tenanta i kod `invoice` dopisany do `doc_types`.

Kontrola terminów (0326): `projects.start_date` / `end_date`,
`project_tasks.original_end_date` / `completed_at`,
`users.project_deadline_notifications_enabled`, tabela `project_deadline_digests`
(`user_id`, `digest_date`). Migracja uzupełnia istniejące zadania z `audit_logs`: termin
pierwotny = wartość sprzed pierwszej zapisanej zmiany terminu (inaczej termin bieżący),
`completed_at` = ostatnie zapisane wejście w status `done` (inaczej `NULL`).

### Kluczowe pliki

- `src/routes/projects.js` — projekty, członkowie, pola, powiązanie z CRM, czat projektu,
  `GET /assigned-tasks` (musi być zarejestrowane przed `/:id`).
- `src/routes/project-tasks.js` — zadania, historia, czat zadania (`/api/projects/:id/tasks`),
  w tym `/search`, `/gantt` i `/assignee-summary` (zarejestrowane przed `/:taskId`).
- `src/routes/project-portfolio.js` (`/api/projects/portfolio`, montowane w `app.js` przed
  trasami z `/:id`) — widok międzyprojektowy: `/tasks`, `/gantt`, `/projects`.
- `src/middleware/project-list-query.js` — parametry stronicowania, sortowania i filtrów list.
- `src/routes/project-finance.js` — finanse projektu (`/api/projects/:id/finance`):
  podsumowanie, plan, pozycje kosztów i przychodów, planowany koszt zadania.
- `src/routes/admin-project-config.js` — konfiguracja admina tenanta, w tym przełącznik
  finansów i słownik `cost-categories`.
- `src/routes/admin-ksef.js` (`/api/admin/ksef`) — firmy i tokeny KSeF, zakres pierwszej
  synchronizacji. `src/routes/ksef.js` (`/api/ksef`) — lista i szczegóły faktur, stan firm,
  „synchronizuj teraz”. Wiązanie faktur idzie przez `project-finance.js`.
- KSeF w serwisach: `ksefApiClient.js` (HTTP: uwierzytelnienie tokenem, eksport, 429),
  `ksefPackage.js` (hash, AES, ZIP), `ksefInvoiceParser.js` (FA(3)), `ksefSyncService.js`
  (okna, kursor, blokada, statusy — reguły w nagłówku pliku), `ksefCompanyService.js`
  (konfiguracja i tokeny), `ksefInvoiceService.js` (lista, szczegóły, powiązania — reguła
  `linked_total` w nagłówku pliku), `invoiceDocumentService.js` (typ „Faktura”, rejestracja
  faktur KSeF, grupa dostępu, `project_links`), `invoiceVisualisationPdfService.js`.
  Job: `src/jobs/ksef-sync.js`.
- `src/middleware/project-access.js` — `loadProject` (404 także dla nie-członka, żeby nie
  ujawniać id), `requireProjectManager`, `requireOpenProject`, a dla finansów
  `requireFinanceEnabled`, `requireKsefAccess`, `loadFinanceAccess` i `requireFinance*` /
  `requireCost*`.
- Terminy: `projectDeadlineService.js` (reguły i fragmenty SQL terminowości oraz opóźnienia
  projektu), `projectDeadlineNotificationService.js` (maile), `projectTaskListService.js`
  + `projectTaskFilters.js` (stronicowane listy zadań), `projectPortfolioService.js` (zakres
  widoku międzyprojektowego).
- `src/services/projectService.js`, `projectTaskService.js` (reguły uprawnień do zadań są
  opisane w nagłówku pliku), `projectConfigService.js`, `projectCrmLinkService.js`,
  `projectMessageService.js`, `projectFinanceService.js` (reguły uprawnień do finansów
  w nagłówku pliku), `projectFinanceCalculations.js`.
- `GET /api/crm/leads/:id/projects` i `/api/crm/partners/:id/projects` — w trasach CRM.
- Przypomnienia: trzeci blok w `src/services/crmReminderService.js`; maile
  `sendProjectTaskAssigned` (od razu przy przypisaniu) i `sendProjectTaskReminder`. Ten sam
  job (`src/jobs/crm-reminders.js`) po przypomnieniach wysyła dzienne podsumowania terminów.
- Historia zadania: `audit_logs` z `metadata.task_id` (akcje `project_task_created` /
  `project_task_updated`).
- Testy: `src/__tests__/projects.test.js`, `project-tasks.test.js`,
  `project-deadlines.test.js` (terminowość, daty i opóźnienie projektu, termin pierwotny,
  filtry zadań, widok międzyprojektowy), `project-lists.test.js` (stronicowanie, sortowanie,
  oś czasu, filtry listy projektów), `project-deadline-emails.test.js` (maile),
  `projects-crm-integration.test.js`, `project-finance.test.js`,
  `projectFinanceCalculations.test.js` (bez bazy), `ksef-sync.test.js` (klient, paczki,
  synchronizacja), `ksef-invoices.test.js` (trasy, uprawnienia, wiązanie),
  `ksefInvoiceParser.test.js` (bez bazy; fixture to próbka MF `tpl-fa3-s3.xml`),
  `invoice-documents.test.js` (typ „Faktura”, rejestracja z KSeF, dokument ↔ koszt),
  `invoiceVisualisationPdf.test.js` (bez bazy).

### Aplikacja mobilna (decyzje Adama, 2026-10-08)

Aplikacja `crmtree-mobile` ma moduł Projekty (lista, karta projektu, zadania, czat) i dostaje
kontrolę terminów oraz finanse projektu. Opis dla sesji mobilnej:
`crmtree-frontend/docs/mobile-handoff-project-deadlines-finance.md`. Ustalenia, które wiążą też
backend:

- telefon ma **pełny zestaw filtrów** z list webowych i doładowuje kolejne strony przy
  przewijaniu (te same trasy i parametry co web);
- **Gantt jest budowany także w telefonie** (`/tasks/gantt`, `/portfolio/gantt`);
- **powiadomień push o terminach nie ma** — wystarczają maile; nie dodawaj ich bez pytania;
- **finanse w telefonie są tylko do odczytu** (bez dodawania i edycji kosztów), a **KSeF jest
  wyłącznie w webie**.

### Poza zakresem

Załączniki, zależności między zadaniami, licznik nieprzeczytanych wiadomości, edycja i usuwanie
wiadomości czatu. W finansach: VAT, wiele walut w jednym projekcie. W KSeF: faktury korygujące,
faktury sprzedaży jako przychód, integracja z płatnościami.

---

## Kursy walut (NBP)

Jedno źródło kursów dla całej aplikacji: tabela A NBP (kursy średnie), globalna tabela
`nbp_exchange_rates` (waluta, data, kurs do PLN) — **nie per tenant**. Kod:
`src/services/exchangeRateService.js`, job `src/jobs/exchange-rates-sync.js`.

- **Reguła kursu:** `getRate(waluta, data)` zwraca kurs z **ostatniego dnia roboczego PRZED
  datą** (polska zasada księgowa), nigdy z samego dnia. PLN = 1, dwie waluty obce liczymy
  przez PLN (`getCrossRate`). Dla daty przyszłej bierzemy najnowszą opublikowaną tabelę.
  Nieznana waluta albo brak kursu → błąd 4xx (422), **nigdy cichy kurs 1**. Kurs starszy
  niż 10 dni od daty nie jest uznawany za „ostatni dzień roboczy”.
- **Zasilanie:** job co godzinę dociąga dni po najnowszym zapisanym (pierwsze uruchomienie:
  ostatnie ~3 miesiące), upsert jest idempotentny. API NBP: maks. 93 dni na zapytanie (kod
  tnie po 90), 404 = brak tabeli w zakresie, 400 gdy zakres kończy się w przyszłości.
- **Zapisany zakres jest ciągły** (od najstarszego do najnowszego dnia nie ma dziur poza
  dniami bez tabeli). Dlatego dociąganie wstecz na żądanie (`getRate` dla daty starszej niż
  zapisane) zawsze sięga aż do najstarszego zapisanego dnia — nie rób z tego „okienka”, bo
  późniejszy odczyt zwróci nieaktualny kurs. Jedno żądanie dociąga najwyżej ok. 3 lata.
- **Raporty sprzedaży** (`crmSalesMetricsService.loadExchangeRates`, używane przez ekran
  mobilny i `GET /api/crm/leads/report`): najnowszy kurs NBP dla EUR/USD/GBP/CHF, stałe
  4.25/3.90/4.90/4.20 tylko gdy tabela kursów jest pusta — takie same dla każdego tenanta.
  Dawne ustawienia tenanta `exchange_rate_eur|usd|gbp|chf` w `app_settings` **nie są już
  czytane**, a migracja 0318 usuwa je wszystkim tenantom (także `crmtree-gold`, z którego
  nowe tenanty kopiują ustawienia). Nie przywracaj ręcznego kursu per tenant bez pytania —
  decyzja Adama z 2026-10-05.
- Testy nie wołają prawdziwego NBP (`fetch` jest podmieniany). Dane testowe kursów leżą
  w roku 1999 — sprzed archiwum NBP (2002) — żeby nie kolidować z prawdziwymi kursami
  w globalnej tabeli. Testy: `exchange-rates.test.js`, `exchangeRateNbpClient.test.js`.

---

## Wielojęzyczność (i18n)

Aplikacja jest tłumaczona na 10 języków (`pl, en, de, it, es, fr, ro, ru, sl, hr`), polski jest
źródłowy. Zasady i słowniczek: `crmtree-frontend/docs/i18n.md`.

- Lista języków: `src/config/locales.js` (musi zgadzać się z migracją 0312 i frontendem).
- Język użytkownika: `users.locale` (NULL = domyślny tenanta), ustawiany przez
  `PUT /api/profile/locale`. Domyślny język tenanta: `tenants.default_locale`, ustawiany przez
  admina tenanta (`PUT /api/admin/settings/default-locale`). `/api/auth/me` zwraca oba.
- `resolveLocale()` wybiera język, w którym zwracamy się do danej osoby. Maile i przypomnienia
  idą w języku **odbiorcy**, faktura PDF w języku tenanta.

### Teksty backendu

- Pliki: `src/i18n/<zakres>/<język>.json`, zakres to pierwszy człon klucza. Zakresy: `emails`,
  `push`, `invoicePdf` (wizualizacja faktury KSeF — w języku domyślnym tenanta). Konwencje jak we frontendzie: zagnieżdżony JSON, klucze angielskie camelCase,
  parametry `{name}`, liczba mnoga w składni ICU.
- Helper: `src/utils/i18n.js` — `translate(locale, 'emails.taskAssigned.subject', { documentName })`,
  `formatDate(locale, value)`, `formatDateTime(locale, value)`, `formatDateOnly` (data bez godziny,
  niezależna od strefy serwera), `formatNumber` / `formatAmount`. Składnię ICU obsługuje
  `@messageformat/core`, skompilowane teksty są cache'owane.
- `translate` nigdy nie rzuca: nieobsługiwany lub pusty język → polski; brak klucza w danym języku
  (albo zepsute ICU) → tekst polski; brak klucza wszędzie → sam klucz.
- Daty w mailach wychodzą w strefie czasowej procesu serwera (bez wymuszonej strefy), tak jak przed
  tłumaczeniem. Angielski używa formatu `en-GB` (dzień przed miesiącem, zegar 24-godzinny).

### Jak dodać tekst

1. Dopisz klucz do `src/i18n/<zakres>/pl.json` i od razu do pozostałych 9 plików zakresu.
2. W kodzie: `translate(locale, '<zakres>.<klucz>', { parametr })`. W `src/utils/email.js` każda
   funkcja `send*` ma lokalne `const t = emailTexts(locale)` i woła `t('taskAssigned.subject', …)`.
3. Wartość z bazy (status, typ, powód) tłumacz dopiero przy wypisywaniu — mapy „wartość → klucz” są
   w `email.js` (`DOCUMENT_STATUSES`, `ACTIVITY_TYPE_KEYS`, …). Nieznana wartość wychodzi bez zmian.
4. `npm run i18n:check` (`scripts/i18n-check.js`) — komplet 10 plików, te same klucze i parametry co
   w polskim, poprawne ICU, format kanoniczny (`-- --fix` porządkuje format). To samo sprawdza test
   `src/__tests__/i18n-completeness.test.js`, więc niepełne tłumaczenie wywala zwykłe `npm test`.

### Język odbiorcy w kodzie

- Każda funkcja `send*` z `email.js` przyjmuje `locale`. Bez niego (albo z nieobsługiwanym) mail
  jest polski.
- Wywołujący podaje `resolveLocale({ userLocale, tenantDefaultLocale })` **odbiorcy**, nigdy osoby,
  która wywołała akcję. Zapytanie, które pobiera adres e-mail odbiorcy, pobiera przy okazji
  `u.locale AS user_locale` i `t.default_locale AS tenant_default_locale` (`JOIN tenants t`) —
  bez osobnego zapytania o język.
- Przypomnienie o aktywności bez przypisanej osoby idzie do twórcy, w języku twórcy
  (`crmReminderService.js`).
- Odbiorca spoza CRMtree (sam adres e-mail): język domyślny tenanta, gdy tenant jest znany, inaczej
  polski. Dziś każdy mail trafia do użytkownika CRMtree.

### Komunikaty API — tylko po angielsku (decyzja Adama, 2026-10-05)

Komunikaty zwracane przez API (`res.status(...).json({ error })`, komunikaty walidacji) **nie
są tłumaczone na 10 języków — piszemy je wyłącznie po angielsku.** Nie buduj dla nich katalogu
tłumaczeń. Nowe trasy (finanse projektu, KSeF, faktury w Dokumentach, kontrola terminów) są już
po angielsku; starsze moduły mają jeszcze ok. 840 polskich komunikatów w ponad 50 plikach.
Ich zamiana na angielskie to osobna, szeroka zmiana — uzgodnij termin z Adamem (inne sesje
pracują w tych samych plikach) i popraw razem z nią testy, które sprawdzają polskie brzmienie.
Frontend nie powinien pokazywać komunikatu API wprost tam, gdzie może dać własny, przetłumaczony.

### Co jest nadal po polsku

- Starsze komunikaty błędów API (patrz wyżej) i wpisy logów.
- Faktura rozliczeniowa PDF (`invoicePdfService.js`). Wizualizacja faktury KSeF jest tłumaczona.
- Treści zapisywane w bazie przez backend, np. tytuł i opis automatycznego zadania churn
  (`Churn: <partner> [Krytyczne]` w `crm-churn.js` i `jobs/daily-scores.js`) — trafiają do maila
  jako dane, w brzmieniu z bazy.

---

## Code quality standards

### Language
- **All code must be written in English**: variable names, function names, class names,
  constant names, and inline comments.
- API messages (errors and validation messages returned in responses) are written in English
  only — decision of 2026-10-05, see "Komunikaty API — tylko po angielsku". Older modules still
  return Polish messages; do not add new Polish ones.
- User-facing texts that ARE translated (e-mails, the KSeF invoice PDF) live in
  `src/i18n/<scope>/<lang>.json`, never as literals in code.

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
