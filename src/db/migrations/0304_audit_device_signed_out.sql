-- 0304_audit_device_signed_out.sql
-- A user signing a phone out of CRMtree from "Moje ustawienia" (ADR 001 §4,
-- e.g. a lost company phone) is a security-relevant action worth auditing.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_signed_out';
