# worktrips.doc — Backend Service

Node.js / Express / PostgreSQL backend for the worktrips.doc Document Management System.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express 4 |
| Database | PostgreSQL 15 (Azure Database for PostgreSQL Flexible Server) |
| File Storage | Azure Blob Storage |
| Auth | SAML 2.0 (GCP Workspace) + JWT (access) + opaque refresh tokens |
| Email | Nodemailer / SendGrid |
| E-Signing | Signus API |
| Monitoring | Azure Application Insights |
| CI/CD | GitHub Actions → Azure App Service |

---

## Project Structure

```
src/
├── config/
│   ├── index.js          # All env vars with defaults
│   └── database.js       # pg Pool — query / transaction helpers
├── db/
│   ├── migrate.js        # Migration runner
│   ├── migrations/
│   │   └── 001_initial.sql   # Full schema: enums, tables, indexes, triggers
│   └── seeds/
│       └── 001_seed.sql      # Default groups
├── middleware/
│   ├── auth.js           # SAML strategy, JWT verify, requireAuth/Admin
│   ├── errorHandler.js   # Global error handler, validate(), auditContext
│   └── upload.js         # Multer (memory storage → Azure Blob)
├── routes/
│   ├── auth.js           # SAML SSO, /refresh, /logout, /me
│   ├── documents.js      # CRUD, search, upload, preview, download
│   ├── tags.js           # Tag CRUD (nested under documents)
│   ├── workflow.js       # Task assignment, completion, timeline
│   ├── signing.js        # Signus initiation + webhook
│   ├── users.js          # Admin: user CRUD, role assignment
│   ├── groups.js         # Group profile CRUD
│   ├── documentGroups.js # Document bundle CRUD
│   └── logs.js           # Admin: audit log query
├── services/
│   ├── permissionService.js  # RBAC engine (canRead/canFull/visibility filter)
│   ├── auditService.js       # Append-only log write + admin query
│   ├── storageService.js     # Azure Blob upload/download/SAS
│   ├── emailService.js       # Workflow & signing email notifications
│   └── signusService.js      # Signus API: initiate + webhook handler
├── utils/
│   └── logger.js         # Winston (JSON in prod, colorised in dev)
├── __tests__/
│   └── documents.test.js # Integration tests (supertest + real DB)
├── app.js                # Express app (no listen)
└── server.js             # HTTP server + graceful shutdown
```

---

## Quick Start (local)

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# edit .env — set at minimum: DB_*, JWT_SECRET

# 3. Create PostgreSQL database
createdb worktrips_doc

# 4. Run migrations
npm run migrate

# 5. Start dev server (nodemon)
npm run dev
```

---

## Environment Variables

See `.env.example` for the full list. Minimum required for development:

```
DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
JWT_SECRET   (min 64 chars)
```

For production (all required):
```
SAML_ENTRY_POINT, SAML_IDP_CERT, SAML_CALLBACK_URL
AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY, AZURE_STORAGE_CONTAINER
SIGNUS_API_KEY, SIGNUS_WEBHOOK_SECRET
SMTP_USER, SMTP_PASS
```

---

## API Reference

### Authentication

| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/saml` | Redirect to GCP Workspace SSO |
| POST | `/api/auth/saml/callback` | SAML assertion → JWT tokens |
| POST | `/api/auth/refresh` | Exchange refresh token |
| POST | `/api/auth/logout` | Revoke refresh token |
| GET | `/api/auth/me` | Current user + roles |

### Documents

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/documents` | read | List + search (visibility-filtered) |
| POST | `/api/documents` | full* | Create + optional file upload |
| GET | `/api/documents/:id` | read | Get full document detail |
| PATCH | `/api/documents/:id` | full | Update metadata / status |
| DELETE | `/api/documents/:id` | full | Soft delete |
| POST | `/api/documents/:id/file` | full | Upload new file version |
| GET | `/api/documents/:id/preview` | read | Stream PDF (proxied) |
| GET | `/api/documents/:id/download` | full | Download file |
| GET | `/api/documents/:id/versions/:vId/preview` | read | Version PDF preview |
| GET | `/api/documents/:id/versions/:vId/download` | full | Version download |

\* *full = must have `full` access level for at least one group*

### Tags

| Method | Path | Description |
|---|---|---|
| GET | `/api/documents/:id/tags` | List tags |
| POST | `/api/documents/:id/tags` | Add tag `{ key, value }` |
| PATCH | `/api/documents/:id/tags/:tagId` | Update tag value |
| DELETE | `/api/documents/:id/tags/:tagId` | Delete tag |

### Workflow

| Method | Path | Description |
|---|---|---|
| GET | `/api/documents/:id/workflow` | Task history (timeline) |
| POST | `/api/documents/:id/workflow` | Assign task + email notification |
| PATCH | `/api/documents/:id/workflow/:taskId` | Update task status |
| DELETE | `/api/documents/:id/workflow/:taskId` | Cancel task |
| GET | `/api/workflow/my-tasks` | Current user's pending tasks |

### E-Signing (Signus)

| Method | Path | Description |
|---|---|---|
| POST | `/api/documents/:id/sign/initiate` | Start signing envelope |
| POST | `/api/signing/webhook` | Signus webhook callback |

### Groups & Roles

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/groups` | all | List groups |
| GET | `/api/groups/:id` | all | Group detail with members |
| POST | `/api/groups` | admin | Create group |
| PATCH | `/api/groups/:id` | admin | Update group |
| DELETE | `/api/groups/:id` | admin | Deactivate group |
| POST | `/api/admin/users/:id/roles` | admin | Assign role to user |
| DELETE | `/api/admin/users/:id/roles/:roleId` | admin | Remove role |

### Document Groups (Bundles)

| Method | Path | Description |
|---|---|---|
| GET | `/api/document-groups` | List all bundles |
| GET | `/api/document-groups/:id` | Bundle detail |
| POST | `/api/document-groups` | Create bundle |
| PATCH | `/api/document-groups/:id` | Update bundle |
| POST | `/api/document-groups/:id/documents` | Add document to bundle |
| DELETE | `/api/document-groups/:id/documents/:docId` | Remove document |
| DELETE | `/api/document-groups/:id` | Delete bundle |

### Admin — Users

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | List all users |
| GET | `/api/admin/users/:id` | User detail |
| PATCH | `/api/admin/users/:id` | Update user (name / active / admin) |

### Admin — Audit Logs

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/logs` | Query logs with filters |
| GET | `/api/admin/logs/actions` | List all action types |

**Audit log query parameters:**
`date_from`, `date_to`, `user_id`, `user_email`, `document_id`, `document_name`, `action`, `search`, `page`, `limit`

---

## Permission Model

```
Admin            → full access to everything
Workflow task    → temporary read+edit access for task duration
Group role full  → CRUD within group (+ Sales owner restriction)
Group role read  → view / preview only within group
No role          → access denied (403)
```

**Sales (Sprzedaż) restriction:**
Users with `Sprzedaz-full` can only access documents where they are the `owner_id`.

---

## Audit Trail

Every user action writes an append-only entry to `audit_logs`:

- Document created / viewed / downloaded / deleted
- Metadata / tag / status changes (with before/after state)
- Workflow task created / completed / cancelled
- Signing initiated / completed
- User login / logout
- Role assigned / removed
- Group created / updated / deleted

The DB app user has `INSERT` only on `audit_logs` — no `UPDATE` or `DELETE`.

---

## Database Migrations

```bash
npm run migrate        # apply pending migrations
npm run seed           # apply seed data (default groups)
```

Migrations are idempotent — already applied files are skipped.

---

## Testing

```bash
npm test               # run all tests
npm run test:watch     # watch mode
```

Tests use a real PostgreSQL test database (`worktrips_doc_test`).
Set env vars or they default to `localhost:5432/worktrips_doc_test`.

---

## Azure Deployment

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `AZURE_WEBAPP_NAME` | App Service name |
| `AZURE_PUBLISH_PROFILE` | Downloaded from Azure portal |
| `AZURE_CREDENTIALS` | Service principal JSON |
| `AZURE_RESOURCE_GROUP` | Resource group name |

### App Service Configuration

Set all `.env.example` production variables as **Application Settings** in Azure Portal (or via Key Vault references).

Recommended App Service plan: **P1v3 Linux** (Node 20 LTS).
