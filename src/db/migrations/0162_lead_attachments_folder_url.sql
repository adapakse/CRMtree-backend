-- 0162_lead_attachments_folder_url.sql
-- URL do folderu z szablonami i materiałami do wysyłki na etapie Leada.
-- Wyświetlany jako link obok pola załączników w oknie compose e-mail Leada.

INSERT INTO app_settings (key, value, value_type, label, description, category)
VALUES (
  'lead_attachments_folder_url',
  '',
  'string',
  'Folder szablonów (Lead)',
  'URL do folderu z szablonami do wysyłki na etapie Leada (np. link do Google Drive). Wyświetlany jako skrót obok pola załączników w oknie compose e-mail.',
  'crm'
)
ON CONFLICT (key) DO NOTHING;
