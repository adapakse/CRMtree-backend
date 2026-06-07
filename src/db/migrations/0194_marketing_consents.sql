-- 0194_marketing_consents.sql
-- Zgody marketingowe dla Lead i Partner.
-- Struktura wertykalna (EAV): jeden wiersz per (encja, rodzaj zgody).
-- Typy zgód zarządzane przez AppSettings (klucz crm.consent_types, format JSON), per tenant.

-- ── Tabela zgód dla Lead ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_lead_consents (
  id           SERIAL       PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      INTEGER      NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  consent_key  VARCHAR(100) NOT NULL,
  value        VARCHAR(20)  NOT NULL DEFAULT 'no_data'
               CHECK (value IN ('no_data', 'granted', 'denied')),
  updated_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (lead_id, consent_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_consents_lead      ON crm_lead_consents(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_consents_tenant    ON crm_lead_consents(tenant_id);

-- ── Tabela zgód dla Partner ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_partner_consents (
  id           SERIAL       PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  partner_id   UUID         NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  consent_key  VARCHAR(100) NOT NULL,
  value        VARCHAR(20)  NOT NULL DEFAULT 'no_data'
               CHECK (value IN ('no_data', 'granted', 'denied')),
  updated_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (partner_id, consent_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_partner_consents_partner ON crm_partner_consents(partner_id);
CREATE INDEX IF NOT EXISTS idx_crm_partner_consents_tenant  ON crm_partner_consents(tenant_id);

-- ── Definicje typów zgód w AppSettings (per tenant) ──────────────────────────
INSERT INTO app_settings (tenant_id, key, value, label, description, value_type, category)
SELECT
  t.id,
  'crm.consent_types',
  '[
    {
      "key": "marketing_comm",
      "label": "Zgoda na przetwarzanie danych w celu komunikacji marketingowej",
      "description": "Zgoda na przetwarzanie danych osobowych kontaktu w celu przesyłania materiałów marketingowych, ofert oraz informacji o produktach i usługach drogą elektroniczną i telefoniczną, zgodnie z art. 6 ust. 1 lit. a RODO."
    },
    {
      "key": "classification_targeting",
      "label": "Zgoda na przetwarzanie w celu klasyfikacji oraz targetowania",
      "description": "Zgoda na profilowanie, klasyfikację oraz targetowanie na podstawie danych o aktywności i zachowaniach zakupowych partnera, w celu personalizacji ofert handlowych i działań sprzedażowych, zgodnie z art. 6 ust. 1 lit. a RODO."
    }
  ]',
  'CRM – Typy zgód marketingowych',
  'JSON array definiujący rodzaje zgód marketingowych prezentowanych na kartach Lead i Partner. Format: [{key, label, description}].',
  'string',
  'global'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ── Seed: inicjalne rekordy "brak danych" dla istniejących leadów ─────────────
INSERT INTO crm_lead_consents (tenant_id, lead_id, consent_key, value)
SELECT l.tenant_id, l.id, ct.consent_key, 'no_data'
FROM crm_leads l
CROSS JOIN (VALUES ('marketing_comm'), ('classification_targeting')) AS ct(consent_key)
ON CONFLICT (lead_id, consent_key) DO NOTHING;

-- ── Seed: inicjalne rekordy "brak danych" dla istniejących partnerów ──────────
INSERT INTO crm_partner_consents (tenant_id, partner_id, consent_key, value)
SELECT p.tenant_id, p.id, ct.consent_key, 'no_data'
FROM crm_partners p
CROSS JOIN (VALUES ('marketing_comm'), ('classification_targeting')) AS ct(consent_key)
ON CONFLICT (partner_id, consent_key) DO NOTHING;
