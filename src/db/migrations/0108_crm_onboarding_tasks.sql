-- Migration: 0108_crm_onboarding_tasks
-- Zadania wdrożeniowe przypisane do etapów onboardingu partnera

CREATE TABLE IF NOT EXISTS crm_onboarding_tasks (
  id           SERIAL PRIMARY KEY,
  partner_id   INTEGER NOT NULL REFERENCES crm_partners(id) ON DELETE CASCADE,
  step         INTEGER NOT NULL CHECK (step BETWEEN 0 AND 3),
    -- 0=Umowa podpisana, 1=Konfiguracja systemu, 2=Szkolenie użytkowników, 3=Gotowy
  title        TEXT NOT NULL,
  body         TEXT,
  type         TEXT NOT NULL DEFAULT 'task'
    CHECK (type IN ('task','call','email','meeting','note','doc_sent','training')),
  assigned_to  UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date     DATE,
  done         BOOLEAN NOT NULL DEFAULT false,
  done_at      TIMESTAMPTZ,
  done_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cot_partner_id ON crm_onboarding_tasks (partner_id);
CREATE INDEX IF NOT EXISTS idx_cot_step       ON crm_onboarding_tasks (partner_id, step);
