-- Migration: 0114_crm_sales_budgets
-- Planowane budżety sprzedażowe + kursy walut w app_settings

-- ── 1. Tabela planowanych budżetów handlowców ─────────────────────────────
CREATE TABLE IF NOT EXISTS crm_sales_budgets (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  period_type   TEXT    NOT NULL CHECK (period_type IN ('month', 'quarter')),
  period_number INTEGER NOT NULL,   -- 1-12 dla miesięcy, 1-4 dla kwartałów
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'PLN',
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, year, period_type, period_number)
);

CREATE INDEX IF NOT EXISTS idx_sales_budgets_user_year
  ON crm_sales_budgets (user_id, year);

-- ── 2. Kursy walut w app_settings ────────────────────────────────────────
INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES
  ('exchange_rate_eur', '4.25',
   'Kurs EUR / PLN',
   'Kurs przeliczenia EUR na PLN używany w kalkulacjach wartości leadów i raportach sprzedaży',
   'number', 'crm'),
  ('exchange_rate_usd', '3.90',
   'Kurs USD / PLN',
   'Kurs przeliczenia USD na PLN używany w kalkulacjach wartości leadów i raportach sprzedaży',
   'number', 'crm'),
  ('exchange_rate_gbp', '4.90',
   'Kurs GBP / PLN',
   'Kurs przeliczenia GBP na PLN używany w kalkulacjach wartości leadów i raportach sprzedaży',
   'number', 'crm'),
  ('exchange_rate_chf', '4.20',
   'Kurs CHF / PLN',
   'Kurs przeliczenia CHF na PLN używany w kalkulacjach wartości leadów i raportach sprzedaży',
   'number', 'crm')
ON CONFLICT (key) DO NOTHING;
