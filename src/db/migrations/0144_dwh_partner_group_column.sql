-- Migration 0144: Add partner_group column to dwh.dm_partner
-- This column exists in the production DB but was missing from migration 0141.
ALTER TABLE dwh.dm_partner ADD COLUMN IF NOT EXISTS partner_group VARCHAR(200);
