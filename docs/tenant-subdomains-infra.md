# Subdomeny tenantów ({slug}.crmtree.pl) — infrastruktura

Ten dokument opisuje kroki DNS/Azure potrzebne, żeby `{slug}.crmtree.pl` faktycznie
docierało do aplikacji. Warstwa aplikacyjna (backend + frontend) jest już gotowa i nie
zależy od kolejności wykonania tych kroków — może czekać w kodzie, zanim DNS/cert zostaną
podpięte. Żaden z poniższych kroków nie został wykonany automatycznie — wymaga dostępu do
Azure/DNS tego projektu.

## Stan dziś

- `app.crmtree.pl` → frontend Container App (`crmtree-frontend`)
- `api.crmtree.pl` → backend Container App (`crmtree-backend`)
- Oba jako pojedyncze, ręcznie dopięte custom domains z managed certificate Azure
  (managed cert obsługuje tylko dokładny hostname, nie wildcard).

## Co się NIE zmienia

`api.crmtree.pl` zostaje bez zmian. Cały ruch z dowolnej subdomeny tenanta nadal trafia na
ten sam, jeden origin API — subdomeny są autoryzowane po stronie API przez CORS
(`src/utils/corsOrigin.js`), nie przez DNS. Nie trzeba zakładać `{slug}.api.crmtree.pl`.

## Krok 1 — Wildcard DNS

Dodać rekord wildcard w strefie DNS `crmtree.pl` wskazujący na ten sam target co dzisiejszy
`app.crmtree.pl` (sprawdzić u rejestratora, czy `app` jest dziś CNAME czy A — wildcard musi
być tego samego typu):

```
*.crmtree.pl.   CNAME   <ten sam target co app.crmtree.pl>
```

`app.crmtree.pl` i `api.crmtree.pl` jako istniejące, dokładne rekordy mają pierwszeństwo nad
wildcardem — nic się dla nich nie zmienia.

## Krok 2 — Certyfikat wildcard

Azure Container Apps **Managed Certificate nie wspiera wildcarda** — obsługuje tylko
dokładne hostname'y, więc nie da się nim pokryć `*.crmtree.pl` automatycznie. Potrzebny jest
certyfikat wildcard **przyniesiony własny** (kupiony u CA albo wygenerowany przez ACME
DNS-01, np. Let's Encrypt z `certbot --manual --preferred-challenges dns` lub automatyzacją
przez dostawcę DNS), wgrany do Container Apps Environment:

```bash
az containerapp env certificate upload \
  --name <container-apps-environment> \
  --resource-group rg-crmtree-prod \
  --certificate-file wildcard-crmtree-pl.pfx \
  --certificate-password <pfx-password>
```

Odnawianie jest zautomatyzowane — patrz „Odnawianie certyfikatów wildcard” niżej.

## Krok 3 — Bindowanie hostname'a

Podpięcie wildcard hostname do istniejącej Container App frontendu (ta sama appka co
`app.crmtree.pl` — jeden kontener obsługuje wszystkie tenanty, patrz `server.ts`, który już
ufa `x-forwarded-host` z ingressu Container Apps):

```bash
az containerapp hostname bind \
  --hostname "*.crmtree.pl" \
  --name crmtree-frontend \
  --resource-group rg-crmtree-prod \
  --environment <container-apps-environment> \
  --certificate <nazwa-wgranego-certyfikatu>
```

Jeśli `az containerapp hostname bind` nie przyjmie wildcarda bezpośrednio (bindowanie
per-hostname bywa ograniczone w starszych wersjach CLI/API), alternatywa to bindowanie
przez Azure Portal → Container App → Custom domains, które w niektórych regionach/warstwach
subskrypcji wspiera wildcard, gdy certyfikat wildcard jest już wgrany na poziomie
environment.

## Alternatywa: edge proxy zamiast wildcard cert w Container Apps

Zamiast zarządzać certyfikatem wildcard bezpośrednio w Container Apps, można postawić przed
nim Azure Front Door (albo inny edge/CDN) z TLS terminacją i zarządzanym certyfikatem
wildcard po stronie Front Door, przekazującym `Host` dalej do Container App bez zmian. Więcej
ruchomych części, ale odrywa cykl życia certyfikatu od Container Apps i ułatwia ewentualne
przyszłe rzeczy (np. WAF, cache statyków) — do rozważenia, nie wymagane do działania tej
funkcji.

## Weryfikacja po wykonaniu

```bash
curl -I https://acme-test.crmtree.pl   # 200/redirect z tego samego frontendu co app.crmtree.pl
```

Backend nie wymaga żadnej zmiany DNS/cert — działa już dziś, wystarczy że frontend zacznie
być osiągalny pod subdomeną.

## Odnawianie certyfikatów wildcard

Certyfikaty `*.crmtree.pl` (`crmtree-frontend`) i `*.int.crmtree.pl` (`crmtree-frontend-int`)
to Let's Encrypt (ważność 90 dni), wgrane do `crmtree-env` jako
`wildcard-crmtree-pl-YYYYMMDD` / `wildcard-int-crmtree-pl-YYYYMMDD`. DNS `crmtree.pl` jest
w Cloudflare.

Odnawia je workflow `.github/workflows/renew-wildcard-certs.yml`:

- co poniedziałek sprawdza datę ważności certyfikatu podpiętego do hostname w Azure,
- gdy zostało < 30 dni: certbot (DNS-01 przez API Cloudflare) → PFX → upload do
  `crmtree-env` → `hostname bind` → weryfikacja → usunięcie starych certyfikatów tej domeny,
- ręcznie: Actions → „Renew wildcard certificates” → Run workflow (`force` = odnów od razu).

Wymaga sekretu repo `CLOUDFLARE_API_TOKEN` (token „Edit zone DNS” dla strefy `crmtree.pl`)
oraz sekretów `AZURE_*` z `deploy.yml` (service principal musi mieć prawo zapisu do
`crmtree-env` i obu Container Apps). Harmonogram działa dopiero z gałęzi `master`.
Nieudany run → mail z GitHub Actions; wtedy odnowić ręcznie (te same kroki lokalnie,
certbot w Dockerze `certbot/dns-cloudflare`; na Windows pliki brać z `le/archive/`, bo
`le/live/` to symlinki).
