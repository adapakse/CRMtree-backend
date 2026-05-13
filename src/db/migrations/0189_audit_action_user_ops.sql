-- 0189_audit_action_user_ops.sql
-- Dodaje brakujące wartości enumeracji audit_action używane w routes/users.js.
-- user_password_set: logowane przy POST /api/admin/users/:id/set-password
-- user_deleted:      logowane przy DELETE /api/admin/users/:id
-- IF NOT EXISTS dostępne od PostgreSQL 9.3 — bezpieczne do ponownego uruchomienia.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'user_password_set';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'user_deleted';
