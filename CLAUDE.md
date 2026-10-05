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

### Finanse projektu — etap 1 (decyzje Adama, 2026-10-05) — nie cofaj bez pytania

Controlling projektu, nie księgowość: **kwoty netto, bez VAT, jedna waluta na projekt**.
Faktury KSeF i typ dokumentu „Faktura” to kolejne etapy — jeszcze ich nie ma.

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

### Baza danych (migracje 0307–0311, finanse 0316–0317)

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

### Kluczowe pliki

- `src/routes/projects.js` — projekty, członkowie, pola, powiązanie z CRM, czat projektu,
  `GET /assigned-tasks` (musi być zarejestrowane przed `/:id`).
- `src/routes/project-tasks.js` — zadania, historia, czat zadania (`/api/projects/:id/tasks`).
- `src/routes/project-finance.js` — finanse projektu (`/api/projects/:id/finance`):
  podsumowanie, plan, pozycje kosztów i przychodów, planowany koszt zadania.
- `src/routes/admin-project-config.js` — konfiguracja admina tenanta, w tym przełącznik
  finansów i słownik `cost-categories`.
- `src/middleware/project-access.js` — `loadProject` (404 także dla nie-członka, żeby nie
  ujawniać id), `requireProjectManager`, `requireOpenProject`, a dla finansów
  `requireFinanceEnabled`, `loadFinanceAccess` i `requireFinance*` / `requireCost*`.
- `src/services/projectService.js`, `projectTaskService.js` (reguły uprawnień do zadań są
  opisane w nagłówku pliku), `projectConfigService.js`, `projectCrmLinkService.js`,
  `projectMessageService.js`, `projectFinanceService.js` (reguły uprawnień do finansów
  w nagłówku pliku), `projectFinanceCalculations.js`.
- `GET /api/crm/leads/:id/projects` i `/api/crm/partners/:id/projects` — w trasach CRM.
- Przypomnienia: trzeci blok w `src/services/crmReminderService.js`; maile
  `sendProjectTaskAssigned` (od razu przy przypisaniu) i `sendProjectTaskReminder`.
- Historia zadania: `audit_logs` z `metadata.task_id` (akcje `project_task_created` /
  `project_task_updated`).
- Testy: `src/__tests__/projects.test.js`, `project-tasks.test.js`,
  `projects-crm-integration.test.js`, `project-finance.test.js`,
  `projectFinanceCalculations.test.js` (bez bazy).

### Poza zakresem pierwszej wersji

Załączniki, aplikacja mobilna (kontrakt `mobile-v1.yaml` nie zawiera Projektów), zależności
między zadaniami, licznik nieprzeczytanych wiadomości, edycja i usuwanie wiadomości czatu.
W finansach: faktury KSeF, typ dokumentu „Faktura”, VAT, wiele walut w jednym projekcie.

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

- Pliki: `src/i18n/<zakres>/<język>.json`, zakres to pierwszy człon klucza. Na razie jest jeden
  zakres: `emails`. Konwencje jak we frontendzie: zagnieżdżony JSON, klucze angielskie camelCase,
  parametry `{name}`, liczba mnoga w składni ICU.
- Helper: `src/utils/i18n.js` — `translate(locale, 'emails.taskAssigned.subject', { documentName })`,
  `formatDate(locale, value)`, `formatDateTime(locale, value)`. Składnię ICU obsługuje
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

### Co jest nadal po polsku

- Komunikaty błędów API (`res.status(...).json({ error })`) i wpisy logów.
- Faktura PDF.
- Treści zapisywane w bazie przez backend, np. tytuł i opis automatycznego zadania churn
  (`Churn: <partner> [Krytyczne]` w `crm-churn.js` i `jobs/daily-scores.js`) — trafiają do maila
  jako dane, w brzmieniu z bazy.

---

## Code quality standards

### Language
- **All code must be written in English**: variable names, function names, class names,
  constant names, and inline comments.
- Polish is only acceptable in user-facing API error messages and log descriptions
  directed at end users.
- API messages are written in English (decision of 2026-10-05); older Polish messages are
  being converted separately.

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
