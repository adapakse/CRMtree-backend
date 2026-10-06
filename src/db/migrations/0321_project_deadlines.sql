-- 0321_project_deadlines.sql
-- Deadline control in the Projects module:
--   * optional start / end date of a project;
--   * the ORIGINAL end date of a task (first end date it ever had) and the
--     moment it entered a "done" status — both feed computed values
--     (slip, "completed late"); timeliness itself is never stored;
--   * a per-user switch for the automatic deadline e-mails of projects;
--   * a marker making the daily overdue summary go out once per person per day.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date   DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_date_order') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_date_order
      CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
  END IF;
END $$;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS original_end_date DATE,
  ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ;

COMMENT ON COLUMN project_tasks.original_end_date IS
  'The first end date the task ever had. Set once, never overwritten — not even when the end
   date is cleared. Only the end date is tracked, not the start date.';
COMMENT ON COLUMN project_tasks.completed_at IS
  'When the task entered a status of category "done"; NULL while it is not done. NULL on a done
   task means the moment could not be derived from history (then it is not "completed late").';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS project_deadline_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN users.project_deadline_notifications_enabled IS
  'Set by the user in "My settings". Off = none of the automatic project deadline e-mails
   (daily overdue summary, end date changed, project became delayed), in any project.';

CREATE TABLE IF NOT EXISTS project_deadline_digests (
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date  DATE        NOT NULL,
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, digest_date)
);

COMMENT ON TABLE project_deadline_digests IS
  'One row per person per (Europe/Warsaw) day the daily overdue summary was sent to — the
   reminder job ticks every few minutes and must not send it twice.';

-- The two statements between the markers are also run by
-- src/__tests__/project-deadlines.test.js; both only fill rows that are still empty.
-- >>> backfill

-- Original end date: the value the end date had before its first recorded
-- change (or the first value it was given, when the task started without one).
-- A task whose end date never changed keeps its current one.
WITH first_change AS (
  SELECT DISTINCT ON (a.metadata->>'task_id')
         a.metadata->>'task_id' AS task_id,
         COALESCE(a.before_state->>'end_date', a.after_state->>'end_date')::date AS original_end_date
  FROM audit_logs a
  WHERE a.action = 'project_task_updated'
    AND a.after_state ? 'end_date'
  ORDER BY a.metadata->>'task_id', a.created_at
)
UPDATE project_tasks t
SET original_end_date = COALESCE(
      (SELECT f.original_end_date FROM first_change f WHERE f.task_id = t.id::text),
      t.end_date)
WHERE t.original_end_date IS NULL;

-- Completion moment of tasks that are done now: the latest recorded move from
-- a not-done status (or creation) into a done one. Without such an entry the
-- column stays NULL.
WITH entered_done AS (
  SELECT DISTINCT ON (a.metadata->>'task_id')
         a.metadata->>'task_id' AS task_id, a.created_at AS completed_at
  FROM audit_logs a
  JOIN project_task_statuses after_status
    ON after_status.id::text = a.after_state->>'status_id' AND after_status.category = 'done'
  LEFT JOIN project_task_statuses before_status
    ON before_status.id::text = a.before_state->>'status_id'
  WHERE a.action IN ('project_task_created', 'project_task_updated')
    AND (before_status.id IS NULL OR before_status.category <> 'done')
  ORDER BY a.metadata->>'task_id', a.created_at DESC
)
UPDATE project_tasks t
SET completed_at = e.completed_at
FROM entered_done e, project_task_statuses s
WHERE e.task_id = t.id::text
  AND s.id = t.status_id AND s.category = 'done'
  AND t.completed_at IS NULL;

-- <<< backfill
