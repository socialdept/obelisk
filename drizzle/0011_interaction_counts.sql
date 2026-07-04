-- Rollup of inbound-link "interaction" counts, keyed by target_uri (LAB-39).
-- kind = "<source_collection>:<path>", e.g. "app.bsky.feed.like:subject.uri".
-- Maintained by the ingest path scoped to config ranking specs; counts only
-- links from LIVE (non-deleted) source records, matching how audiences/backlinks
-- treat soft-deleted sources.
CREATE TABLE interaction_counts (
    target_uri text        NOT NULL,
    kind       varchar(511) NOT NULL,
    count      bigint       NOT NULL DEFAULT 0,
    PRIMARY KEY (target_uri, kind)
);
