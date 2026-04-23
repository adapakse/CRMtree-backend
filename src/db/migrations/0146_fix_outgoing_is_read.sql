-- Outgoing emails (created_by IS NOT NULL) were inserted without is_read=true.
-- Fix historical records: outgoing emails are always "read" by definition.
UPDATE crm_lead_activities
  SET is_read = true
WHERE type = 'email'
  AND created_by IS NOT NULL
  AND is_read = false;

UPDATE crm_partner_activities
  SET is_read = true
WHERE type = 'email'
  AND created_by IS NOT NULL
  AND is_read = false;
