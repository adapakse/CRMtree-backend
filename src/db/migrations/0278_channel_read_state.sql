-- Wspólny/tenant-wide stan przeczytania per wiadomość dla SMS i WhatsApp,
-- analogicznie do crm_lead_activities.is_read dla maila (0145). Oba kanały są
-- widoczne tenant-wide (sms.js buildThreadResponse i crm-whatsapp.js history
-- czytają po tenant_id+lead_id/partner_id, nie po owner_user_id) — jedna
-- kolumna is_read wystarczy, bez osobnej tabeli read-receipt per user.
--
-- DEFAULT true (inaczej niż 0145, które defaultowało na false i wymagało
-- backfillu w 0146): domyślne true od razu oznacza istniejące wiadomości jako
-- przeczytane, żeby nie było fałszywego skoku "nieprzeczytanych" po migracji.
-- Kod aplikacji jawnie ustawia is_read=false tylko dla nowych przychodzących.
ALTER TABLE sms_messages      ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_sms_messages_unread_lead      ON sms_messages(lead_id)      WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_sms_messages_unread_partner   ON sms_messages(partner_id)   WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_unread_lead    ON whatsapp_messages(lead_id)    WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_unread_partner ON whatsapp_messages(partner_id) WHERE is_read = false;
