-- Granty widoczności CRM: "user X widzi rekordy CAŁEJ grupy Y", osobno dla
-- modułu leads (Prospekt) i partners (Partner). Port z worktrips-doc (tam
-- migracje 0259 + 0261; tutaj od razu wersja docelowa per-grupa, bez etapu
-- per-user), tu dodatkowo per-tenant.
--
-- Powód istnienia: żeby sales_manager zobaczył rekordy handlowców z INNEJ grupy,
-- jedynym mechanizmem było dopisanie go do tamtej grupy w user_group_roles —
-- w praktyce prowadziło to do tego, że każdy user należał do każdej grupy, co
-- unieważniało sens grup. Grant NIE dodaje grantee'a do user_group_roles —
-- widoczność i przynależność do grupy zostają dwoma osobnymi mechanizmami.
--
-- Grupa docelowa jest rozwijana do jej AKTUALNYCH członków dynamicznie przy
-- każdym requeście (JOIN w middleware, nie snapshot) — dodanie lub usunięcie
-- kogoś z tamtej grupy od razu zmienia zakres widoczności grantee'a.
--
-- Grant na WŁASNĄ grupę grantee'a jest dozwolony celowo: crm_role
-- 'salesperson' NIE widzi automatycznie rekordów innych członków swojej grupy
-- (widzi je tylko sales_manager), więc grant 'full' na własną grupę podnosi
-- widoczność handlowca do poziomu zespołu bez zmiany jego roli CRM.

CREATE TABLE IF NOT EXISTS crm_visibility_grants (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grantee_user_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_group_id  UUID         NOT NULL REFERENCES group_profiles(id) ON DELETE CASCADE,
  module           VARCHAR(20)  NOT NULL CHECK (module IN ('leads', 'partners')),
  access_level     access_level NOT NULL,
  granted_by       UUID         NOT NULL REFERENCES users(id),
  granted_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  note             TEXT,
  UNIQUE (grantee_user_id, target_group_id, module)
);

CREATE INDEX IF NOT EXISTS idx_crm_visibility_grants_grantee
  ON crm_visibility_grants (grantee_user_id, module);
CREATE INDEX IF NOT EXISTS idx_crm_visibility_grants_tenant
  ON crm_visibility_grants (tenant_id);
