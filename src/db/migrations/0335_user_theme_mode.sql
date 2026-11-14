-- Migration 0335: motyw aplikacji (jasny / ciemny) zapisany na koncie użytkownika.
-- Wcześniej wybór był tylko w przeglądarce, więc na innym komputerze user
-- widział znowu jasny motyw. NULL = jeszcze nie wybrał (front zostaje przy
-- swojej kopii z przeglądarki, domyślnie jasny).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_mode TEXT
  CHECK (theme_mode IN ('light', 'dark'));
