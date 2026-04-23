-- Przechowuje stan przeczytania na poziomie pojedynczej wiadomości Gmail.
-- Jeden wiersz = jedna wiadomość (gmail_message_id).
-- Brak wiersza dla danej wiadomości = nieprzeczytana (DEFAULT false przez INSERT).
CREATE TABLE IF NOT EXISTS crm_email_message_reads (
  gmail_message_id VARCHAR(200) NOT NULL,
  is_read          BOOLEAN      NOT NULL DEFAULT false,
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gmail_message_id)
);
