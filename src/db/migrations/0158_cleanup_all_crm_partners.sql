-- 0158_cleanup_all_crm_partners.sql
-- Usuwa wszystkie pozostałe testowe rekordy crm_partners (w tym te z dwh_partner_id
-- ustawionym przez auto-link w migracji 0142). crm_partners jest teraz warstwą lazy.

BEGIN;

DELETE FROM crm_onboarding_tasks;
DELETE FROM crm_partner_activities;
DELETE FROM crm_partner_documents;
DELETE FROM crm_partner_contacts;
DELETE FROM crm_email_attachments WHERE partner_id IS NOT NULL;
DELETE FROM crm_partners;

COMMIT;
