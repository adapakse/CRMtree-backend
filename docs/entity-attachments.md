# Entity attachments

Requires migration `0333_entity_attachments.sql` and the matching frontend change.
Files use the existing private Azure Blob container. There is no public file URL.

## API

Base: `/api/entity-attachments/:type/:id`.
Types: `lead`, `partner`, `lead-activity`, `partner-activity`, `project`, `project-task`.
Partner IDs are CRM UUIDs, not DWH integer references.

- `GET /`: `{ items, total, page, page_size, can_write }`. Maximum page size: 50.
- `POST /`: multipart `file`, one file per request. The frontend queues multiple files.
- `GET /:attachmentId/download`: authenticated download, with the source checked again.
- `DELETE /:attachmentId`: removes the record and attempts blob cleanup.

For leads and partners, `aggregate=true` includes their activity files and visible linked
project/task files. Existing document attachments and mailbox attachments retain their
existing screens and APIs. Project visibility, external participant task assignments,
the Projects feature flag and tenant boundaries apply to aggregated results as well.

Filters: `filename`, `source`, `place`, `author`, `created_from`, `created_to`.
Sort keys: `filename`, `source`, `place`, `author`, `created_at`; `order=asc|desc`.
Default sorting groups files by source category and place.

Uploads accept the configured document MIME types plus common images, spreadsheets,
presentations, text/CSV and ZIP archives. The existing configured upload size limit applies.
Files are downloaded as attachments, never rendered as executable content.

CRM files follow CRM read/write scopes, substitutions and visibility grants. Activity
assignees can use their task files independently of access to the parent lead/partner.
Project files may be uploaded by PMs/admins or internal participants with full access;
task files follow content-edit permission. Closed projects remain readable.

Lead conversion copies activities and moves their attachment references in one transaction,
using an exact old/new activity ID mapping. Direct lead files move to the partner too.

## Verification

`src/__tests__/entity-attachments.test.js` uses a real PostgreSQL database with dedicated
test tenants and mocked blob storage. It covers upload/download/delete, aggregation,
filters, pagination, tenant/role/feature isolation, conversion, Unicode filenames and
cleanup after failed database writes. Run with the existing project integration suites.

Local verification also exercised the real HTTP upload/download/delete flow against
PostgreSQL and an isolated Azurite instance: downloaded bytes matched the uploaded file,
and deletion removed the blob physically. The production frontend build and translation
checks passed; the project and attachment integration suites passed 73 tests in total.

Manual UI checks:

1. Save a task or note on a lead and a partner; open its attachment section and add files.
2. Add files on a project and a project task, then link that project to the CRM record.
3. Open the CRM record's Attachments tab. Check source groups, filters and source links.
4. Download files and check access using a read-only member and an external participant.
5. Convert the lead; verify files on the partner and its copied activities.

Deployment order: backend migration/API, then frontend. Production deployment has not
been performed as part of this change.
