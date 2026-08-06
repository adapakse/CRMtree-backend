-- 0207_whatsapp_messages.sql
-- Real conversation model for WhatsApp — replaces logging outgoing sends into
-- crm_lead_activities/crm_partner_activities. One row per message (outgoing
-- now; incoming will be added by a later webhook step), so a lead/partner can
-- show an actual chronological conversation instead of a generic activity log.
--
-- lead_id/partner_id are both nullable and NOT constrained to "at least one
-- set": a future incoming message may not match any lead/partner phone and
-- must still be storable. Matching happens at the application layer, never
-- enforced here.

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          INTEGER     REFERENCES crm_leads(id) ON DELETE CASCADE,
  partner_id       UUID        REFERENCES crm_partners(id) ON DELETE CASCADE,
  direction        VARCHAR(10) NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  from_phone       TEXT        NOT NULL,
  to_phone         TEXT        NOT NULL,
  body             TEXT,
  meta_message_id  TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'sent',
  raw_payload      JSONB,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_tenant  ON whatsapp_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_lead    ON whatsapp_messages(lead_id)    WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_partner ON whatsapp_messages(partner_id) WHERE partner_id IS NOT NULL;

-- Guards against duplicate rows if a future webhook delivery is retried by
-- Meta (their delivery policy is at-least-once) — safe to add now even
-- though nothing writes meta_message_id for incoming yet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_meta_id
  ON whatsapp_messages(tenant_id, meta_message_id) WHERE meta_message_id IS NOT NULL;

COMMENT ON TABLE whatsapp_messages IS 'Per-tenant WhatsApp conversation log (outgoing now; incoming added in a later webhook step). Replaces the earlier crm_lead_activities/crm_partner_activities-based history.';
COMMENT ON COLUMN whatsapp_messages.meta_message_id IS 'Meta Cloud API message id — used for delivery/read status webhooks and to deduplicate retried webhook deliveries.';
COMMENT ON COLUMN whatsapp_messages.raw_payload IS 'Raw webhook payload for incoming messages/status updates — not populated for outgoing sends.';
