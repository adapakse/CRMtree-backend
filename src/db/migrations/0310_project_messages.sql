-- 0310_project_messages.sql
-- Simple chat of the Projects module: one general thread per project
-- (task_id IS NULL) and one thread per task. Messages are append-only.

CREATE TABLE IF NOT EXISTS project_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     UUID        REFERENCES project_tasks(id) ON DELETE CASCADE,
  author_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_messages_thread
  ON project_messages(project_id, task_id, created_at);
