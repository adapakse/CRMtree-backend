-- Migration 004: add being_approved to doc_status enum
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'being_approved';
