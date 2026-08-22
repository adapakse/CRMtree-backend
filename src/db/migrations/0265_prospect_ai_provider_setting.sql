-- Migration 0265: app setting — dostawca AI dla enrichmentu prospektów
-- ('deepseek' domyślnie, lub 'anthropic'). Kod ma fallback na 'deepseek'
-- gdy brak wiersza, więc to tylko dla widoczności/edytowalności w admin UI.
INSERT INTO app_settings (tenant_id, key, value, value_type, label, description, category)
SELECT t.id, 'prospect.ai_provider', 'deepseek', 'string',
       'Prospekty — dostawca AI dla enrichmentu',
       'Który dostawca AI analizuje zescrapowane dane firmy (KRS, WWW, LinkedIn, Facebook) i generuje Travel Potential Score. "deepseek" lub "anthropic".',
       'crm'
FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;
