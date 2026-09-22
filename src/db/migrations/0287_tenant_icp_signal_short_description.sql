-- Migration 0287: krótki, czytelny opis sygnału ICP (tooltip w Prospektach),
-- oddzielny od ai_definition (pełna, wieloparagrafowa instrukcja dla AI —
-- nienadająca się do pokazania w tooltipie) i od label (sama nazwa). Decyzja
-- 2026-09-22: tooltip w ekranie Prospekty ma być dynamiczny per tenant/config,
-- nie hardcoded w komponencie ani ucięty z ai_definition (te teksty są pisane
-- jako instrukcje dla modelu, nie jako zdania dla człowieka).

ALTER TABLE tenant_icp_signals
  ADD COLUMN IF NOT EXISTS short_description VARCHAR(500);

COMMENT ON COLUMN tenant_icp_signals.short_description IS
  'Krótki, czytelny opis "co oznacza TRUE" dla tego sygnału — pokazywany jako
   tooltip w Prospektach. Odrębny od ai_definition (pełna instrukcja dla AI,
   za długa na tooltip) i od label (sama nazwa sygnału). Opcjonalny —
   brak wartości = tooltip pokazuje tylko label.';
