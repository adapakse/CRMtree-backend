-- Rejestr połączeń telefonicznych z softphone PBX
-- Uzupełniany przez backend przy każdym zakończeniu/odrzuceniu połączenia
--
-- Celowo bez FK na lead_id / partner_id / group_id — tabele mogą nie istnieć
-- w środowiskach gdzie moduł CRM nie jest wdrożony; dane logowane jako miękkie ref.
CREATE TABLE IF NOT EXISTS pbx_call_log (
  id             SERIAL       PRIMARY KEY,
  -- Kierunek połączenia
  direction      VARCHAR(10)  NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- Status zakończenia:
  -- answered     = połączenie odebrane i zakończone
  -- missed       = przychodzące nieodebrane przez agenta
  -- not_answered = wychodzące nieodebrane przez klienta
  -- rejected     = odrzucone (kliknięto Odrzuć / klient zajęty 486)
  -- error        = błąd techniczny (ICE fail, SIP error)
  status         VARCHAR(20)  NOT NULL CHECK (status IN ('answered','missed','not_answered','rejected','error')),
  -- Numery
  caller_number  VARCHAR(50),
  callee_number  VARCHAR(50),
  -- NIP powiązanego Lead/Partner (znormalizowany — bez prefiksu PL/DE itp.)
  nip            VARCHAR(20),
  duration_sec   INTEGER      NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  -- Kontekst CRM — miękkie referencje (brak FK)
  user_id        UUID,
  lead_id        INTEGER,
  partner_id     INTEGER,
  group_id       UUID,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pbx_call_log_user       ON pbx_call_log(user_id);
CREATE INDEX IF NOT EXISTS idx_pbx_call_log_started_at ON pbx_call_log(started_at);
CREATE INDEX IF NOT EXISTS idx_pbx_call_log_nip        ON pbx_call_log(nip);
CREATE INDEX IF NOT EXISTS idx_pbx_call_log_dir_status ON pbx_call_log(direction, status);
