-- DID deny-list (LAB-47): repos whose records Obelisk never archives. The
-- ingester skips their events at apply time; a mirror of watched_dids (allow list).
CREATE TABLE blocked_dids (
    id       bigserial   PRIMARY KEY,
    did      varchar(255) NOT NULL UNIQUE,
    note     text,
    added_at timestamptz NOT NULL DEFAULT now()
);
