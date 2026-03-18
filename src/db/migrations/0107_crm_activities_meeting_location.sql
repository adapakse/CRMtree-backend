-- Migration: 0107_crm_activities_meeting_location
-- Dodaje kolumnę location do tabel aktywności (dla spotkań)

ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS meeting_location TEXT;

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS meeting_location TEXT;
