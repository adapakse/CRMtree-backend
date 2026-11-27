-- 0343_project_task_end_time.sql
-- Optional hour of a project task. The due date stays a plain date and keeps
-- deciding whether the task is overdue; the hour only says when during that
-- day the task is due — in the calendar and for the reminder, which until
-- now always used 09:00.

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS end_time TIME;

COMMENT ON COLUMN project_tasks.end_time IS
  'Hour the task is due on end_date, in the company''s local time; NULL = no hour (shown at 09:00).';
