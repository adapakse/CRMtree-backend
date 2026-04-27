-- Dodaje gmail_thread_id do crm_email_message_reads, żeby licznik nieprzeczytanych
-- działał na poziomie wiadomości (nie wątku).
ALTER TABLE crm_email_message_reads
  ADD COLUMN IF NOT EXISTS gmail_thread_id VARCHAR(200);

CREATE INDEX IF NOT EXISTS crm_email_message_reads_thread_idx
  ON crm_email_message_reads (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
