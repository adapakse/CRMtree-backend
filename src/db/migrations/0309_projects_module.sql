-- 0309_projects_module.sql
-- Projects module: tenant dictionaries (task statuses / types / priorities),
-- status transition matrix per project role, tenant-defined custom fields,
-- projects with members, and tasks.
--
-- Default dictionary rows are NOT seeded here — projectConfigService seeds
-- them lazily the first time a tenant's configuration is read, which also
-- covers tenants created after this migration.

-- ── Users: contact data shown on the project card + project permissions ──
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS company             VARCHAR(200),
  ADD COLUMN IF NOT EXISTS department          VARCHAR(200),
  ADD COLUMN IF NOT EXISTS is_external         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_create_projects BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.is_external IS
  'External project participant: a regular, billable account that may only use the Projects module.';
COMMENT ON COLUMN users.can_create_projects IS
  'Granted by the tenant admin. The creator of a project becomes its PM.';

-- ── Feature flag row for every existing tenant ───────────────────────────
-- The frontend hides a module without a row while requireFeature() allows
-- it, so an explicit "off" row keeps both sides consistent.
INSERT INTO tenant_features (tenant_id, feature, is_enabled)
SELECT t.id, 'projects', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;

-- ── Dictionaries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_task_statuses (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(80)  NOT NULL,
  category    VARCHAR(20)  NOT NULL CHECK (category IN ('todo', 'in_progress', 'done')),
  color       VARCHAR(7)   NOT NULL DEFAULT '#6B7280',
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

COMMENT ON COLUMN project_task_statuses.category IS
  'Fixed meaning behind a tenant-named status — lets filters, the Gantt chart and progress
   figures tell finished work from open work regardless of the label.';

CREATE TABLE IF NOT EXISTS project_task_types (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(80)  NOT NULL,
  color       VARCHAR(7)   NOT NULL DEFAULT '#6B7280',
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS project_task_priorities (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(80)  NOT NULL,
  color       VARCHAR(7)   NOT NULL DEFAULT '#6B7280',
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ── Status transitions allowed per project role ──────────────────────────
-- The PM is not listed: a PM may always move a task between any statuses.
CREATE TABLE IF NOT EXISTS project_status_transitions (
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role            VARCHAR(30) NOT NULL
                  CHECK (role IN ('internal_participant', 'external_participant', 'controller')),
  from_status_id  UUID        NOT NULL REFERENCES project_task_statuses(id) ON DELETE CASCADE,
  to_status_id    UUID        NOT NULL REFERENCES project_task_statuses(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, role, from_status_id, to_status_id),
  CHECK (from_status_id <> to_status_id)
);

-- ── Tenant-defined custom fields ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_field_definitions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  field_type  VARCHAR(20)  NOT NULL CHECK (field_type IN ('text', 'number', 'list', 'date', 'money')),
  options     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

COMMENT ON COLUMN project_field_definitions.field_type IS
  'money = amount together with its currency, stored as {"amount": 12.5, "currency": "PLN"}.';
COMMENT ON COLUMN project_field_definitions.options IS
  'Allowed values of a "list" field as a JSON array of strings; empty for other types.';

-- ── Projects ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key               VARCHAR(10)  NOT NULL,
  name              VARCHAR(200) NOT NULL,
  description       TEXT,
  status            VARCHAR(10)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  partner_id        UUID         REFERENCES crm_partners(id) ON DELETE SET NULL,
  next_task_number  INT          NOT NULL DEFAULT 1,
  created_by        UUID         REFERENCES users(id) ON DELETE SET NULL,
  closed_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_status ON projects(tenant_id, status);

COMMENT ON COLUMN projects.key IS
  'Task number prefix (e.g. "WDR" in WDR-12), generated from the name when the project is
   created and never changed afterwards. Projects are closed, never deleted.';

CREATE TABLE IF NOT EXISTS project_members (
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role          VARCHAR(30) NOT NULL
                CHECK (role IN ('pm', 'internal_participant', 'external_participant', 'controller')),
  access_level  VARCHAR(10) NOT NULL CHECK (access_level IN ('full', 'read')),
  added_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Custom fields the PM added to a project; they appear on all of its tasks.
CREATE TABLE IF NOT EXISTS project_fields (
  project_id           UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_definition_id  UUID    NOT NULL REFERENCES project_field_definitions(id) ON DELETE CASCADE,
  tenant_id            UUID    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  is_required          BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order           INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, field_definition_id)
);

-- ── Tasks ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_tasks (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_number     INT          NOT NULL,
  name            VARCHAR(300) NOT NULL,
  description     TEXT,
  type_id         UUID         REFERENCES project_task_types(id),
  status_id       UUID         NOT NULL REFERENCES project_task_statuses(id),
  priority_id     UUID         REFERENCES project_task_priorities(id),
  start_date      DATE,
  end_date        DATE,
  parent_task_id  UUID         REFERENCES project_tasks(id) ON DELETE SET NULL,
  custom_values   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (project_id, task_number),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_parent  ON project_tasks(parent_task_id);

COMMENT ON COLUMN project_tasks.custom_values IS
  'Values of the project''s custom fields, keyed by project_field_definitions.id.';

CREATE TABLE IF NOT EXISTS project_task_assignees (
  task_id    UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_task_assignees_user ON project_task_assignees(user_id);
