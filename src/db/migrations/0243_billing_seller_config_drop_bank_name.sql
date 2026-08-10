-- 0243_billing_seller_config_drop_bank_name.sql
-- Usuwa kolumnę bank_name z billing_seller_config.
--
-- Uzasadnienie:
--   Pole nigdy nie było renderowane na PDF faktury (invoicePdfService.js
--   pokazuje tylko seller_bank_account jako "Nr rachunku bankowego") ani
--   zamrażane na wierszu invoices — było wyłącznie w formularzu "Dane
--   sprzedawcy" w panelu admina. Aplikacja przestała je zapisywać/walidować
--   (routes/admin-billing.js, billing.component.ts, models.ts). Kolumna
--   bank_account_number pozostaje bez zmian.
--
-- BEZPIECZEŃSTWO:
--   IF EXISTS — bezpieczny przy wielokrotnym uruchomieniu.

ALTER TABLE billing_seller_config DROP COLUMN IF EXISTS bank_name;
