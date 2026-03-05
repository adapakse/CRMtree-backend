-- Migration 005: Global application settings
-- Stores admin-configurable key/value pairs.
-- All values stored as text; the API layer casts them to the appropriate type.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,          -- human-readable name shown in admin UI
  description TEXT NOT NULL DEFAULT '',
  value_type  TEXT NOT NULL DEFAULT 'number' CHECK (value_type IN ('number','boolean','string')),
  category    TEXT NOT NULL DEFAULT 'general',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed default values
INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES
  -- ── Documents / Expiration ──────────────────────────────────────────────
  ('expiration_red_days',   '90',   'Expiration warning threshold (days)',
   'Documents expiring within this many days are shown in red on the Kanban board and document list.',
   'number', 'documents'),

  ('expiration_soon_days',  '30',   'Expiring soon threshold (days)',
   'Documents expiring within this many days are marked as "expiring soon" in badges and filters.',
   'number', 'documents'),

  -- ── Workflow / Kanban ───────────────────────────────────────────────────
  ('kanban_refresh_interval_sec', '0',  'Kanban auto-refresh interval (seconds)',
   'Interval in seconds for automatic Kanban board refresh. Set to 0 to disable auto-refresh.',
   'number', 'workflow'),

  -- ── Pagination ──────────────────────────────────────────────────────────
  ('default_page_size',     '50',   'Default page size',
   'Number of items per page in all list views (users, documents, audit log).',
   'number', 'general'),

  ('roles_preview_count',   '3',    'Roles preview count',
   'Maximum number of group roles displayed inline in the user list before "+N more" truncation.',
   'number', 'general')

ON CONFLICT (key) DO NOTHING;
