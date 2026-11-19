-- 0337_crm_email_campaigns.sql
-- E-mail campaigns via SendGrid (port from worktrips-doc, migrations 0268/0270/0271/0272).
-- Multi-tenant: every tenant uses ITS OWN SendGrid account (tenant_sendgrid_config),
-- every row carries tenant_id. Templates live in SendGrid (Dynamic Templates) — the
-- worktrips editor tables (crm_email_templates, crm_email_images) are not ported.
-- Idempotent.

-- ── Per-tenant SendGrid account ──────────────────────────────────────────────
-- api_key_encrypted: AES-256-GCM (src/utils/encrypt.js), never returned by the API.
-- webhook_token: random hex in the Event Webhook URL — identifies the tenant.
-- consent_key: which consent type (app_settings 'crm.consent_types') a person needs
-- to receive campaigns; NULL = resolved automatically (sendgridService.resolveConsent).
CREATE TABLE IF NOT EXISTS tenant_sendgrid_config (
  tenant_id           UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_encrypted   TEXT,
  api_key_hint        VARCHAR(8),
  from_email          VARCHAR(320),
  from_name           VARCHAR(200),
  reply_to            VARCHAR(320),
  asm_group_id        INTEGER,
  webhook_public_key  TEXT,
  webhook_token       VARCHAR(128) NOT NULL UNIQUE,
  consent_key         VARCHAR(100),
  updated_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Campaigns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_email_campaigns (
  id                          SERIAL       PRIMARY KEY,
  tenant_id                   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                        VARCHAR(200) NOT NULL,
  status                      VARCHAR(20)  NOT NULL DEFAULT 'draft',
  filter_criteria             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  min_days_between_sends      INTEGER      NOT NULL DEFAULT 30,
  exclude_recent_contact_days INTEGER,
  utm_campaign                VARCHAR(100),
  estimated_recipients        INTEGER,
  estimated_excluded          INTEGER,
  sendgrid_template_id        TEXT,
  sendgrid_template_name      TEXT,
  sendgrid_template_subject   TEXT,
  tested_version              TEXT,
  tested_at                   TIMESTAMPTZ,
  send_error                  TEXT,
  requested_by                UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_by                  UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_by                  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at                     TIMESTAMPTZ,
  archived_at                 TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_email_campaigns_status_check') THEN
    ALTER TABLE crm_email_campaigns ADD CONSTRAINT crm_email_campaigns_status_check
      CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_email_campaigns_tenant_list
  ON crm_email_campaigns (tenant_id, archived_at, status, updated_at DESC);

-- ── Recipients: one row per person (e-mail) in a sent campaign ─────────────
CREATE TABLE IF NOT EXISTS crm_campaign_recipients (
  id                  BIGSERIAL    PRIMARY KEY,
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id         INTEGER      NOT NULL REFERENCES crm_email_campaigns(id) ON DELETE CASCADE,
  entity_type         VARCHAR(10)  NOT NULL,
  partner_id          UUID         REFERENCES crm_partners(id) ON DELETE SET NULL,
  lead_id             INTEGER      REFERENCES crm_leads(id) ON DELETE SET NULL,
  email               VARCHAR(320) NOT NULL,
  company             TEXT,
  contact_name        TEXT,
  status              VARCHAR(30)  NOT NULL DEFAULT 'pending',
  exclusion_reason    VARCHAR(30),
  sendgrid_message_id VARCHAR(200),
  error               TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  opened_at           TIMESTAMPTZ,
  clicked_at          TIMESTAMPTZ,
  last_event_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_campaign_recipients_campaign ON crm_campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_campaign_recipients_email    ON crm_campaign_recipients (tenant_id, lower(email));

-- ── Events from the SendGrid Event Webhook ──────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_campaign_events (
  id           BIGSERIAL    PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_id BIGINT       REFERENCES crm_campaign_recipients(id) ON DELETE CASCADE,
  campaign_id  INTEGER      REFERENCES crm_email_campaigns(id) ON DELETE CASCADE,
  event        VARCHAR(40)  NOT NULL,
  url          TEXT,
  sg_event_id  VARCHAR(100),
  occurred_at  TIMESTAMPTZ  NOT NULL,
  payload      JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- SendGrid retries deliveries — the event id deduplicates them (per tenant account)
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_campaign_events_sg
  ON crm_campaign_events (tenant_id, sg_event_id) WHERE sg_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_campaign_events_campaign ON crm_campaign_events (campaign_id, event);

-- ── Person-level consents (by e-mail), replacing company-level ones for campaigns ──
-- Old company consents (crm_lead_consents / crm_partner_consents) stay untouched.
CREATE TABLE IF NOT EXISTS crm_contact_consents (
  id           BIGSERIAL    PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        VARCHAR(320) NOT NULL,            -- always lower(trim(...))
  consent_key  VARCHAR(100) NOT NULL,
  value        VARCHAR(10)  NOT NULL DEFAULT 'no_data' CHECK (value IN ('no_data', 'granted', 'denied')),
  source       VARCHAR(40),                      -- 'crm', 'sendgrid_unsubscribe', 'sendgrid_spam', 'migrated_company_consent'
  note         VARCHAR(500),
  updated_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email, consent_key)
);

COMMENT ON TABLE crm_contact_consents IS
  'Person-level consents (by e-mail, per tenant). E-mail campaigns send only to people whose campaign consent type is granted.';

-- Company consents → the entity's main e-mail. When the same address has
-- conflicting company consents, 'denied' wins (the safe side), then the newest.
INSERT INTO crm_contact_consents (tenant_id, email, consent_key, value, source, note, updated_by, updated_at)
SELECT DISTINCT ON (x.tenant_id, x.email, x.consent_key)
       x.tenant_id, x.email, x.consent_key, x.value, 'migrated_company_consent',
       'Przeniesiono ze zgody firmowej', x.updated_by, x.updated_at
FROM (
  SELECT lc.tenant_id, lower(trim(l.email)) AS email, lc.consent_key, lc.value, lc.updated_by, lc.updated_at
  FROM crm_lead_consents lc
  JOIN crm_leads l ON l.id = lc.lead_id AND l.tenant_id = lc.tenant_id
  WHERE lc.value IN ('granted', 'denied') AND NULLIF(trim(l.email), '') IS NOT NULL
  UNION ALL
  SELECT pc.tenant_id, lower(trim(p.email)), pc.consent_key, pc.value, pc.updated_by, pc.updated_at
  FROM crm_partner_consents pc
  JOIN crm_partners p ON p.id = pc.partner_id AND p.tenant_id = pc.tenant_id
  WHERE pc.value IN ('granted', 'denied') AND NULLIF(trim(p.email), '') IS NOT NULL
) x
ORDER BY x.tenant_id, x.email, x.consent_key, (x.value = 'denied') DESC, x.updated_at DESC
ON CONFLICT (tenant_id, email, consent_key) DO NOTHING;

-- ── Activities: campaign mails are logged as type 'marketing_email', provider 'sendgrid' ──
ALTER TABLE crm_lead_activities DROP CONSTRAINT IF EXISTS crm_lead_activities_email_provider_check;
ALTER TABLE crm_lead_activities ADD CONSTRAINT crm_lead_activities_email_provider_check
  CHECK (email_provider IN ('gmail', 'outlook', 'zoho', 'yandex', 'sendgrid'));
ALTER TABLE crm_partner_activities DROP CONSTRAINT IF EXISTS crm_partner_activities_email_provider_check;
ALTER TABLE crm_partner_activities ADD CONSTRAINT crm_partner_activities_email_provider_check
  CHECK (email_provider IN ('gmail', 'outlook', 'zoho', 'yandex', 'sendgrid'));

-- ── Module flag: off for every existing tenant (the frontend hides a module
-- without a row while requireFeature() allows it — an explicit row keeps both consistent)
INSERT INTO tenant_features (tenant_id, feature, is_enabled)
SELECT t.id, 'email_campaigns', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
