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
