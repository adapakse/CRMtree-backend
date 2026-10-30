CREATE TABLE IF NOT EXISTS entity_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES crm_partners(id) ON DELETE CASCADE,
  lead_activity_id INTEGER REFERENCES crm_lead_activities(id) ON DELETE CASCADE,
  partner_activity_id INTEGER REFERENCES crm_partner_activities(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  project_task_id UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
  filename VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size >= 0),
  blob_path TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(lead_id, partner_id, lead_activity_id, partner_activity_id, project_id, project_task_id) = 1)
);

CREATE INDEX IF NOT EXISTS idx_entity_attachments_tenant ON entity_attachments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_entity_attachments_lead ON entity_attachments(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attachments_partner ON entity_attachments(partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attachments_lead_activity ON entity_attachments(lead_activity_id) WHERE lead_activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attachments_partner_activity ON entity_attachments(partner_activity_id) WHERE partner_activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attachments_project ON entity_attachments(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attachments_project_task ON entity_attachments(project_task_id) WHERE project_task_id IS NOT NULL;
