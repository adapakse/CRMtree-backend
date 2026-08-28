-- Dodaje pole call_analysis_nip do aktywności CRM tworzonych automatycznie
-- przez callAnalysisService (Follow-up telefoniczny).
-- Pole przechowuje NIP firmy z call_analysis_companies, co umożliwia
-- wyświetlenie kontekstu AI dla usera bez pełnego uprawnienia call_analysis.

ALTER TABLE crm_lead_activities
  ADD COLUMN IF NOT EXISTS call_analysis_nip VARCHAR(10);

ALTER TABLE crm_partner_activities
  ADD COLUMN IF NOT EXISTS call_analysis_nip VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_la_call_analysis_nip ON crm_lead_activities(call_analysis_nip) WHERE call_analysis_nip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pa_call_analysis_nip ON crm_partner_activities(call_analysis_nip) WHERE call_analysis_nip IS NOT NULL;
