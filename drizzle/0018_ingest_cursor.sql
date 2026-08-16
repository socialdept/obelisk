-- Ingest position, one row per source. Tab does not use this: it redelivers
-- anything unacked, so the position lives in Tab. Jetstream has no ack channel,
-- so the driver resumes from the last committed seq instead. The row is written
-- inside the same transaction as the batch it describes, so the cursor can never
-- run ahead of applied data and a crash resumes from the last durable batch.
CREATE TABLE ingest_cursor (
    source     varchar(32)  PRIMARY KEY,
    cursor     bigint       NOT NULL,
    updated_at timestamptz  NOT NULL DEFAULT now()
);
