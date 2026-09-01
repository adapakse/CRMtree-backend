-- Local SMS message log — mirrors whatsapp_messages (0230_whatsapp_user_level.sql),
-- but ip-pbx.eu has no webhook for incoming SMS, so this table is populated by a
-- user-initiated sync (opening the SMS tab / "Sprawdź nowe"), not push. Sync is
-- always entity-scoped (a specific lead or partner's known numbers), so lead_id/
-- partner_id is known directly at insert time — no phone-lookup step needed.
CREATE TABLE IF NOT EXISTS sms_messages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id           INTEGER     REFERENCES crm_leads(id) ON DELETE CASCADE,
  partner_id        UUID        REFERENCES crm_partners(id) ON DELETE CASCADE,
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_phone        TEXT        NOT NULL,
  to_phone          TEXT        NOT NULL,
  body              TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'sent',
  ip_pbx_message_id TEXT,
  created_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_tenant  ON sms_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_owner   ON sms_messages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_lead    ON sms_messages(lead_id)    WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_messages_partner ON sms_messages(partner_id) WHERE partner_id IS NOT NULL;

-- Dedup key for messages pulled from ip-pbx.eu during sync — NULL for messages
-- sent directly from the CRM (already known, inserted once, no dedup needed).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_ip_pbx_id
  ON sms_messages(owner_user_id, ip_pbx_message_id) WHERE ip_pbx_message_id IS NOT NULL;

COMMENT ON TABLE sms_messages IS 'Per-user SMS conversation log (ip-pbx.eu). Populated by manual sync (no webhook available) — lead_id/partner_id are always known directly since sync is entity-scoped.';
COMMENT ON COLUMN sms_messages.ip_pbx_message_id IS 'ip-pbx.eu message id — dedup key for pulled messages during "Sprawdź nowe" sync. NULL for messages sent from the CRM (already inserted once at send time).';
