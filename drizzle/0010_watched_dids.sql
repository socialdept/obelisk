-- Watched DIDs: the "who am I auditing" list that drives DID-scoped backfill
-- (getRepo snapshot) and forward capture. Purely additive; no lexicon
-- assumptions. `collections` NULL = the whole repo; an array scopes to those
-- NSIDs. `snapshot_at` stays NULL until getRepo backfill completes, and bounds
-- what "deleted" coverage means for this DID (see footprint response).
CREATE TABLE watched_dids (
    id          bigserial PRIMARY KEY,
    did         varchar(255) NOT NULL UNIQUE,
    note        text,
    collections jsonb,
    active      boolean NOT NULL DEFAULT true,
    snapshot_at timestamptz,
    added_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX watched_dids_active_idx ON watched_dids (active);
