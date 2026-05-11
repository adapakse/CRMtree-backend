-- ============================================================
-- Sprint 1 / M3 — Backfill: tenant CRMtree Gold + dane istniejące
-- 1. Tworzy tenant "crmtree-gold" (istniejący klient → tenant referencyjny).
-- 2. Ustawia is_super_admin na administratorze.
-- 3. Backfilluje tenant_id = crmtree-gold na WSZYSTKICH istniejących wierszach.
-- 4. Włącza wszystkie feature-flagi dla crmtree-gold.
-- 5. Kopiuje konfigurację SAML (auth_provider_type = saml).
-- 6. Konfiguruje tenant_email_providers (gmail).
--
-- CRM tabele z migracji 0100+ backfillowane przez EXECUTE (dynamiczny SQL)
-- — tabela może nie istnieć w bieżącym środowisku.
-- ============================================================

DO $$
DECLARE
  v_tenant_id  UUID;
  t            TEXT;
  -- Tabele CRM (0100+): backfillowane dynamicznie jeśli kolumna tenant_id istnieje
  crm_tables   TEXT[] := ARRAY[
    'crm_partner_groups',
    'crm_leads',
    'crm_lead_activities',
    'crm_lead_documents',
    'crm_lead_contacts',
    'crm_lead_test_accounts',
    'crm_partners',
    'crm_partner_activities',
    'crm_partner_documents',
    'crm_partner_contacts',
    'crm_onboarding_tasks',
    'crm_opportunities',
    'crm_transactions',
    'crm_transaction_products',
    'crm_sales_transactions',
    'crm_sales_budgets',
    'crm_import_logs',
    'crm_api_keys',
    'crm_email_attachments',
    'crm_email_message_reads',
    'user_gmail_tokens',
    'user_email_signatures'
  ];
BEGIN

  -- ── 1. Tenant CRMtree Gold ──────────────────────────────────────────────────
  INSERT INTO tenants (
    name,
    slug,
    email_domain,
    dwh_schema_prefix,
    is_active
  ) VALUES (
    'CRMtree Gold',
    'crmtree-gold',
    'worktrips.com',
    'crmtree_gold',
    true
  )
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'crmtree-gold';

  RAISE NOTICE 'Tenant crmtree-gold: %', v_tenant_id;

  -- ── 2. Super admin ──────────────────────────────────────────────────────────
  UPDATE users
  SET    is_super_admin = true
  WHERE  email = 'adam.manka@worktrips.com';

  -- ── 3. Backfill core tables (001-005 — zawsze obecne) ──────────────────────
  UPDATE users            SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE group_profiles   SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE user_group_roles SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;

  UPDATE document_groups      SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE documents            SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_versions    SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_tags        SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE document_attachments SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE attachment_versions  SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE workflow_tasks       SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE audit_logs           SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;

  UPDATE app_settings    SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;
  UPDATE doc_number_seq  SET tenant_id = v_tenant_id WHERE tenant_id IS NULL;

  -- ── 4. Backfill CRM tables (0100+) — EXECUTE bo tabela może nie istnieć ────
  FOREACH t IN ARRAY crm_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public'
        AND  table_name   = t
        AND  column_name  = 'tenant_id'
    ) THEN
      EXECUTE format(
        'UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL',
        t
      ) USING v_tenant_id;
      RAISE NOTICE 'Backfill tenant_id: %', t;
    ELSE
      RAISE NOTICE 'Pomijam (tabela lub kolumna nieobecna): %', t;
    END IF;
  END LOOP;

  RAISE NOTICE 'Backfill tenant_id zakończony';

  -- ── 5. Feature-flagi: wszystkie włączone dla crmtree-gold ──────────────────
  INSERT INTO tenant_features (tenant_id, feature, is_enabled) VALUES
    (v_tenant_id, 'documents',          true),
    (v_tenant_id, 'leads',              true),
    (v_tenant_id, 'sales_reports',      true),
    (v_tenant_id, 'onboarding',         true),
    (v_tenant_id, 'partner_registry',   true),
    (v_tenant_id, 'dwh_integration',    true),
    (v_tenant_id, 'performance',        true)
  ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;

  -- ── 6. Auth config — SAML (sekrety w Azure Key Vault, tu tylko referencje) ─
  INSERT INTO tenant_auth_configs (
    tenant_id,
    provider,
    is_enabled,
    saml_sp_entity_id
  ) VALUES (
    v_tenant_id,
    'saml',
    true,
    'https://crmtree-backend.salmonsmoke-415d1384.polandcentral.azurecontainerapps.io/saml/metadata'
  )
  ON CONFLICT (tenant_id, provider) DO NOTHING;

  -- Auth config — password (aktywny dla handlowców bez SSO)
  INSERT INTO tenant_auth_configs (tenant_id, provider, is_enabled)
  VALUES (v_tenant_id, 'password', true)
  ON CONFLICT (tenant_id, provider) DO NOTHING;

  -- ── 7. Email provider — Gmail ────────────────────────────────────────────────
  INSERT INTO tenant_email_providers (tenant_id, provider, is_active)
  VALUES (v_tenant_id, 'gmail', true)
  ON CONFLICT (tenant_id) DO NOTHING;

  RAISE NOTICE 'Backfill crmtree-gold zakończony pomyślnie';
END $$;
