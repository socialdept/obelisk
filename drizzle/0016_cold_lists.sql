-- Cold storage (LAB-68): archive fully, skip embeddings to save CPU/$.
-- A cold DID/PDS is still ingested, indexed, and keyword-searchable — it just
-- never gets vector-embedded, and can be excluded from search with a flag.

ALTER TABLE records ADD COLUMN cold boolean NOT NULL DEFAULT false;

-- Reconcile UPDATEs and the excludeCold search filter both key on cold rows;
-- a partial index keeps the (minority) cold set cheap to scan without bloating
-- the common warm-path writes.
CREATE INDEX records_cold_idx ON records (did) WHERE cold = true;

CREATE TABLE cold_dids (
  id bigserial PRIMARY KEY,
  did varchar(255) NOT NULL UNIQUE,
  note text,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cold_pdses (
  id bigserial PRIMARY KEY,
  pattern text NOT NULL UNIQUE,
  note text,
  added_at timestamptz NOT NULL DEFAULT now()
);
