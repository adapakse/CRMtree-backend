-- 0157_cleanup_orphan_crm_partners.sql
-- Usuwa testowe rekordy crm_partners bez powiązania z DWH (dwh_partner_id IS NULL).
-- Najpierw czyści tabele zależne które nie mają ON DELETE CASCADE.

BEGIN;

DELETE FROM crm_onboarding_tasks
WHERE partner_id IN (SELECT id FROM crm_partners WHERE dwh_partner_id IS NULL);

DELETE FROM crm_partner_activities
WHERE partner_id IN (SELECT id FROM crm_partners WHERE dwh_partner_id IS NULL);

DELETE FROM crm_partner_documents
WHERE partner_id IN (SELECT id FROM crm_partners WHERE dwh_partner_id IS NULL);

DELETE FROM crm_partner_contacts
WHERE partner_id IN (SELECT id FROM crm_partners WHERE dwh_partner_id IS NULL);

DELETE FROM crm_email_attachments
WHERE partner_id IN (SELECT id FROM crm_partners WHERE dwh_partner_id IS NULL);

DELETE FROM crm_partners WHERE dwh_partner_id IS NULL;

COMMIT;
