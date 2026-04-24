-- 0156_lead_stage_onboarded.sql
-- Dodaje etap 'onboarded' do słownika etapów leada.
UPDATE app_settings
SET value = '["new","qualification","presentation","offer","negotiation","closed_won","closed_lost","onboarded"]'
WHERE key = 'lead_stages';
