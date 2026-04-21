# Instrukcja konfiguracji integracji Gmail

---

## KROK 1 — Google Cloud Console (jednorazowo)

### 1.1 Utwórz projekt GCP (jeśli nie masz)
1. Wejdź na [console.cloud.google.com](https://console.cloud.google.com)
2. Utwórz nowy projekt (np. `worktrips-crm`) lub użyj istniejącego

### 1.2 Włącz Gmail API
1. **APIs & Services → Library → wyszukaj "Gmail API" → Enable**

### 1.3 Utwórz OAuth 2.0 credentials
1. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Dodaj **Authorized redirect URIs** — wpisz osobno dla każdego środowiska:
   ```
   https://htcd.worktrips.com/api/crm/gmail/oauth/callback     ← test
   https://app.worktrips.com/api/crm/gmail/oauth/callback       ← prod
   http://localhost:3000/api/crm/gmail/oauth/callback            ← lokalny dev
   ```
4. Kliknij **Create** → zapisz:
   - `Client ID` (np. `468428xxxx.apps.googleusercontent.com`)
   - `Client Secret` (np. `GOCSPX-xxxxx`)

> ⚠️ Obie wartości są **takie same** dla htcd i PROD — używasz jednego OAuth Clienta z wieloma redirect URI

### 1.4 OAuth Consent Screen
1. **APIs & Services → OAuth consent screen**
2. User type: **Internal** (jeśli masz Google Workspace) — wtedy nie trzeba weryfikacji  
   lub **External** + dodaj test users (adresy Twoich pracowników)
3. Scopes: dodaj `gmail.send`, `gmail.readonly`, `https://mail.google.com/`
4. Jeśli External — opublikuj aplikację lub dodaj adresy użytkowników do test users

---

## KROK 2 — Zmienne środowiskowe

### Na serwerze testowym (htcd) — plik `.env`:
```bash
GOOGLE_CLIENT_ID=468428xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
GOOGLE_REDIRECT_URI=https://htcd.worktrips.com/api/crm/gmail/oauth/callback
# GOOGLE_PUBSUB_TOPIC=  ← opcjonalne, patrz KROK 3
```

### Na PROD — plik `.env`:
```bash
GOOGLE_CLIENT_ID=468428xxxx.apps.googleusercontent.com      ← te same co test
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx                           ← te same co test
GOOGLE_REDIRECT_URI=https://app.worktrips.com/api/crm/gmail/oauth/callback
# GOOGLE_PUBSUB_TOPIC=  ← opcjonalne, patrz KROK 3
```

> `GOOGLE_CLIENT_ID` i `GOOGLE_CLIENT_SECRET` są identyczne dla obu środowisk — różni się tylko `GOOGLE_REDIRECT_URI`

---

## KROK 3 — Pub/Sub (opcjonalne, dla odbierania wiadomości w czasie rzeczywistym)

Bez Pub/Sub integracja **wysyła** emaile poprawnie. Odbieranie (auto-zapis przychodzących, powiadomienia) wymaga Pub/Sub.

### 3.1 Utwórz temat Pub/Sub w GCP
1. **Pub/Sub → Topics → Create Topic**
2. Topic ID: np. `gmail-incoming`
3. Pełna nazwa tematu: `projects/TWOJ-GCP-PROJECT/topics/gmail-incoming`

### 3.2 Ustaw uprawnienia dla Gmail
Gmail API musi mieć możliwość publishowania do tematu:
1. W Pub/Sub → Topic → **Permissions → Add Principal**
2. Principal: `gmail-api-push@system.gserviceaccount.com`
3. Role: **Pub/Sub Publisher**

### 3.3 Utwórz subskrypcję Push
1. **Pub/Sub → Subscriptions → Create Subscription**
2. Subscription ID: np. `gmail-push-sub`
3. Delivery type: **Push**
4. Endpoint URL:
   ```
   https://htcd.worktrips.com/api/crm/gmail/webhook/pubsub   ← test
   https://app.worktrips.com/api/crm/gmail/webhook/pubsub     ← prod
   ```
   > Każde środowisko potrzebuje **osobnej subskrypcji** (ale może używać tego samego tematu)

### 3.4 Dodaj do `.env`:
```bash
GOOGLE_PUBSUB_TOPIC=projects/TWOJ-GCP-PROJECT/topics/gmail-incoming
```

---

## KROK 4 — Migracje bazy danych

Na każdym środowisku uruchom migracje (jeśli jeszcze nie były uruchamiane):

```bash
npm run migrate
```

Kluczowe migracje dla Gmail:

| Plik | Tworzy |
|------|--------|
| `0118_gmail_calendar_integration.sql` | tabelę `user_gmail_tokens` |
| `0136_crm_lead_contacts.sql` | tabelę `crm_lead_contacts` |
| `0138_email_attachments.sql` | tabelę `crm_email_attachments` |
| `0140_crm_partner_contacts.sql` | tabelę `crm_partner_contacts` |

---

## KROK 5 — Weryfikacja

Po wdrożeniu sprawdź:

1. **Połącz Gmail** — zaloguj się jako użytkownik CRM → otwórz Lead/Partner → kliknij "Połącz Gmail" → przejdź autoryzację Google → powinno wrócić ze statusem "Połączono"

2. **Test wysyłki** — wyślij email z Leada, sprawdź czy dotrze

3. **Sprawdź logi** aplikacji — szukaj linii zaczynających się od `[Gmail]`

4. **Opcjonalnie rejestracja watch** (jeśli używasz Pub/Sub):
   ```
   POST /api/crm/gmail/webhook/register
   ```
   Wywołaj przez Postmana lub frontend po zalogowaniu użytkownika, którego skrzynkę chcesz obserwować.
