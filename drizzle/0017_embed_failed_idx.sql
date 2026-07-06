-- Partial index mirroring records_embed_pending_idx (0001), for the 'failed' count
-- in the health/metrics embed-queue gauge. Without it, the readyReport query fell
-- back to a full-heap scan on every /metrics + /readyz scrape — which the console
-- polls every ~15s, pegging CPU on a large archive. With both partial indexes the
-- pending/failed counts are index-only scans.
CREATE INDEX IF NOT EXISTS records_embed_failed_idx ON records (id) WHERE embed_status = 'failed';
