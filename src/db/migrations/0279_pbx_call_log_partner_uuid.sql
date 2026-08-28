-- pbx_call_log.partner_id was INTEGER (migration 0263), but crm_partners.id
-- has been UUID since migration 0159 — every call ever logged with a partner
-- context silently saved partner_id=NULL, because the frontend cast the UUID
-- through Number() (→ NaN → serialized to JSON null) and the backend
-- validator only ever accepted an integer. Fixing both sides (pbx.service.ts,
-- pbx.js validation) requires the column to actually hold a UUID.
--
-- The only 3 existing non-null values (partner_id=90001) are stale manual
-- test data from early PBX dev testing — not a real partner id in any form
-- (not a UUID, not a dwh_partner_id) — safe to discard.
UPDATE pbx_call_log SET partner_id = NULL WHERE partner_id IS NOT NULL;

ALTER TABLE pbx_call_log ALTER COLUMN partner_id TYPE UUID USING NULL;
