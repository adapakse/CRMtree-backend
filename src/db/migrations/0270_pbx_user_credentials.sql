-- Per-user PAT tokens for ip-pbx.eu SIP accounts.
-- SIP accounts and Direct Phone Numbers are provisioned automatically by ip-pbx.eu
-- when a user account is created there. We only store the Personal Access Token (PAT)
-- so the backend can call ip-pbx.eu /me/sip-credentials on behalf of each user.
-- direct_phone is cached from ip-pbx.eu /me at the time the PAT is saved.
--
-- No tenant_id column: user_id is already tenant-scoped via users.tenant_id, and
-- every query here filters by user_id (from req.user), so a redundant column would
-- add nothing. Tenant separation of the PBX itself happens on the provider's side
-- (each CRMtree tenant gets its own company/account in ip-pbx.eu).
CREATE TABLE IF NOT EXISTS user_pbx_credentials (
  user_id      UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pat_token    TEXT         NOT NULL,
  direct_phone VARCHAR(30),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
