# CRMtree Backend

## Projekt
Node.js/Express REST API — backend CRM dla biur podróży korporacyjnych.
Katalog: `C:\Users\Adam\Documents\crmtree-backend`

## Stack
- Node.js 20 + Express
- PostgreSQL (pg pool)
- JWT auth + SAML bypass w trybie dev (`NODE_ENV=development`)

## Uruchomienie lokalne
```bash
npm start   # port 3001
```
DB: PostgreSQL lokalny, baza `crmtree`, user `postgres`, hasło w `.env`

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
- Remote `origin` = bastion (backup)

## Deploy
Jenkins job: `crmtree-backend` — SCM polling z GitHub master co 5 min.
Azure Container App: `crmtree-backend.salmonsmoke-415d1384.polandcentral.azurecontainerapps.io`
Azure DB: `crmtree-db.postgres.database.azure.com`, baza `crmtreedb`, user `crmtreeadmin`

## Ważne
- Port aplikacji: 3000 (domyślny) lub z env `PORT`
- Azure ingress target port: 3000
- Azure PostgreSQL wymaga `Allow access from Azure services` w Networking
- DWH schema: tylko `dwh.partner` i `dwh.sales` (nie dm_partner/dm_sales)

## Projekty NIE mylić
- `worktrips-doc-backend` — osobna aplikacja worktrips
