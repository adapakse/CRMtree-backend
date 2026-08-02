-- 0212_backfill_mailbox_user_id.sql
-- 0208/0209/0210 added mailbox_user_id via plain ALTER TABLE ADD COLUMN, so
-- every email activity row written before those migrations ran was left with
-- mailbox_user_id = NULL. threadLeadHandler/threadPartnerHandler require it
-- to resolve whose mailbox to read the thread from, so those pre-existing
-- threads show up in the CRM's conversation list (which doesn't check the
-- column) but return an empty/unavailable history when expanded.
--
-- For outbound activity the invariant is already established elsewhere
-- (crm-gmail.js/crm-outlook.js/crm-zoho.js send handlers all insert
-- mailbox_user_id = created_by, "the sender is always the mailbox owner for
-- an outbound message") — this just applies that same rule retroactively.
-- Inbound rows (created_by IS NULL) aren't touched: there's no reliable way
-- to recover which mailbox received them after the fact.

UPDATE crm_lead_activities
   SET mailbox_user_id = created_by
 WHERE type = 'email'
   AND mailbox_user_id IS NULL
   AND created_by IS NOT NULL;

UPDATE crm_partner_activities
   SET mailbox_user_id = created_by
 WHERE type = 'email'
   AND mailbox_user_id IS NULL
   AND created_by IS NOT NULL;
