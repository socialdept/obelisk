CREATE TABLE events (
    id         bigserial PRIMARY KEY,
    record_id  bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    did        varchar(255) NOT NULL,
    collection varchar(255) NOT NULL,
    rkey       varchar(255) NOT NULL,
    action     varchar(20) NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    rev        varchar(255),
    live       boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_collection_id_idx ON events (collection, id);
CREATE INDEX events_did_id_idx ON events (did, id);
