-- 0167_user_email_signatures.sql
-- Stopki email: tabela per-user + globalne ustawienia admina (banner, klauzula)

CREATE TABLE IF NOT EXISTS user_email_signatures (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  html       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value, label, description, value_type, category)
VALUES
  ('email_signature_banner_url',
   '',
   'Stopka email – URL bannera',
   'URL obrazka bannera wyświetlanego poniżej sekcji personalnej w stopce maila (szerokość 600px)',
   'string',
   'general'),
  ('email_signature_disclaimer',
   '',
   'Stopka email – klauzula poufności',
   'Tekst klauzuli poufności wyświetlany na dole stopki maila (szary, 8px). Obsługuje tagi HTML.',
   'string',
   'general')
ON CONFLICT (key) DO NOTHING;
