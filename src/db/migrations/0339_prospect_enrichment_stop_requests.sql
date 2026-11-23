-- A "stop enrichment" request for a tenant's running batch.
--
-- The batch state lives in the memory of the replica that runs it, and the
-- backend scales to more than one replica, so a stop request cannot be a
-- variable in memory: the click may land on a different replica than the batch.
-- Batch workers read this row before taking the next company.

CREATE TABLE IF NOT EXISTS prospect_enrichment_stop_requests (
  tenant_id    UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
