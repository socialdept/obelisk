-- PDS deny-list (LAB-48): repos hosted on a matching PDS are never archived.
-- Patterns support `*` wildcards (e.g. https://*.pds.host).
CREATE TABLE blocked_pdses (
    id       bigserial   PRIMARY KEY,
    pattern  text        NOT NULL UNIQUE,
    note     text,
    added_at timestamptz NOT NULL DEFAULT now()
);

-- DID → PDS resolution cache. Tab events carry only the DID, so the PDS blocklist
-- resolves each DID's PDS (via the DID doc); this cache avoids re-resolving on a
-- TTL (identity.didPdsCacheTtlSeconds). `pds` NULL = a cached resolution failure.
CREATE TABLE did_pds (
    did         varchar(255) PRIMARY KEY,
    pds         text,
    resolved_at timestamptz  NOT NULL DEFAULT now()
);
