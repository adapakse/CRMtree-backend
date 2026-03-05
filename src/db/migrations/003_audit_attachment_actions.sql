-- Dodanie nowych akcji audit dla załączników
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'attachment_uploaded';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'attachment_version_uploaded';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'attachment_deleted';
