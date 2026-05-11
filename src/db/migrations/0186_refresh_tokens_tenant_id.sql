-- Migration: 0186_refresh_tokens_tenant_id
-- Dodaje tenant_id do refresh_tokens, backfilluje z users, wymusza NOT NULL.
-- Tokeny bez tenanta (użytkownik nie ma tenant_id po 0185) są usuwane —
-- przy kolejnym logowaniu zostaną wydane nowe z prawidłowym tenant_id.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Backfill: przenieś tenant_id z users
UPDATE refresh_tokens rt
SET    tenant_id = u.tenant_id
FROM   users u
WHERE  rt.user_id = u.id
  AND  rt.tenant_id IS NULL;

-- Usuń tokeny sierot (user bez tenanta — nie powinno istnieć po 0185)
DELETE FROM refresh_tokens WHERE tenant_id IS NULL;

-- NOT NULL enforcement
ALTER TABLE refresh_tokens
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant_id
  ON refresh_tokens(tenant_id);
