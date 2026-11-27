-- 0342_project_message_reads.sql
-- Read state of the Projects chat: how far each person has read each thread
-- (the general thread of a project has task_id NULL, a task thread names the
-- task). One marker per person and thread — a message is read by someone
-- whose marker is not older than the message. Unread badges and the "read"
-- ticks under own messages are both derived from it.

CREATE TABLE IF NOT EXISTS project_message_reads (
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       UUID        REFERENCES project_tasks(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_message_reads_project_thread
  ON project_message_reads(user_id, project_id) WHERE task_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_message_reads_task_thread
  ON project_message_reads(user_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_message_reads_thread
  ON project_message_reads(project_id, task_id);

-- Everything written before this feature counts as read: without it every
-- member would start with a badge full of old messages.
INSERT INTO project_message_reads (tenant_id, project_id, task_id, user_id, last_read_at)
SELECT thread.tenant_id, thread.project_id, thread.task_id, member.user_id, now()
FROM (SELECT DISTINCT tenant_id, project_id, task_id FROM project_messages) thread
JOIN project_members member ON member.project_id = thread.project_id
WHERE NOT EXISTS (
  SELECT 1 FROM project_message_reads existing
  WHERE existing.user_id = member.user_id
    AND existing.project_id = thread.project_id
    AND existing.task_id IS NOT DISTINCT FROM thread.task_id
);
