-- 0128_doc_type_varchar.sql
-- Konwertuje kolumny doc_type i gdpr_type z enum na VARCHAR.
-- Pozwala na przechowywanie dowolnych wartości zarządzanych przez AppSettings
-- bez konieczności migracji przy każdym nowym typie dokumentu.
-- Istniejące dane są zachowane (enum::text daje oryginalną wartość).

-- ── doc_type ─────────────────────────────────────────────────────────────────
ALTER TABLE documents
  ALTER COLUMN doc_type TYPE VARCHAR(100) USING doc_type::text;

-- ── gdpr_type ────────────────────────────────────────────────────────────────
ALTER TABLE documents
  ALTER COLUMN gdpr_type TYPE VARCHAR(100) USING gdpr_type::text;

-- Typy enum doc_type i gdpr_type pozostają w bazie — mogą być używane
-- przez inne obiekty (constraints, funkcje). Kolumny documents już ich nie wymagają.

-- Komentarz
COMMENT ON COLUMN documents.doc_type  IS 'Typ dokumentu — wartość z AppSettings (doc_types), np. partner_agreement, Dostawca Content Hotel';
COMMENT ON COLUMN documents.gdpr_type IS 'Klasyfikacja GDPR — wartość z AppSettings (doc_gdpr_types)';
